// =============================================================
// Smoke test — storage monitoring, alerts and "Download now + clean up",
// plus the /api/storage routes. In-memory Supabase fake (tables + the
// migration's RPCs re-implemented in JS), fake Storage objects and a fake
// email sender. Never boots server.js, never sends email.
// =============================================================
process.env.SUPABASE_URL = 'https://storage-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.AUTH_DISABLED = '';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'b'.repeat(64);
process.env.STORAGE_CRON_SECRET = 'cron-secret-0123456789';
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM_EMAIL;

const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const JSZip = require('jszip');

const STAFF = 'aa11aa11-1111-4111-8111-111111111111';
const STAFF2 = 'dd44dd44-4444-4444-8444-444444444444';
const USER = 'bb22bb22-2222-4222-8222-222222222222';
const TOKENS = { 'token-staff': STAFF, 'token-staff2': STAFF2, 'token-user': USER };
const EMAILS = { [STAFF]: 'asha@sudarshan.test', [STAFF2]: 'ravi@sudarshan.test', [USER]: 'user@example.com' };
const MB = 1024 * 1024;
const GB = 1024 ** 3;
const KYC_ID = '11111111-2222-4333-8444-555555555555';
const TECH_ID = '66666666-7777-4888-8999-000000000000';

// ── Fake Storage objects ────────────────────────────────────────
const objects = [];
const md5 = (buffer) => crypto.createHash('md5').update(buffer).digest('hex');
function putObject(bucket, name, content, mimetype = 'application/pdf', { size = null, daysOld = 0 } = {}) {
    const buffer = Buffer.from(content);
    const existing = objects.find((o) => o.bucket_id === bucket && o.name === name);
    const when = new Date(Date.now() - daysOld * 86400_000).toISOString();
    const record = {
        id: existing?.id || crypto.randomUUID(), bucket_id: bucket, name, buffer,
        metadata: { size: size ?? buffer.length, mimetype, eTag: `"${md5(buffer)}"` },
        created_at: existing?.created_at || when, updated_at: when,
    };
    if (existing) Object.assign(existing, record); else objects.push(record);
    return record;
}
const folderOf = (name) => (name.includes('/') ? name.split('/')[0] : '');

