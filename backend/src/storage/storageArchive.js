'use strict';

// "Download now + clean up".
//
//   1. prepare   An administrator picks folders (and optionally "older
//                than N days"). We record exactly which files are in it.
//   2. download  One ZIP is streamed. Its exact size is known up front;
//                the server records the byte count and CRC-32 it sent.
//   3. verify    The browser reports the size and CRC-32 it received; they
//                must match, so a cut-off or damaged download never counts.
//   4. clean up  Only after verify AND the administrator confirming the ZIP
//                is saved. Exactly the files that were in the ZIP are
//                removed, and only if they have not changed since. Files
//                still used by a pending campaign or schedule stay.
//
// Vendor KYC / partner documents can be archived too: the record keeps the
// document entry with an `archived` note (date + ZIP name) instead of a
// file, so staff can see where it went.

const crypto = require('crypto');
const { supabase } = require('../database/supabaseClient');
const monitor = require('./storageMonitor');
const { zipLength, ZipWriter } = require('./zipStream');

const MAX_FILES = 5000;
const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB per ZIP: the browser holds it in memory to verify it
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_CAMPAIGN_DONE = ['completed', 'stopped', 'failed', 'cancelled'];
const SCHEDULE_DONE = ['completed', 'cancelled', 'failed'];

const { StorageError, dbError, requireDb } = monitor;

/** The signed-in person doing a step: { id, email }. */
function actorFields(prefix, actor) {
    return {
        [`${prefix}_by`]: UUID.test(String(actor?.id || '')) ? actor.id : null,
        [`${prefix}_by_email`]: actor?.email ? String(actor.email).slice(0, 254) : null,
    };
}

// ── Labels for folders ───────────────────────────────────────────────
async function kycNames(ids) {
    const valid = ids.filter((id) => UUID.test(id));
    if (!valid.length) return new Map();
    const { data } = await supabase.from('kyc_submissions').select('id, legal_name').in('id', valid);
    return new Map((data || []).map((row) => [row.id, row.legal_name]));
}

/** Top-level folders per bucket, with a readable label where we know one. */
async function listFolders() {
    requireDb();
    const { data, error } = await supabase.rpc('storage_monitor_folders');
    if (error) throw dbError(error, 'Could not list storage folders.');
    const rows = data || [];
    const names = await kycNames(rows.filter((row) => row.bucket_id === 'kyc-documents').map((row) => row.folder));
    return rows.map((row) => {
        let label = row.folder || '(files not in a folder)';
        if (row.bucket_id === 'kyc-documents' && row.folder === 'technicians') label = 'Partner registrations (Aadhaar)';
        else if (row.bucket_id === 'kyc-documents' && names.has(row.folder)) label = `Vendor KYC · ${names.get(row.folder)}`;
        return {
            bucket: row.bucket_id,
            folder: row.folder,
            label,
            files: Number(row.file_count) || 0,
            bytes: Number(row.total_bytes) || 0,
            oldest: row.oldest,
            newest: row.newest,
        };
    }).sort((a, b) => a.bucket.localeCompare(b.bucket) || b.bytes - a.bytes);
}

// ── Files still needed by the app ────────────────────────────────────
function storageKeyFromUrl(value) {
    try {
        const parts = new URL(String(value)).pathname.split('/').filter(Boolean);
        const index = parts.indexOf('object');
        if (index < 0 || parts.length <= index + 3) return null;
        return `${decodeURIComponent(parts[index + 2])}/${parts.slice(index + 3).map((part) => decodeURIComponent(part)).join('/')}`;
    } catch {
        return null;
    }
}

