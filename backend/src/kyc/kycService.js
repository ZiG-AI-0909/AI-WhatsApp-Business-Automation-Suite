'use strict';

// Vendor KYC — storage + database access. Everything runs with the
// service-role client: kyc_submissions and the kyc-documents bucket have
// no RLS/storage policies, so nothing is reachable with the anon key.
// Staff access is decided here (public.is_kyc_staff), never by the client.

const crypto = require('crypto');
const { supabase, isAvailable } = require('../database/supabaseClient');
const { DOCUMENTS, STATUSES } = require('./kycSchema');

const TABLE = 'kyc_submissions';
const BUCKET = 'kyc-documents';
const SIGNED_URL_SECONDS = 10 * 60;
const LIST_LIMIT = 1000;
const EXPORT_LIMIT = 5000;
const LIST_COLUMNS = 'id, submitted_at, status, vendor_code, legal_name, contact_name, contact_mobile, final_decision';
const MIGRATION_MESSAGE = 'Vendor KYC needs a database update: run supabase-vendor-kyc-migration.sql in the Supabase SQL Editor.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Removing someone from private.kyc_staff takes effect within this window.
const STAFF_CACHE_MS = Number(process.env.KYC_STAFF_CACHE_MS || 60_000);
const staffCache = new Map();

class KycError extends Error {
    constructor(message, statusCode = 400, code = 'KYC_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

function isMissingSchema(error) {
    return ['42P01', 'PGRST205', 'PGRST202', '42883', 'PGRST204'].includes(error?.code)
        || /bucket not found/i.test(error?.message || '');
}

function dbError(error, message) {
    if (isMissingSchema(error)) return new KycError(MIGRATION_MESSAGE, 503, 'KYC_MIGRATION_PENDING');
    console.error(`[kyc] ${message}: ${error?.code || ''} ${error?.message || error}`);
    return new KycError(message, 500, 'KYC_DB_ERROR');
}

function requireDb() {
    if (!isAvailable() || !supabase) throw new KycError('The database is not configured.', 503, 'KYC_UNAVAILABLE');
}

/** Short reference shown to the vendor, e.g. KYC-1A2B3C4D. */
function referenceFor(id) {
    return `KYC-${String(id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

// ── Staff access ──────────────────────────────────────────────────────

async function isKycStaff(authUserId, { now = Date.now } = {}) {
    if (process.env.AUTH_DISABLED === 'true') return true; // local dev bypass, see middleware/auth.js
    if (!UUID.test(String(authUserId || ''))) return false;
    const cached = staffCache.get(authUserId);
    if (cached && now() - cached.at < STAFF_CACHE_MS) return cached.allowed;
    requireDb();
    const { data, error } = await supabase.rpc('is_kyc_staff', { p_user_id: authUserId });
    if (error) throw dbError(error, 'Could not verify KYC reviewer access.');
    const allowed = data === true;
    staffCache.set(authUserId, { allowed, at: now() });
    return allowed;
}

/**
 * Express middleware (after requireAuth): only users in private.kyc_staff.
 * Uses req.user.authId — the signed-in person — so a shared workspace
 * never passes reviewer access on to someone else.
 */
async function requireKycStaff(req, res, next) {
    try {
        if (await isKycStaff(req.user?.authId)) return next();
        return res.status(403).json({ error: 'Only KYC reviewers can open submitted vendor forms.', code: 'KYC_STAFF_ONLY' });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
    }
}

function clearStaffCache() {
    staffCache.clear();
}

// ── Public submission ─────────────────────────────────────────────────

async function removeObjects(paths) {
    if (!paths.length) return;
    try {
        const { error } = await supabase.storage.from(BUCKET).remove(paths);
        if (error) throw error;
    } catch (error) {
        console.error(`[kyc] cleanup failed for ${paths.join(', ')}: ${error.message}`);
    }
}

/**
 * Store the documents, then insert the row. Any failure removes the files
 * already uploaded, so a failed submission leaves nothing behind.
 * @param {{ values: object, documents: Array, meta: { ip, userAgent } }} input
 */
async function createSubmission({ values, documents, meta = {} }) {
    requireDb();
    const id = crypto.randomUUID();
    const uploads = await Promise.allSettled(documents.map(async (document) => {
        const objectPath = `${id}/${document.type}${document.ext}`;
        const { error } = await supabase.storage.from(BUCKET).upload(objectPath, document.buffer, {
            contentType: document.mime,
            upsert: false,
        });
        if (error) throw error;
        return { document, objectPath };
    }));
    const stored = uploads.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    const failed = uploads.find((result) => result.status === 'rejected');
    if (failed) {
        await removeObjects(stored.map((item) => item.objectPath));
        if (isMissingSchema(failed.reason)) throw new KycError(MIGRATION_MESSAGE, 503, 'KYC_MIGRATION_PENDING');
        console.error(`[kyc] document upload failed: ${failed.reason?.message || failed.reason}`);
        throw new KycError('Your documents could not be stored. Please try again in a few minutes.', 502, 'KYC_UPLOAD_FAILED');
    }

    const documentMap = {};
    for (const { document, objectPath } of stored) {
        documentMap[document.type] = { path: objectPath, file_name: document.fileName, mime_type: document.mime, size: document.size };
    }
    const row = {
        id,
        ...values,
        documents: documentMap,
        submitter_ip: meta.ip ? String(meta.ip).slice(0, 64) : null,
        submitter_user_agent: meta.userAgent ? String(meta.userAgent).slice(0, 300) : null,
    };
    const { data, error } = await supabase.from(TABLE).insert(row).select('id, submitted_at').single();
    if (error) {
        await removeObjects(stored.map((item) => item.objectPath));
        throw dbError(error, 'Your form could not be saved. Please try again in a few minutes.');
    }
    require('../storage/storageJobs').checkSoon(); // refresh storage usage
    return { id: data.id, submitted_at: data.submitted_at, reference: referenceFor(data.id) };
}

// ── Staff: list / detail / review ─────────────────────────────────────

/** "2026-10-17" → start of that day in India, as an ISO timestamp. */
function indiaDayStart(value, addDays = 0) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const date = new Date(`${value}T00:00:00+05:30`);
    if (Number.isNaN(date.getTime())) return null;
    date.setUTCDate(date.getUTCDate() + addDays);
    return date.toISOString();
}

const SORTS = {
    newest: ['submitted_at', false],
    oldest: ['submitted_at', true],
    name: ['legal_name', true],
    status: ['status', true],
};

/**
 * Filters shared by the list and the Excel export, so the export is
 * exactly the list the reviewer is looking at.
 */
function readFilters(query = {}) {
    const status = STATUSES.includes(query.status) ? query.status : '';
    // Strip PostgREST filter syntax characters from free text.
    const q = String(query.q || '').replace(/[,()*%\\:"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return {
        status,
        from: indiaDayStart(query.from),
        to: indiaDayStart(query.to, 1),
        q,
        sort: SORTS[query.sort] ? query.sort : 'newest',
    };
}

async function querySubmissions(filters, { columns = LIST_COLUMNS, limit = LIST_LIMIT } = {}) {
    requireDb();
    const [column, ascending] = SORTS[filters.sort] || SORTS.newest;
    let query = supabase.from(TABLE).select(columns, { count: 'exact' });
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.from) query = query.gte('submitted_at', filters.from);
    if (filters.to) query = query.lt('submitted_at', filters.to);
    if (filters.q) {
        const like = `"*${filters.q}*"`; // quoted: the term may contain spaces
        query = query.or(`legal_name.ilike.${like},trade_name.ilike.${like},contact_name.ilike.${like},contact_mobile.ilike.${like},vendor_code.ilike.${like},gstin.ilike.${like}`);
    }
    query = query.order(column, { ascending });
    if (column !== 'submitted_at') query = query.order('submitted_at', { ascending: false });
    const { data, error, count } = await query.range(0, limit - 1);
    if (error) throw dbError(error, 'Could not load submitted forms.');
    return { rows: data || [], total: count ?? (data || []).length, limit };
}

const LIST_FIELDS = LIST_COLUMNS.split(',').map((column) => column.trim());

/** List rows carry only the key fields — never PAN or bank details. */
async function listSubmissions(filters) {
    const result = await querySubmissions(filters);
    result.rows = result.rows.map((row) => Object.fromEntries(LIST_FIELDS.map((field) => [field, row[field] ?? null])));
    return result;
}

function exportSubmissions(filters) {
    return querySubmissions(filters, { columns: '*', limit: EXPORT_LIMIT });
}

async function getSubmission(id) {
    if (!UUID.test(String(id || ''))) throw new KycError('Submission not found.', 404, 'KYC_NOT_FOUND');
    requireDb();
    const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (error) throw dbError(error, 'Could not load the submission.');
    if (!data) throw new KycError('Submission not found.', 404, 'KYC_NOT_FOUND');
    return data;
}

/** Short-lived signed URLs for every uploaded document: { [type]: url }. */
async function documentLinks(submission) {
    const entries = DOCUMENTS
        // Archived documents were downloaded and removed from storage.
        .map((document) => [document.key, submission.documents?.[document.key]?.archived ? null : submission.documents?.[document.key]?.path])
        .filter(([, objectPath]) => objectPath);
    if (!entries.length) return {};
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(entries.map(([, objectPath]) => objectPath), SIGNED_URL_SECONDS);
    if (error) {
        console.error(`[kyc] signed URLs failed for ${submission.id}: ${error.message}`);
        return {};
    }
    const byPath = new Map((data || []).map((item) => [item.path, item.signedUrl]));
    return Object.fromEntries(entries.map(([type, objectPath]) => [type, byPath.get(objectPath) || null]));
}

async function updateReview(id, values, reviewerId) {
    await getSubmission(id);
    const { data, error } = await supabase.from(TABLE)
        .update({ ...values, reviewed_by: UUID.test(String(reviewerId || '')) ? reviewerId : null, reviewed_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .single();
    if (error) {
        if (error.code === '23505') throw new KycError(`Vendor code ${values.vendor_code} is already assigned to another vendor.`, 409, 'KYC_VENDOR_CODE_TAKEN');
        throw dbError(error, 'Could not save the review.');
    }
    return data;
}

module.exports = {
    KycError,
    isMissingSchema,
    indiaDayStart,
    BUCKET,
    TABLE,
    SIGNED_URL_SECONDS,
    referenceFor,
    isKycStaff,
    requireKycStaff,
    clearStaffCache,
    createSubmission,
    readFilters,
    listSubmissions,
    exportSubmissions,
    getSubmission,
    documentLinks,
    updateReview,
};