// ── Fake Supabase (tables + RPCs from the migration) ────────────
const { createFakeSupabase, installFakeSupabase } = require('../../database/__tests__/fakeSupabase');
const locks = new Map();
const fake = createFakeSupabase({
    rpc: {
        is_kyc_staff: ({ p_user_id: id }) => ({ data: id === STAFF || id === STAFF2, error: null }),
        resolve_data_owner: ({ p_auth_user_id: auth }) => ({ data: auth, error: null }),
        storage_monitor_usage() {
            const groups = new Map();
            for (const o of objects) {
                const g = groups.get(o.bucket_id) || { bucket_id: o.bucket_id, file_count: 0, total_bytes: 0, last_change: null };
                g.file_count++; g.total_bytes += o.metadata.size;
                groups.set(o.bucket_id, g);
            }
            return { data: [...groups.values()], error: null };
        },
        storage_monitor_db_size: () => ({ data: 42 * MB, error: null }),
        storage_monitor_folders() {
            const groups = new Map();
            for (const o of objects) {
                const key = `${o.bucket_id}|${folderOf(o.name)}`;
                const g = groups.get(key) || { bucket_id: o.bucket_id, folder: folderOf(o.name), file_count: 0, total_bytes: 0, oldest: o.updated_at, newest: o.updated_at };
                g.file_count++; g.total_bytes += o.metadata.size;
                if (o.updated_at < g.oldest) g.oldest = o.updated_at;
                if (o.updated_at > g.newest) g.newest = o.updated_at;
                groups.set(key, g);
            }
            return { data: [...groups.values()], error: null };
        },
        storage_monitor_folder_files({ p_bucket: bucket, p_folder: folder, p_older_than: olderThan }) {
            return {
                data: objects.filter((o) => o.bucket_id === bucket && folderOf(o.name) === folder && (!olderThan || o.updated_at < olderThan))
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((o) => ({ object_id: o.id, bucket_id: o.bucket_id, name: o.name, size_bytes: o.metadata.size, mime_type: o.metadata.mimetype, etag: o.metadata.eTag, updated_at: o.updated_at })),
                error: null,
            };
        },
        storage_monitor_object_state({ p_ids: ids }) {
            return { data: objects.filter((o) => ids.includes(o.id)).map((o) => ({ object_id: o.id, bucket_id: o.bucket_id, name: o.name, size_bytes: o.metadata.size, etag: o.metadata.eTag })), error: null };
        },
        storage_monitor_files(p) {
            let rows = objects.filter((o) => (!p.p_bucket || o.bucket_id === p.p_bucket)
                && (!p.p_search || o.name.toLowerCase().includes(String(p.p_search).toLowerCase())));
            rows.sort((a, b) => (p.p_sort === 'size' ? b.metadata.size - a.metadata.size : b.updated_at.localeCompare(a.updated_at)));
            const total = rows.length;
            rows = rows.slice(p.p_offset, p.p_offset + p.p_limit);
            return { data: rows.map((o) => ({ object_id: o.id, bucket_id: o.bucket_id, name: o.name, size_bytes: o.metadata.size, mime_type: o.metadata.mimetype, created_at: o.created_at, updated_at: o.updated_at, total_count: total })), error: null };
        },
        storage_monitor_staff_emails: () => ({ data: [{ email: EMAILS[STAFF] }, { email: EMAILS[STAFF2] }], error: null }),
        storage_monitor_try_lock({ p_name: name, p_holder: holder, p_seconds: seconds }) {
            const current = locks.get(name);
            if (current && current.until > Date.now() && current.holder !== holder) return { data: false, error: null };
            locks.set(name, { holder, until: Date.now() + seconds * 1000 });
            return { data: true, error: null };
        },
        storage_monitor_unlock({ p_name: name, p_holder: holder }) {
            if (locks.get(name)?.holder === holder) locks.delete(name);
            return { data: null, error: null };
        },
    },
});
const store = fake.store;
Object.assign(store, {
    storage_settings: [{ id: 1, capacity_bytes: null, db_capacity_bytes: null, warn_early_pct: 70, warn_high_pct: 85, warn_critical_pct: 95, reminder_hours: 24, notify_all_staff: true, extra_recipient_emails: [], updated_at: new Date().toISOString(), updated_by: null }],
    storage_alert_state: [{ id: 1, level: 0, last_notified_at: null, last_percent: null }],
    storage_usage_snapshots: [], storage_notifications: [], storage_archives: [], storage_archive_files: [],
    campaigns: [], campaign_schedules: [],
    kyc_submissions: [], technician_partner_registrations: [],
});
const supabase = installFakeSupabase(fake);
let failDownloadOf = null;
supabase.storage = {
    async listBuckets() { return { data: [...new Set(objects.map((o) => o.bucket_id))].map((id) => ({ id, public: id !== 'kyc-documents' })), error: null }; },
    from(bucket) {
        return {
            async download(name) {
                if (failDownloadOf === name) return { data: null, error: { message: 'network' } };
                const o = objects.find((item) => item.bucket_id === bucket && item.name === name);
                return o ? { data: new Blob([o.buffer]), error: null } : { data: null, error: { message: 'not found' } };
            },
            async remove(names) {
                const removed = [];
                for (const name of names) {
                    const index = objects.findIndex((o) => o.bucket_id === bucket && o.name === name);
                    if (index >= 0) { removed.push({ name }); objects.splice(index, 1); }
                }
                return { data: removed, error: null };
            },
            async createSignedUrl(name, seconds) { return { data: { signedUrl: `https://signed.test/${bucket}/${name}?ttl=${seconds}` }, error: null }; },
            async createSignedUrls(paths, seconds) { return { data: paths.map((path) => ({ path, signedUrl: `https://signed.test/${bucket}/${path}?ttl=${seconds}` })), error: null }; },
        };
    },
};