/** "bucket/path" of files used by campaigns or schedules that are not finished. */
async function filesInUse() {
    const keys = new Set();
    const { data: campaigns, error } = await supabase.from('campaigns').select('status, media_bucket, media_object_path, media_path')
        .not('status', 'in', `(${ACTIVE_CAMPAIGN_DONE.join(',')})`).limit(5000);
    if (error && !monitor.isMissingSchema(error)) throw dbError(error, 'Could not check which files campaigns still use.');
    for (const row of campaigns || []) {
        if (row.media_bucket && row.media_object_path) keys.add(`${row.media_bucket}/${row.media_object_path}`);
        const fromUrl = row.media_path && storageKeyFromUrl(row.media_path);
        if (fromUrl) keys.add(fromUrl);
    }
    const { data: schedules, error: scheduleError } = await supabase.from('campaign_schedules').select('status, file_path, media_path')
        .not('status', 'in', `(${SCHEDULE_DONE.join(',')})`).limit(5000);
    if (scheduleError && !monitor.isMissingSchema(scheduleError)) throw dbError(scheduleError, 'Could not check which files schedules still use.');
    for (const row of schedules || []) {
        for (const value of [row.file_path, row.media_path]) {
            const key = value && storageKeyFromUrl(value);
            if (key) keys.add(key);
        }
    }
    return keys;
}

// ── 1. Prepare ───────────────────────────────────────────────────────
function readSelection(body = {}) {
    const folders = Array.isArray(body.folders) ? body.folders : [];
    const unique = new Map();
    for (const item of folders) {
        const bucket = String(item?.bucket || '');
        const folder = String(item?.folder ?? '');
        if (!BUCKET_RE.test(bucket) || folder.length > 200 || folder.includes('/') || folder.includes('..')) {
            throw new StorageError('One of the selected folders is not valid. Reload the page and try again.', 400, 'ARCHIVE_SELECTION');
        }
        unique.set(`${bucket}/${folder}`, { bucket, folder });
    }
    if (!unique.size) throw new StorageError('Select at least one folder.', 400, 'ARCHIVE_SELECTION');
    if (unique.size > 500) throw new StorageError('Select at most 500 folders at a time.', 400, 'ARCHIVE_SELECTION');
    const days = body.olderThanDays === '' || body.olderThanDays == null ? null : Number(body.olderThanDays);
    if (days !== null && (!Number.isInteger(days) || days < 0 || days > 3650)) {
        throw new StorageError('"Older than" must be a whole number of days.', 400, 'ARCHIVE_SELECTION');
    }
    return { folders: [...unique.values()], olderThanDays: days };
}

function archiveName(now = new Date()) {
    const ist = new Date(now.getTime() + 5.5 * 3600_000).toISOString(); // India time for the name
    return `sudarshan-storage-${ist.slice(0, 10)}-${ist.slice(11, 16).replace(':', '')}.zip`;
}

async function createArchive(body, actor) {
    requireDb();
    const selection = readSelection(body);
    const olderThan = selection.olderThanDays ? new Date(Date.now() - selection.olderThanDays * 86400_000).toISOString() : null;
    const files = [];
    for (const { bucket, folder } of selection.folders) {
        const { data, error } = await supabase.rpc('storage_monitor_folder_files', { p_bucket: bucket, p_folder: folder, p_older_than: olderThan });
        if (error) throw dbError(error, 'Could not list the selected files.');
        files.push(...(data || []));
    }
    if (!files.length) throw new StorageError('The selected folders have no files (with this "older than" filter).', 400, 'ARCHIVE_EMPTY');
    const totalBytes = files.reduce((sum, file) => sum + (Number(file.size_bytes) || 0), 0);
    if (files.length > MAX_FILES || totalBytes > MAX_BYTES) {
        throw new StorageError(`That is ${files.length} files / ${monitor.formatBytes(totalBytes)}. One download can hold up to ${MAX_FILES} files and ${monitor.formatBytes(MAX_BYTES)}; select fewer folders or use "older than".`, 400, 'ARCHIVE_TOO_LARGE');
    }
    const id = crypto.randomUUID();
    const name = archiveName();
    const { error } = await supabase.from('storage_archives').insert({
        id, name, status: 'ready', selection, file_count: files.length, total_bytes: totalBytes,
        ...actorFields('created', actor), created_at: new Date().toISOString(),
    });
    if (error) throw dbError(error, 'Could not prepare the download.');
    for (let index = 0; index < files.length; index += 500) {
        const { error: filesError } = await supabase.from('storage_archive_files').insert(files.slice(index, index + 500).map((file) => ({
            archive_id: id, bucket_id: file.bucket_id, object_name: file.name, object_id: file.object_id, etag: file.etag,
            size_bytes: Number(file.size_bytes) || 0, mime_type: file.mime_type, updated_at: file.updated_at,
            zip_path: `${file.bucket_id}/${file.name}`, status: 'listed',
        })));
        if (filesError) {
            await supabase.from('storage_archives').delete().eq('id', id);
            throw dbError(filesError, 'Could not prepare the download.');
        }
    }
    return getArchive(id);
}

