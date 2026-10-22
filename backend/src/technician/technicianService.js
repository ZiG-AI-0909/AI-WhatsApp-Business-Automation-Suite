'use strict';

// Mechanic / technician partner registrations — storage + database access, with
// the service-role client (same model as kyc/kycService.js: the table has
// RLS on and no policies). The optional Aadhaar goes in the private
// kyc-documents bucket under technicians/<id>/; reviewers are the same
// private.kyc_staff list.

const crypto = require('crypto');
const { supabase, isAvailable } = require('../database/supabaseClient');
const { KycError, isMissingSchema, indiaDayStart, BUCKET, SIGNED_URL_SECONDS } = require('../kyc/kycService');
const { DOCUMENTS, STATUSES } = require('./technicianSchema');

const TABLE = 'technician_partner_registrations';
const PREFIX = 'technicians';
const LIST_LIMIT = 1000;
const EXPORT_LIMIT = 5000;
const LIST_COLUMNS = 'id, submitted_at, status, full_name, shop_name, mobile, place, district, state, shop_maps_url';
const MIGRATION_MESSAGE = 'Technician partner registration needs a database update: run supabase-technician-registration-migration.sql in the Supabase SQL Editor.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dbError(error, message) {
    if (isMissingSchema(error)) return new KycError(MIGRATION_MESSAGE, 503, 'TECH_MIGRATION_PENDING');
    console.error(`[technician] ${message}: ${error?.code || ''} ${error?.message || error}`);
    return new KycError(message, 500, 'TECH_DB_ERROR');
}

function requireDb() {
    if (!isAvailable() || !supabase) throw new KycError('The database is not configured.', 503, 'KYC_UNAVAILABLE');
}

/** Short reference shown to the applicant, e.g. TEC-1A2B3C4D. */
function referenceFor(id) {
    return `TEC-${String(id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

async function removeObjects(paths) {
    if (!paths.length) return;
    try {
        const { error } = await supabase.storage.from(BUCKET).remove(paths);
        if (error) throw error;
    } catch (error) {
        console.error(`[technician] cleanup failed for ${paths.join(', ')}: ${error.message}`);
    }
}

async function findExisting(id) {
    const { data, error } = await supabase.from(TABLE).select('id, submitted_at').eq('id', id).maybeSingle();
    if (error) throw dbError(error, 'Your form could not be saved. Please try again in a few minutes.');
    return data ? { id: data.id, submitted_at: data.submitted_at, reference: referenceFor(data.id), duplicate: true } : null;
}

/**
 * Store the documents, then insert the row; any failure removes the files.
 * `clientId` is a UUID the form makes once per fill-in: a retry after a
 * dropped connection (the first request may have saved) returns the
 * existing registration instead of creating a second one.
 */
async function createRegistration({ values, documents, meta = {}, clientId }) {
    requireDb();
    const id = UUID.test(String(clientId || '')) ? String(clientId).toLowerCase() : crypto.randomUUID();
    const existing = await findExisting(id);
    if (existing) return existing;
    const uploads = await Promise.allSettled(documents.map(async (document) => {
        const objectPath = `${PREFIX}/${id}/${document.type}${document.ext}`;
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
        if (isMissingSchema(failed.reason)) throw new KycError(MIGRATION_MESSAGE, 503, 'TECH_MIGRATION_PENDING');
        console.error(`[technician] document upload failed: ${failed.reason?.message || failed.reason}`);
        throw new KycError('Your documents could not be stored. Please try again in a few minutes.', 502, 'TECH_UPLOAD_FAILED');
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
        // A parallel retry with the same clientId won the insert. The files
        // share its paths, so they are not removed.
        if (error.code === '23505') {
            const winner = await findExisting(id);
            if (winner) return winner;
        }
        await removeObjects(stored.map((item) => item.objectPath));
        throw dbError(error, 'Your form could not be saved. Please try again in a few minutes.');
    }
    return { id: data.id, submitted_at: data.submitted_at, reference: referenceFor(data.id) };
}

function readFilters(query = {}) {
    return {
        status: STATUSES.includes(query.status) ? query.status : '',
        // Strip PostgREST filter syntax characters from free text.
        q: String(query.q || '').replace(/[,()*%\\:"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80),
        from: indiaDayStart(query.from),
        to: indiaDayStart(query.to, 1),
    };
}

/**
 * Filters shared by the list and the Excel export, so the export is
 * exactly the list the reviewer is looking at.
 */
async function queryRegistrations(filters, { columns, limit }) {
    requireDb();
    let query = supabase.from(TABLE).select(columns, { count: 'exact' });
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.from) query = query.gte('submitted_at', filters.from);
    if (filters.to) query = query.lt('submitted_at', filters.to);
    if (filters.q) {
        const like = `"*${filters.q}*"`; // quoted: the term may contain spaces
        query = query.or(`full_name.ilike.${like},shop_name.ilike.${like},mobile.ilike.${like},place.ilike.${like},district.ilike.${like}`);
    }
    const { data, error, count } = await query.order('submitted_at', { ascending: false }).range(0, limit - 1);
    if (error) throw dbError(error, 'Could not load technician registrations.');
    return { rows: data || [], total: count ?? (data || []).length, limit };
}

/** List rows carry only the key fields. */
async function listRegistrations(filters) {
    const result = await queryRegistrations(filters, { columns: LIST_COLUMNS, limit: LIST_LIMIT });
    const fields = LIST_COLUMNS.split(',').map((column) => column.trim());
    result.rows = result.rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])));
    return result;
}

function exportRegistrations(filters) {
    return queryRegistrations(filters, { columns: '*', limit: EXPORT_LIMIT });
}

async function getRegistration(id) {
    if (!UUID.test(String(id || ''))) throw new KycError('Registration not found.', 404, 'TECH_NOT_FOUND');
    requireDb();
    const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (error) throw dbError(error, 'Could not load the registration.');
    if (!data) throw new KycError('Registration not found.', 404, 'TECH_NOT_FOUND');
    return data;
}

/** Short-lived signed URLs for every uploaded document: { [type]: url }. */
async function documentLinks(registration) {
    const entries = DOCUMENTS
        .map((document) => [document.key, registration.documents?.[document.key]?.path])
        .filter(([, objectPath]) => objectPath);
    if (!entries.length) return {};
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(entries.map(([, objectPath]) => objectPath), SIGNED_URL_SECONDS);
    if (error) {
        console.error(`[technician] signed URLs failed for ${registration.id}: ${error.message}`);
        return {};
    }
    const byPath = new Map((data || []).map((item) => [item.path, item.signedUrl]));
    return Object.fromEntries(entries.map(([type, objectPath]) => [type, byPath.get(objectPath) || null]));
}

async function updateReview(id, values, reviewerId) {
    await getRegistration(id);
    const { data, error } = await supabase.from(TABLE)
        .update({ ...values, reviewed_by: UUID.test(String(reviewerId || '')) ? reviewerId : null, reviewed_at: new Date().toISOString() })
        .eq('id', id)
        .select('*')
        .single();
    if (error) throw dbError(error, 'Could not save the review.');
    return data;
}

module.exports = {
    TABLE,
    referenceFor,
    createRegistration,
    readFilters,
    listRegistrations,
    exportRegistrations,
    getRegistration,
    documentLinks,
    updateReview,
};
