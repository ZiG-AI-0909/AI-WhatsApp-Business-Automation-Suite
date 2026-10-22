'use strict';

// Storage file list for administrators: paged, filterable, with a
// short-lived download link per file. Files are removed only through
// "Download now + clean up" (storageArchive.js), never one by one here.

const { supabase } = require('../database/supabaseClient');
const monitor = require('./storageMonitor');

const DOWNLOAD_URL_SECONDS = 120;
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
    const { data, error } = await supabase.rpc('storage_monitor_files', {
        p_bucket: filters.bucket, p_mime_prefix: filters.mimePrefix, p_min_bytes: filters.minBytes,
        p_search: filters.search, p_sort: filters.sort, p_limit: filters.pageSize, p_offset: (filters.page - 1) * filters.pageSize,
    });
    if (error) throw dbError(error, 'Could not list stored files.');
    const rows = data || [];
    return {
        files: rows.map((row) => ({
            bucket: row.bucket_id,
            name: row.name,
            sizeBytes: Number(row.size_bytes) || 0,
            mimeType: row.mime_type,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        })),
        total: Number(rows[0]?.total_count) || 0,
        page: filters.page,
        pageSize: filters.pageSize,
    };
}

async function downloadUrl(bucket, name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(String(bucket || '')) || !name || String(name).length > 1024 || String(name).includes('..')) {
        throw new StorageError('File not found.', 404, 'STORAGE_FILE_NOT_FOUND');
    }
    requireDb();
    const { data: rows, error: findError } = await supabase.rpc('storage_monitor_files', {
        p_bucket: bucket, p_mime_prefix: null, p_min_bytes: null, p_search: name, p_sort: 'newest', p_limit: 200, p_offset: 0,
    });
    if (findError) throw dbError(findError, 'Could not look up the file.');
    if (!(rows || []).some((row) => row.name === name)) throw new StorageError('File not found.', 404, 'STORAGE_FILE_NOT_FOUND');
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(name, DOWNLOAD_URL_SECONDS, { download: name.split('/').pop() });
    if (error || !data?.signedUrl) throw new StorageError('Could not create a download link.', 502, 'STORAGE_DOWNLOAD');
    return { url: data.signedUrl, expiresInSeconds: DOWNLOAD_URL_SECONDS };
}

module.exports = { readFileFilters, listFiles, downloadUrl };
