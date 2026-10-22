'use strict';

// Storage file list for administrators: paged, filterable, with View /
// Download links and "Delete selected".
//
// Delete rules (never automatic):
//   * vendor KYC / partner documents are skipped — they belong to those
//     records; remove them with "Download now & clean up", which keeps a
//     copy and marks the record;
//   * files still used by a campaign or schedule that has not finished are
//     skipped;
//   * every deletion is logged (who, when, which file) and announced to
//     all administrators.

const { supabase } = require('../database/supabaseClient');
const monitor = require('./storageMonitor');
const { filesInUse } = require('./storageArchive');

const LINK_SECONDS = 120;
const MAX_DELETE = 1000;
const PROTECTED_BUCKETS = ['kyc-documents'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIME_PREFIXES = { image: 'image/', pdf: 'application/pdf', spreadsheet: 'application/vnd.', other: null };

const { StorageError, dbError, requireDb } = monitor;

function readFileFilters(query = {}) {
    const page = Math.max(1, Math.min(10_000, Number.parseInt(query.page, 10) || 1));
    const pageSize = Math.max(1, Math.min(100, Number.parseInt(query.pageSize, 10) || 25));
    const minMb = Number(query.minMb);
    return {
        bucket: /^[a-z0-9][a-z0-9._-]{0,62}$/.test(String(query.bucket || '')) ? String(query.bucket) : null,
        mimePrefix: Object.prototype.hasOwnProperty.call(MIME_PREFIXES, query.type) ? MIME_PREFIXES[query.type] : null,
        minBytes: Number.isFinite(minMb) && minMb > 0 ? Math.round(minMb * 1024 * 1024) : null,
        search: String(query.q || '').replace(/[%_\\]/g, ' ').trim().slice(0, 80) || null,
        sort: ['size', 'newest', 'oldest'].includes(query.sort) ? query.sort : 'size',
        page,
        pageSize,
    };
}

async function listFiles(filters) {
    requireDb();
    const [{ data, error }, inUse] = await Promise.all([
        supabase.rpc('storage_monitor_files', {
            p_bucket: filters.bucket, p_mime_prefix: filters.mimePrefix, p_min_bytes: filters.minBytes,
            p_search: filters.search, p_sort: filters.sort, p_limit: filters.pageSize, p_offset: (filters.page - 1) * filters.pageSize,
        }),
        filesInUse(),
    ]);
    if (error) throw dbError(error, 'Could not list stored files.');
    const rows = data || [];
    return {
        files: rows.map((row) => ({
            id: row.object_id,
            bucket: row.bucket_id,
            name: row.name,
            sizeBytes: Number(row.size_bytes) || 0,
            mimeType: row.mime_type,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            protected: PROTECTED_BUCKETS.includes(row.bucket_id),
            inUse: inUse.has(`${row.bucket_id}/${row.name}`),
        })),
        total: Number(rows[0]?.total_count) || 0,
        page: filters.page,
        pageSize: filters.pageSize,
    };
}

/** Ids of every file matching the filters (for "select all"), at most MAX_DELETE. */
async function matchingIds(filters) {
    const ids = [];
    for (let page = 1; ids.length < MAX_DELETE; page++) {
        const { files } = await listFiles({ ...filters, page, pageSize: 100 });
        ids.push(...files.filter((file) => !file.protected && !file.inUse).map((file) => file.id));
        if (files.length < 100) break;
    }
    return ids.slice(0, MAX_DELETE);
}

async function findFile(bucket, name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(String(bucket || '')) || !name || String(name).length > 1024 || String(name).includes('..')) {
        throw new StorageError('File not found.', 404, 'STORAGE_FILE_NOT_FOUND');
    }
    requireDb();
    const { data, error } = await supabase.rpc('storage_monitor_files', {
        p_bucket: bucket, p_mime_prefix: null, p_min_bytes: null, p_search: name, p_sort: 'newest', p_limit: 200, p_offset: 0,
    });
    if (error) throw dbError(error, 'Could not look up the file.');
    if (!(data || []).some((row) => row.name === name)) throw new StorageError('File not found.', 404, 'STORAGE_FILE_NOT_FOUND');
}

/** Short-lived link: `download` = save the file; otherwise open it in the browser. */
async function fileUrl(bucket, name, { download = false } = {}) {
    await findFile(bucket, name);
    const { data, error } = await supabase.storage.from(bucket)
        .createSignedUrl(name, LINK_SECONDS, download ? { download: name.split('/').pop() } : undefined);
    if (error || !data?.signedUrl) throw new StorageError('Could not create a link to the file.', 502, 'STORAGE_LINK');
    return { url: data.signedUrl, expiresInSeconds: LINK_SECONDS };
}