// ── Read ─────────────────────────────────────────────────────────────
async function loadArchive(id) {
    if (!UUID.test(String(id || ''))) throw new StorageError('Download not found.', 404, 'ARCHIVE_NOT_FOUND');
    requireDb();
    const { data, error } = await supabase.from('storage_archives').select('*').eq('id', id).maybeSingle();
    if (error) throw dbError(error, 'Could not load the download.');
    if (!data) throw new StorageError('Download not found.', 404, 'ARCHIVE_NOT_FOUND');
    return data;
}

async function archiveFiles(id) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from('storage_archive_files')
            .select('id, bucket_id, object_name, object_id, etag, size_bytes, mime_type, updated_at, zip_path, status, sent_md5, note')
            .eq('archive_id', id).order('id', { ascending: true }).range(from, from + 999);
        if (error) throw dbError(error, 'Could not load the download contents.');
        rows.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return rows;
}

function publicArchive(archive, files) {
    const count = (status) => files.filter((file) => file.status === status).length;
    return {
        id: archive.id,
        name: archive.name,
        status: archive.status,
        createdAt: archive.created_at,
        selection: archive.selection,
        fileCount: archive.file_count,
        totalBytes: Number(archive.total_bytes) || 0,
        zipBytes: archive.zip_bytes == null ? null : Number(archive.zip_bytes),
        downloadedAt: archive.downloaded_at,
        verifiedAt: archive.verified_at,
        cleanedAt: archive.cleaned_at,
        cleanedFiles: archive.cleaned_files,
        cleanedBytes: Number(archive.cleaned_bytes) || 0,
        keptFiles: archive.kept_files,
        note: archive.note,
        // Who did each step, so every administrator can see it.
        createdBy: archive.created_by_email || null,
        downloadedBy: archive.downloaded_by_email || null,
        downloadCount: archive.download_count || 0,
        verifiedBy: archive.verified_by_email || null,
        cleanedBy: archive.cleaned_by_email || null,
        counts: { listed: count('listed'), included: count('included'), missing: count('missing'), deleted: count('deleted'), kept: count('kept') },
        kept: files.filter((file) => file.status === 'kept').slice(0, 50).map((file) => ({ path: file.zip_path, note: file.note })),
    };
}

async function getArchive(id) {
    const archive = await loadArchive(id);
    const files = await archiveFiles(id);
    const inUse = archive.status === 'cleaned' ? new Set() : await filesInUse();
    const result = publicArchive(archive, files);
    result.inUseFiles = files.filter((file) => inUse.has(`${file.bucket_id}/${file.object_name}`)).length;
    return result;
}

async function listArchives() {
    requireDb();
    const { data, error } = await supabase.from('storage_archives')
        .select('id, name, status, created_at, file_count, total_bytes, zip_bytes, downloaded_at, verified_at, cleaned_at, cleaned_files, cleaned_bytes, kept_files, note, created_by_email, downloaded_by_email, download_count, verified_by_email, cleaned_by_email')
        .order('created_at', { ascending: false }).limit(20);
    if (error) throw dbError(error, 'Could not load downloads.');
    return (data || []).map((row) => publicArchive(row, []));
}

async function objectState(ids) {
    const state = new Map();
    for (let index = 0; index < ids.length; index += 500) {
        const { data, error } = await supabase.rpc('storage_monitor_object_state', { p_ids: ids.slice(index, index + 500) });
        if (error) throw dbError(error, 'Could not check the current files.');
        for (const row of data || []) state.set(row.object_id, row);
    }
    return state;
}