// ── Fake email + auth ───────────────────────────────────────────
const monitor = require('../storageMonitor');
const emails = [];
monitor.setEmailSender(async (config, message) => { emails.push({ from: config.fromEmail, ...message }); });
const resendService = require('../../email/resendService');
let adminResend = { apiKey: '', fromEmail: '', fromName: '' };
resendService._getUserSettings = async () => adminResend;
const auth = require('../../middleware/auth');
auth.supabaseAdmin.auth.getClaims = async (token) => (TOKENS[token]
    ? { data: { claims: { sub: TOKENS[token], email: EMAILS[TOKENS[token]], role: 'authenticated' } }, error: null }
    : { data: null, error: { message: 'invalid JWT' } });

const archives = require('../storageArchive');
const jobs = require('../storageJobs');
const { crc32, zipLength } = require('../zipStream');
const { clearStaffCache, documentLinks } = require('../../kyc/kycService');

const notifications = () => store.storage_notifications;
const setCapacity = (bytes) => { store.storage_settings[0].capacity_bytes = bytes; monitor.invalidate(); };
function setUsage(bucket, name, bytes) { putObject(bucket, name, crypto.randomBytes(64), 'application/pdf', { size: bytes }); monitor.invalidate(); }

async function main() {
    const results = [];
    const check = async (label, fn) => {
        try { await fn(); results.push(`ok   ${label}`); } catch (error) { results.push(`FAIL ${label}`); console.log(results.join('\n')); throw error; }
    };

    // ── Monitoring + alerts ─────────────────────────────────────
    await check('usage = exact sum; no capacity → no percentage, no alerts', async () => {
        putObject('knowledge-documents', 'catalogue.pdf', crypto.randomBytes(1024));
        const usage = await monitor.measureUsage({ fresh: true });
        assert.equal(usage.usedBytes, 1024);
        assert.equal(usage.percentUsed, null, 'never invent a quota');
        const result = await monitor.evaluate();
        assert.equal(result.severity, 0);
        assert.equal(notifications().length, 0);
    });

    await check('settings validation (no backup settings any more)', async () => {
        const ok = monitor.validateSettings({ capacity_gb: '1', warn_early_pct: 70, warn_high_pct: 85, warn_critical_pct: 95, reminder_hours: 24, notify_all_staff: true, extra_recipient_emails: 'Owner@Sudarshan.test' });
        assert.deepEqual(ok.errors, {});
        assert.equal(ok.values.capacity_bytes, GB);
        assert.ok(!('backup_enabled' in ok.values) && !('excluded_buckets' in ok.values));
        const bad = monitor.validateSettings({ capacity_gb: '-1', warn_early_pct: 90, warn_high_pct: 85, warn_critical_pct: 95, reminder_hours: 9999, extra_recipient_emails: 'nope' });
        assert.ok(bad.errors.capacity_gb && bad.errors.warn_high_pct && bad.errors.reminder_hours && bad.errors.extra_recipient_emails);
    });

    await check('thresholds: alert once, no duplicates, jump sends only the highest, falling resets', async () => {
        setCapacity(10 * MB);
        setUsage('campaign-media', 'big-1.mp4', Math.round(7.2 * MB) - 1024);
        assert.equal((await monitor.evaluate()).severity, 1);
        assert.match(notifications()[0].message, /^Storage usage has reached 72%/);
        assert.equal(notifications()[0].email_status, 'not_configured', 'no sender → recorded truthfully');
        for (let index = 0; index < 3; index++) { monitor.invalidate(); await monitor.evaluate(); }
        assert.equal(notifications().length, 1, 'no duplicate on refresh');
        setUsage('campaign-media', 'big-2.mp4', Math.round(2.4 * MB));
        assert.equal((await monitor.evaluate()).severity, 3);
        assert.equal(notifications().length, 2);
        assert.match(notifications()[1].message, /^Critical storage warning: Only 4(\.\d)?% of storage remains/);
        objects.splice(objects.findIndex((o) => o.name === 'big-2.mp4'), 1);
        objects.splice(objects.findIndex((o) => o.name === 'big-1.mp4'), 1);
        monitor.invalidate();
        assert.equal((await monitor.evaluate()).severity, 0);
        assert.equal(notifications().length, 2, 'falling does not notify');
        setCapacity(GB);
    });

    await check('alert emails reach staff + extras when a sender exists; text points to "Download now"', async () => {
        store.storage_settings[0].extra_recipient_emails = ['owner@sudarshan.test'];
        store.storage_settings[0].updated_by = STAFF;
        adminResend = { apiKey: 're_test', fromEmail: 'alerts@sudarshan.test', fromName: 'Sudarshan' };
        setCapacity(10 * MB);
        setUsage('campaign-media', 'big-3.mp4', Math.round(8.7 * MB));
        await monitor.evaluate();
        const latest = notifications().at(-1);
        assert.equal(latest.email_status, 'sent');
        assert.equal(latest.email_recipients, 3);
        assert.match(latest.message, /download what you need to keep/);
        assert.match(emails.at(-1).text, /Download now/);
        assert.match(emails.at(-1).text, /Last download & clean-up: none yet/);
        objects.splice(objects.findIndex((o) => o.name === 'big-3.mp4'), 1);
        setCapacity(GB);
        await monitor.evaluate();
    });

    // ── Download now + clean up ─────────────────────────────────
    putObject('campaign-excel-uploads', '1700000000_contacts.xlsx', crypto.randomBytes(3000), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { daysOld: 90 });
    putObject('campaign-excel-uploads', '1790000000_new.xlsx', crypto.randomBytes(2000), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { daysOld: 2 });
    putObject('campaign-media', 'user-1/banner.png', crypto.randomBytes(5000), 'image/png', { daysOld: 60 });
    putObject('campaign-media', 'user-1/offer.pdf', crypto.randomBytes(7000), 'application/pdf', { daysOld: 60 });
    const pan = putObject('kyc-documents', `${KYC_ID}/pan_proof.pdf`, crypto.randomBytes(4000), 'application/pdf', { daysOld: 120 });
    putObject('kyc-documents', `technicians/${TECH_ID}/aadhaar.jpg`, crypto.randomBytes(3500), 'image/jpeg', { daysOld: 100 });
    store.kyc_submissions.push({ id: KYC_ID, legal_name: 'Shree Ganesh Polymers', documents: { pan_proof: { path: `${KYC_ID}/pan_proof.pdf`, file_name: 'pan.pdf', size: 4000 } } });
    store.technician_partner_registrations.push({ id: TECH_ID, documents: { aadhaar: { path: `technicians/${TECH_ID}/aadhaar.jpg`, file_name: 'aadhaar.jpg' } } });
    // A draft campaign still needs offer.pdf; a finished one used banner.png.
    store.campaigns.push({ id: 1, status: 'draft', media_bucket: 'campaign-media', media_object_path: 'user-1/offer.pdf' });
    store.campaigns.push({ id: 2, status: 'completed', media_bucket: 'campaign-media', media_object_path: 'user-1/banner.png' });

    await check('zip writer: exact length known up front; CRC-32 matches the standard value', async () => {
        assert.equal(crc32(Buffer.from('123456789')).toString(16), 'cbf43926');
        assert.equal(zipLength([{ name: 'a.txt', size: 3 }]), 30 + 5 + 3 + 46 + 5 + 22);
    });

    await check('folders listed per location with readable labels', async () => {
        const folders = await archives.listFolders();
        const kyc = folders.find((f) => f.bucket === 'kyc-documents' && f.folder === KYC_ID);
        assert.equal(kyc.label, 'Vendor KYC · Shree Ganesh Polymers');
        assert.equal(folders.find((f) => f.folder === 'technicians').label, 'Partner registrations (Aadhaar)');
        assert.equal(folders.find((f) => f.bucket === 'campaign-excel-uploads').folder, '');
        assert.equal(folders.find((f) => f.bucket === 'campaign-excel-uploads').files, 2);
    });

    await check('prepare: validation, "older than" filter, who prepared it', async () => {
        await assert.rejects(archives.createArchive({ folders: [] }, { id: STAFF, email: EMAILS[STAFF] }), /at least one folder/);
        await assert.rejects(archives.createArchive({ folders: [{ bucket: 'kyc-documents', folder: '../x' }] }, {}), /not valid/);
        const archive = await archives.createArchive({ folders: [{ bucket: 'campaign-excel-uploads', folder: '' }], olderThanDays: 30 }, { id: STAFF, email: EMAILS[STAFF] });
        assert.equal(archive.fileCount, 1, 'only the 90-day-old upload');
        assert.equal(archive.createdBy, EMAILS[STAFF]);
        assert.match(archive.name, /^sudarshan-storage-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
        await archives.cancelArchive(archive.id);
    });

    // ── HTTP ────────────────────────────────────────────────────
    const { router, publicRouter } = require('../../routes/storage');
    const app = express();
    app.use(express.json());
    app.use('/api/storage', publicRouter);
    app.use('/api/storage', auth.requireAuth, router);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/storage`;
    const call = async (method, path, { token, body, headers = {} } = {}) => {
        const response = await fetch(`${base}${path}`, {
            method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const type = response.headers.get('content-type') || '';
        return { status: response.status, headers: response.headers, data: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
    };

    try {
        clearStaffCache();
        let archiveId;
        let zipBuffer;
        await check('admins only: normal users cannot prepare, download or clean up', async () => {
            assert.equal((await call('POST', '/archives', { token: 'token-user', body: { folders: [{ bucket: 'campaign-media', folder: 'user-1' }] } })).status, 403);
            assert.equal((await call('GET', '/overview', { token: 'token-user' })).status, 403);
            const status = await call('GET', '/status', { token: 'token-user' });
            assert.equal(status.status, 200);
            assert.ok(!JSON.stringify(status.data).includes('kyc-documents'), 'no buckets or file names for normal users');
        });

        await check('download now: a real ZIP with every selected file + MANIFEST.csv; who downloaded it', async () => {
            const prepared = await call('POST', '/archives', { token: 'token-staff', body: { folders: [{ bucket: 'campaign-media', folder: 'user-1' }, { bucket: 'kyc-documents', folder: KYC_ID }, { bucket: 'kyc-documents', folder: 'technicians' }] } });
            assert.equal(prepared.status, 201, JSON.stringify(prepared.data));
            archiveId = prepared.data.id;
            assert.equal(prepared.data.fileCount, 4);
            assert.equal(prepared.data.inUseFiles, 1, 'offer.pdf is used by a draft campaign');
            const download = await call('GET', `/archives/${archiveId}/download`, { token: 'token-staff2' });
            assert.equal(download.status, 200);
            zipBuffer = download.data;
            assert.equal(Number(download.headers.get('content-length')), zipBuffer.length, 'exact length sent up front');
            const zip = await JSZip.loadAsync(zipBuffer);
            const names = Object.keys(zip.files).sort();
            assert.deepEqual(names, ['MANIFEST.csv', 'campaign-media/user-1/banner.png', 'campaign-media/user-1/offer.pdf', `kyc-documents/${KYC_ID}/pan_proof.pdf`, `kyc-documents/technicians/${TECH_ID}/aadhaar.jpg`].sort());
            assert.ok((await zip.file(`kyc-documents/${KYC_ID}/pan_proof.pdf`).async('nodebuffer')).equals(pan.buffer), 'file bytes intact');
            assert.match(await zip.file('MANIFEST.csv').async('string'), /pan_proof\.pdf/);
            const row = store.storage_archives.find((a) => a.id === archiveId);
            assert.equal(row.status, 'downloaded');
            assert.equal(row.downloaded_by_email, EMAILS[STAFF2]);
            assert.equal(row.download_count, 1);
        });

        await check('clean up is refused before verify, with a wrong checksum, and without "saved" confirmation', async () => {
            const early = await call('POST', `/archives/${archiveId}/cleanup`, { token: 'token-staff', body: { confirmSaved: true } });
            assert.equal(early.status, 409);
            const wrong = await call('POST', `/archives/${archiveId}/verify`, { token: 'token-staff2', body: { bytes: zipBuffer.length, crc32: '00000000' } });
            assert.equal(wrong.status, 409);
            assert.match(wrong.data.error, /incomplete or damaged/);
            const cut = await call('POST', `/archives/${archiveId}/verify`, { token: 'token-staff2', body: { bytes: zipBuffer.length - 10, crc32: crc32(zipBuffer).toString(16) } });
            assert.equal(cut.status, 409, 'a cut-off download never verifies');
            const ok = await call('POST', `/archives/${archiveId}/verify`, { token: 'token-staff2', body: { bytes: zipBuffer.length, crc32: crc32(zipBuffer).toString(16).padStart(8, '0') } });
            assert.equal(ok.status, 200, JSON.stringify(ok.data));
            assert.equal(ok.data.verifiedBy, EMAILS[STAFF2]);
            const noConfirm = await call('POST', `/archives/${archiveId}/cleanup`, { token: 'token-staff2', body: {} });
            assert.equal(noConfirm.status, 400);
            assert.equal(objects.length, 7, 'nothing removed yet');
        });

        await check('clean up removes exactly the downloaded files; keeps in-use and changed ones; records who', async () => {
            putObject('campaign-media', 'user-1/banner.png', crypto.randomBytes(5100), 'image/png'); // changed after download
            const before = notifications().length;
            const result = await call('POST', `/archives/${archiveId}/cleanup`, { token: 'token-staff2', body: { confirmSaved: true } });
            assert.equal(result.status, 200, JSON.stringify(result.data));
            assert.equal(result.data.status, 'cleaned');
            assert.equal(result.data.cleanedFiles, 2, 'pan_proof + aadhaar');
            assert.equal(result.data.cleanedBy, EMAILS[STAFF2]);
            assert.equal(result.data.counts.kept, 2);
            const notes = result.data.kept.map((k) => k.note).join(' | ');
            assert.match(notes, /Still used by a campaign/);
            assert.match(notes, /Changed after the download/);
            assert.ok(objects.some((o) => o.name === 'user-1/offer.pdf'), 'in-use file stays');
            assert.ok(objects.some((o) => o.name === 'user-1/banner.png'), 'changed file stays');
            assert.ok(!objects.some((o) => o.name.endsWith('pan_proof.pdf')), 'downloaded KYC file removed');
            assert.ok(objects.some((o) => o.name === '1790000000_new.xlsx'), 'files not in the ZIP stay');
            // The KYC / partner records say where the documents went, and who did it.
            const kycDoc = store.kyc_submissions[0].documents.pan_proof;
            assert.equal(kycDoc.archived.by, EMAILS[STAFF2]);
            assert.match(kycDoc.archived.archive, /^sudarshan-storage-/);
            assert.equal(store.technician_partner_registrations[0].documents.aadhaar.archived.by, EMAILS[STAFF2]);
            assert.deepEqual(await documentLinks(store.kyc_submissions[0]), {}, 'no Open link for an archived document');
            // Every administrator is told.
            const notice = notifications().slice(before).find((n) => n.kind === 'cleanup_done');
            assert.ok(notice, 'clean-up notification recorded');
            assert.match(notice.message, new RegExp(`^${EMAILS[STAFF2]} downloaded sudarshan-storage-.*\\.zip and removed 2 file\\(s\\)`));
            assert.equal(notice.email_status, 'sent');
            assert.match(emails.at(-1).subject, /^Storage clean-up by ravi@sudarshan\.test: 2 file\(s\) removed/);
        });

        await check('history shows who prepared, downloaded, confirmed and cleaned; no second clean-up or re-download', async () => {
            const overview = await call('GET', '/overview', { token: 'token-staff' });
            assert.equal(overview.status, 200, JSON.stringify(overview.data));
            const entry = overview.data.archives.find((a) => a.id === archiveId);
            assert.deepEqual([entry.createdBy, entry.downloadedBy, entry.verifiedBy, entry.cleanedBy], [EMAILS[STAFF], EMAILS[STAFF2], EMAILS[STAFF2], EMAILS[STAFF2]]);
            assert.equal((await call('POST', `/archives/${archiveId}/cleanup`, { token: 'token-staff', body: { confirmSaved: true } })).status, 409);
            assert.equal((await call('GET', `/archives/${archiveId}/download`, { token: 'token-staff' })).status, 410);
            const status = await call('GET', '/status', { token: 'token-user' });
            assert.equal(status.data.lastCleanup.by, EMAILS[STAFF2]);
            const history = await call('GET', '/notifications', { token: 'token-user' });
            assert.ok(history.data.notifications.some((n) => n.kind === 'cleanup_done'), 'everyone can see who cleaned up');
        });

        await check('a download that breaks part-way is aborted and never counts as downloaded', async () => {
            const prepared = await call('POST', '/archives', { token: 'token-staff', body: { folders: [{ bucket: 'campaign-excel-uploads', folder: '' }] } });
            failDownloadOf = '1790000000_new.xlsx';
            await assert.rejects(fetch(`${base}/archives/${prepared.data.id}/download`, { headers: { Authorization: 'Bearer token-staff' } }).then((r) => r.arrayBuffer()));
            failDownloadOf = null;
            const row = store.storage_archives.find((a) => a.id === prepared.data.id);
            assert.equal(row.status, 'ready');
            assert.equal((await call('POST', `/archives/${prepared.data.id}/cleanup`, { token: 'token-staff', body: { confirmSaved: true } })).status, 409);
            assert.equal(objects.filter((o) => o.bucket_id === 'campaign-excel-uploads').length, 2, 'nothing removed');
        });

        await check('too large a selection is refused with a clear message', async () => {
            putObject('campaign-media', 'huge/video.mp4', crypto.randomBytes(10), 'video/mp4', { size: 2 * GB });
            const big = await call('POST', '/archives', { token: 'token-staff', body: { folders: [{ bucket: 'campaign-media', folder: 'huge' }] } });
            assert.equal(big.status, 400);
            assert.match(big.data.error, /up to 5000 files and 1\.00 GB/);
        });

        await check('cron endpoint needs the secret; settings save works', async () => {
            assert.equal((await call('POST', '/cron')).status, 401);
            assert.equal((await call('POST', '/cron', { headers: { 'X-Cron-Secret': process.env.STORAGE_CRON_SECRET } })).status, 200);
            const saved = await call('PUT', '/settings', { token: 'token-staff', body: { capacity_gb: 1, warn_early_pct: 60, warn_high_pct: 80, warn_critical_pct: 90, reminder_hours: 12, notify_all_staff: true, extra_recipient_emails: [] } });
            assert.equal(saved.status, 200, JSON.stringify(saved.data));
            assert.equal(saved.data.settings.warn_early_pct, 60);
        });
    } finally {
        server.close();
        jobs.stop();
    }
    console.log(results.join('\n'));
    console.log(`\nstorage monitor smoke: ${results.length} checks passed`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