/**
 * Delete files by object id. Returns { deleted, skipped, deletedBytes }.
 * `actor` = { id, email } of the signed-in administrator.
 */
async function deleteFiles(ids, actor) {
    requireDb();
    const unique = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
    if (!unique.length) throw new StorageError('Select at least one file.', 400, 'STORAGE_SELECT');
    if (unique.length > MAX_DELETE) throw new StorageError(`Delete at most ${MAX_DELETE} files at a time.`, 400, 'STORAGE_SELECT');
    if (unique.some((id) => !UUID.test(id))) throw new StorageError('The selection is not valid. Reload the page and try again.', 400, 'STORAGE_SELECT');

    const { data: rows, error } = await supabase.rpc('storage_monitor_object_state', { p_ids: unique });
    if (error) throw dbError(error, 'Could not check the selected files.');
    const found = new Map((rows || []).map((row) => [row.object_id, row]));
    const inUse = await filesInUse();
    const skipped = [];
    const byBucket = new Map();
    for (const id of unique) {
        const row = found.get(id);
        if (!row) { skipped.push({ id, path: null, reason: 'Already removed' }); continue; }
        const path = `${row.bucket_id}/${row.name}`;
        if (PROTECTED_BUCKETS.includes(row.bucket_id)) { skipped.push({ id, path, reason: 'Vendor KYC / partner document — use "Download now & clean up" so a copy is kept and the record is marked' }); continue; }
        if (inUse.has(path)) { skipped.push({ id, path, reason: 'Still used by a campaign or schedule that has not finished' }); continue; }
        if (!byBucket.has(row.bucket_id)) byBucket.set(row.bucket_id, []);
        byBucket.get(row.bucket_id).push(row);
    }

    const deleted = [];
    for (const [bucket, list] of byBucket) {
        for (let index = 0; index < list.length; index += 100) {
            const chunk = list.slice(index, index + 100);
            const { data, error: removeError } = await supabase.storage.from(bucket).remove(chunk.map((row) => row.name));
            const removed = new Set(removeError ? [] : (data || []).map((item) => item.name));
            for (const row of chunk) {
                if (removed.has(row.name)) deleted.push(row);
                else skipped.push({ id: row.object_id, path: `${bucket}/${row.name}`, reason: `Could not be removed${removeError ? `: ${String(removeError.message).slice(0, 120)}` : ''}` });
            }
        }
    }

    const deletedBytes = deleted.reduce((sum, row) => sum + (Number(row.size_bytes) || 0), 0);
    if (deleted.length) {
        const { error: logError } = await supabase.from('storage_deleted_files').insert(deleted.map((row) => ({
            deleted_at: new Date().toISOString(),
            deleted_by: UUID.test(String(actor?.id || '')) ? actor.id : null,
            deleted_by_email: actor?.email || null,
            bucket_id: row.bucket_id,
            object_name: row.name,
            size_bytes: Number(row.size_bytes) || 0,
        })));
        if (logError) console.error(`[storage] could not log deletions: ${logError.message}`);
        console.log(`[storage] ${deleted.length} file(s) deleted by ${actor?.email || actor?.id || 'unknown'}`);
        monitor.invalidate();
        const who = actor?.email || 'An administrator';
        await monitor.notify({
            kind: 'files_deleted',
            message: `${who} deleted ${deleted.length} file(s) (${monitor.formatBytes(deletedBytes)}) from storage without downloading them through "Download now".`,
            subject: `Storage: ${deleted.length} file(s) deleted by ${who}`,
        }).catch((notifyError) => console.error(`[storage] deletion notice failed: ${notifyError.message}`));
    }
    return {
        deleted: deleted.map((row) => ({ id: row.object_id, path: `${row.bucket_id}/${row.name}`, sizeBytes: Number(row.size_bytes) || 0 })),
        skipped,
        deletedBytes,
    };
}

async function recentDeletions(limit = 30) {
    requireDb();
    const { data, error } = await supabase.from('storage_deleted_files')
        .select('id, deleted_at, deleted_by_email, bucket_id, object_name, size_bytes')
        .order('deleted_at', { ascending: false }).limit(limit);
    if (error) throw dbError(error, 'Could not load deleted files.');
    return data || [];
}

module.exports = { PROTECTED_BUCKETS, MAX_DELETE, readFileFilters, listFiles, matchingIds, fileUrl, deleteFiles, recentDeletions };