// ── 2. Download (stream) ─────────────────────────────────────────────
function manifestCsv(archive, files) {
    const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [['path_in_zip', 'storage_location', 'original_path', 'size_bytes', 'type', 'last_modified'].join(',')];
    for (const file of files) lines.push([file.zip_path, file.bucket_id, file.object_name, file.size_bytes, file.mime_type, file.updated_at].map(quote).join(','));
    return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

/**
 * Stream the ZIP to an Express response. Files that disappeared since
 * "prepare" are left out (status missing). The response is aborted —
 * never completed — if any file cannot be read, so a partial ZIP can
 * never verify.
 */
async function streamArchive(id, res, actor) {
    const archive = await loadArchive(id);
    if (['cleaned', 'cancelled'].includes(archive.status)) {
        throw new StorageError(archive.status === 'cleaned' ? 'These files were already removed from storage; your saved ZIP is the copy.' : 'This download was cancelled.', 410, 'ARCHIVE_GONE');
    }
    const files = (await archiveFiles(id)).filter((file) => file.status !== 'missing');
    const state = await objectState(files.map((file) => file.object_id).filter(Boolean));
    const present = [];
    const missing = [];
    for (const file of files) {
        const current = state.get(file.object_id);
        if (!current) missing.push(file);
        else present.push({ ...file, etag: current.etag, size_bytes: Number(current.size_bytes) || 0 });
    }
    if (missing.length) await supabase.from('storage_archive_files').update({ status: 'missing', note: 'No longer in storage' }).in('id', missing.map((file) => file.id));
    if (!present.length) throw new StorageError('None of these files are in storage any more.', 410, 'ARCHIVE_GONE');

    const manifest = manifestCsv(archive, present);
    const entries = [...present.map((file) => ({ name: file.zip_path, size: file.size_bytes })), { name: 'MANIFEST.csv', size: manifest.length }];
    const length = zipLength(entries);
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(length));
    res.setHeader('Content-Disposition', `attachment; filename="${archive.name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Archive-Files', String(present.length));

    let closed = false;
    res.on('close', () => { if (!res.writableFinished) closed = true; });
    const write = (buffer) => new Promise((resolve, reject) => {
        if (closed) return reject(new Error('The browser stopped the download.'));
        if (res.write(buffer)) return resolve();
        res.once('drain', resolve);
    });
    const zip = new ZipWriter(write);
    const sent = [];
    try {
        for (const file of present) {
            const { data, error } = await supabase.storage.from(file.bucket_id).download(file.object_name);
            if (error || !data) throw new Error(`Could not read ${file.zip_path} from storage.`);
            const buffer = Buffer.from(await data.arrayBuffer());
            if (buffer.length !== file.size_bytes) throw new Error(`${file.zip_path} changed while downloading.`);
            await zip.addFile(file.zip_path, buffer, file.updated_at);
            sent.push({ id: file.id, etag: file.etag, size_bytes: buffer.length, md5: crypto.createHash('md5').update(buffer).digest('hex') });
        }
        await zip.addFile('MANIFEST.csv', manifest, new Date());
        const result = await zip.finish();
        if (result.bytes !== length) throw new Error('ZIP size mismatch.');
        res.end();
        await supabase.from('storage_archives').update({
            status: 'downloaded',
            zip_bytes: result.bytes, zip_crc32: result.crc32, downloaded_at: new Date().toISOString(), verified_at: null, verified_by: null, verified_by_email: null,
            ...actorFields('downloaded', actor), download_count: (Number(archive.download_count) || 0) + 1,
        }).eq('id', id);
        for (const item of sent) {
            await supabase.from('storage_archive_files').update({ status: 'included', etag: item.etag, size_bytes: item.size_bytes, sent_md5: item.md5, note: null }).eq('id', item.id);
        }
        return result;
    } catch (error) {
        console.error(`[storage] archive ${archive.name} download stopped: ${error.message}`);
        res.destroy(); // never let a partial ZIP look complete
        return null;
    }
}

// ── 3. Verify ────────────────────────────────────────────────────────
async function verifyArchive(id, { bytes, crc32 } = {}, actor) {
    const archive = await loadArchive(id);
    if (archive.status !== 'downloaded' && archive.status !== 'verified') {
        throw new StorageError('Download the ZIP first.', 409, 'ARCHIVE_NOT_DOWNLOADED');
    }
    const ok = Number(bytes) === Number(archive.zip_bytes) && String(crc32 || '').toLowerCase().padStart(8, '0') === archive.zip_crc32;
    if (!ok) {
        throw new StorageError('The downloaded ZIP is incomplete or damaged (size or checksum differs). Nothing will be removed; download it again.', 409, 'ARCHIVE_MISMATCH');
    }
    await supabase.from('storage_archives').update({
        status: 'verified', verified_at: new Date().toISOString(), ...actorFields('verified', actor),
    }).eq('id', id);
    return getArchive(id);
}

// ── 4. Clean up ──────────────────────────────────────────────────────
/** Record that owns a stored document, if any: { table, id, docKey } */
async function recordFor(file) {
    if (file.bucket_id !== 'kyc-documents') return null;
    const parts = file.object_name.split('/');
    const [table, recordId] = parts[0] === 'technicians'
        ? ['technician_partner_registrations', parts[1]]
        : ['kyc_submissions', parts[0]];
    if (!UUID.test(String(recordId || ''))) return null;
    const { data } = await supabase.from(table).select('id, documents').eq('id', recordId).maybeSingle();
    if (!data) return null;
    const docKey = Object.keys(data.documents || {}).find((key) => data.documents[key]?.path === file.object_name);
    return docKey ? { table, id: recordId, docKey } : null;
}

async function setArchivedMark(record, mark) {
    const { data } = await supabase.from(record.table).select('documents').eq('id', record.id).maybeSingle();
    if (!data?.documents?.[record.docKey]) return;
    const documents = { ...data.documents, [record.docKey]: { ...data.documents[record.docKey] } };
    if (mark) documents[record.docKey].archived = mark;
    else delete documents[record.docKey].archived;
    await supabase.from(record.table).update({ documents }).eq('id', record.id);
}

async function cleanupArchive(id, { confirmSaved } = {}, actor) {
    const archive = await loadArchive(id);
    if (archive.status === 'cleaned') throw new StorageError('These files were already removed.', 409, 'ARCHIVE_DONE');
    if (archive.status !== 'verified') throw new StorageError('Download the ZIP and let it finish first; only a verified download can be cleaned up.', 409, 'ARCHIVE_NOT_VERIFIED');
    if (confirmSaved !== true) throw new StorageError('Confirm that the ZIP file is saved before cleaning up.', 400, 'ARCHIVE_CONFIRM');

    const holder = `${monitor.HOLDER}:${crypto.randomBytes(4).toString('hex')}`;
    if (!(await monitor.tryLock(`storage-archive-${id}`, 600, holder))) throw new StorageError('A clean-up of this download is already running.', 409, 'ARCHIVE_BUSY');
    try {
        const files = (await archiveFiles(id)).filter((file) => file.status === 'included');
        const inUse = await filesInUse();
        const state = await objectState(files.map((file) => file.object_id).filter(Boolean));
        const mark = { at: new Date().toISOString(), by: actor?.email || null, archive: archive.name, archive_id: archive.id };
        const keep = async (file, note) => {
            await supabase.from('storage_archive_files').update({ status: 'kept', note }).eq('id', file.id);
        };
        const toDelete = [];
        for (const file of files) {
            const current = state.get(file.object_id);
            if (!current) { await supabase.from('storage_archive_files').update({ status: 'missing', note: 'Already removed from storage' }).eq('id', file.id); continue; }
            if (inUse.has(`${file.bucket_id}/${file.object_name}`)) { await keep(file, 'Still used by a campaign or schedule that has not finished'); continue; }
            const sameVersion = current.etag === file.etag && Number(current.size_bytes) === Number(file.size_bytes);
            const plainMd5 = /^"?[0-9a-f]{32}"?$/i.test(String(current.etag || ''));
            if (!sameVersion || (plainMd5 && String(current.etag).replace(/"/g, '').toLowerCase() !== file.sent_md5)) {
                await keep(file, 'Changed after the download, so the ZIP does not hold the current version');
                continue;
            }
            toDelete.push(file);
        }

        // Mark KYC / partner records first, so a document never silently disappears.
        const records = new Map();
        for (const file of toDelete) {
            const record = await recordFor(file);
            if (record) {
                records.set(file.id, record);
                await setArchivedMark(record, mark);
            }
        }

        let deletedFiles = 0;
        let deletedBytes = 0;
        const byBucket = new Map();
        for (const file of toDelete) {
            if (!byBucket.has(file.bucket_id)) byBucket.set(file.bucket_id, []);
            byBucket.get(file.bucket_id).push(file);
        }
        for (const [bucket, list] of byBucket) {
            for (let index = 0; index < list.length; index += 100) {
                const chunk = list.slice(index, index + 100);
                const { data, error } = await supabase.storage.from(bucket).remove(chunk.map((file) => file.object_name));
                const removed = new Set(error ? [] : (data || []).map((item) => item.name));
                for (const file of chunk) {
                    if (removed.has(file.object_name)) {
                        deletedFiles++;
                        deletedBytes += Number(file.size_bytes) || 0;
                        await supabase.from('storage_archive_files').update({ status: 'deleted', note: null }).eq('id', file.id);
                    } else {
                        if (records.has(file.id)) await setArchivedMark(records.get(file.id), null);
                        await keep(file, `Could not be removed${error ? `: ${String(error.message).slice(0, 120)}` : ''}`);
                    }
                }
            }
        }

        const finalFiles = await archiveFiles(id);
        const kept = finalFiles.filter((file) => file.status === 'kept').length;
        await supabase.from('storage_archives').update({
            status: 'cleaned', cleaned_at: new Date().toISOString(), ...actorFields('cleaned', actor),
            cleaned_files: deletedFiles, cleaned_bytes: deletedBytes, kept_files: kept,
        }).eq('id', id);
        console.log(`[storage] clean-up of ${archive.name}: ${deletedFiles} file(s) removed, ${kept} kept`);
        monitor.invalidate();
        // Tell every administrator who removed what (in-app + email).
        const who = actor?.email || 'An administrator';
        await monitor.notify({
            kind: 'cleanup_done',
            message: `${who} downloaded ${archive.name} and removed ${deletedFiles} file(s) (${monitor.formatBytes(deletedBytes)}) from storage${kept ? `; ${kept} file(s) were kept` : ''}. The ZIP they saved is now the only copy of those files.`,
            subject: `Storage clean-up by ${who}: ${deletedFiles} file(s) removed`,
        }).catch((error) => console.error(`[storage] clean-up notice failed: ${error.message}`));
        return getArchive(id);
    } finally {
        await monitor.unlock(`storage-archive-${id}`, holder);
    }
}

async function cancelArchive(id) {
    const archive = await loadArchive(id);
    if (archive.status === 'cleaned') throw new StorageError('Already cleaned up; nothing to cancel.', 409, 'ARCHIVE_DONE');
    await supabase.from('storage_archives').update({ status: 'cancelled' }).eq('id', id);
    return { cancelled: true };
}

async function lastCleanup() {
    const { data } = await supabase.from('storage_archives').select('cleaned_at, cleaned_files, cleaned_bytes')
        .eq('status', 'cleaned').order('cleaned_at', { ascending: false }).limit(1);
    return data?.[0] || null;
}

module.exports = {
    MAX_FILES,
    MAX_BYTES,
    listFolders,
    filesInUse,
    storageKeyFromUrl,
    readSelection,
    createArchive,
    getArchive,
    listArchives,
    streamArchive,
    verifyArchive,
    cleanupArchive,
    cancelArchive,
    lastCleanup,
};
