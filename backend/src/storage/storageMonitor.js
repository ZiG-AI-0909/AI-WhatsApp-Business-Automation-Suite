'use strict';

// Storage monitoring — usage, warning thresholds and alerts.
//
// Measurement: public.storage_monitor_usage() sums the byte size Supabase
// records for every object in Supabase Storage (all buckets). That is an
// exact per-object measurement; it is labelled as such. The plan's quota
// cannot be read from the project, so capacity comes ONLY from the
// administrator's setting — when it is not set we show usage but no
// percentage and raise no threshold alerts (nothing is invented).
//
// Alerts: severity 1/2/3/4 = early / high / critical / full (thresholds
// configurable, defaults 70/85/95 and 100). A notification is sent when
// usage moves UP to a new severity (a jump straight to critical sends
// only the critical one), and again for the same severity only after the
// reminder interval. Falling below a threshold resets the state, so
// crossing it again alerts again. Evaluation runs under a database lock,
// so several server instances never send the same alert twice.

const os = require('os');
const crypto = require('crypto');
const { supabase, isAvailable } = require('../database/supabaseClient');
const { ALLOWED_ORIGINS } = require('../utils/origins');

const CACHE_MS = 30_000;
const SNAPSHOT_EVERY_MS = 30 * 60_000;
const LOCK_SECONDS = 120;
const HOLDER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
const GB = 1024 ** 3;

const SEVERITY = { none: 0, early: 1, high: 2, critical: 3, full: 4 };
const SEVERITY_NAMES = ['none', 'early', 'high', 'critical', 'full'];

const MIGRATION_MESSAGE = 'Storage monitoring needs a database update: run supabase-storage-monitor-migration.sql in the Supabase SQL Editor.';

class StorageError extends Error {
    constructor(message, statusCode = 400, code = 'STORAGE_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

function isMissingSchema(error) {
    return ['42P01', 'PGRST205', 'PGRST202', '42883'].includes(error?.code);
}

function dbError(error, message) {
    if (isMissingSchema(error)) return new StorageError(MIGRATION_MESSAGE, 503, 'STORAGE_MIGRATION_PENDING');
    console.error(`[storage] ${message}: ${error?.code || ''} ${error?.message || error}`);
    return new StorageError(message, 500, 'STORAGE_DB_ERROR');
}

function requireDb() {
    if (!isAvailable() || !supabase) throw new StorageError('The database is not configured.', 503, 'STORAGE_UNAVAILABLE');
}

// ── Socket.IO (set by storageJobs.start) ─────────────────────────────
let io = null;
function setIo(server) { io = server; }

// ── Locks ────────────────────────────────────────────────────────────
async function tryLock(name, seconds = LOCK_SECONDS, holder = HOLDER) {
    const { data, error } = await supabase.rpc('storage_monitor_try_lock', { p_name: name, p_holder: holder, p_seconds: seconds });
    if (error) throw dbError(error, 'Could not take the storage job lock.');
    return data === true;
}
async function unlock(name, holder = HOLDER) {
    try {
        await supabase.rpc('storage_monitor_unlock', { p_name: name, p_holder: holder });
    } catch { /* the lease expires on its own */ }
}

// ── Settings ─────────────────────────────────────────────────────────
const SETTINGS_COLUMNS = 'capacity_bytes, db_capacity_bytes, warn_early_pct, warn_high_pct, warn_critical_pct, reminder_hours, notify_all_staff, extra_recipient_emails, updated_at, updated_by';
let settingsCache = null;

async function getSettings({ fresh = false } = {}) {
    if (!fresh && settingsCache && Date.now() - settingsCache.at < CACHE_MS) return settingsCache.value;
    requireDb();
    const { data, error } = await supabase.from('storage_settings').select(SETTINGS_COLUMNS).eq('id', 1).maybeSingle();
    if (error) throw dbError(error, 'Could not load storage settings.');
    if (!data) throw new StorageError(MIGRATION_MESSAGE, 503, 'STORAGE_MIGRATION_PENDING');
    const value = {
        ...data,
        capacity_bytes: data.capacity_bytes == null ? null : Number(data.capacity_bytes),
        db_capacity_bytes: data.db_capacity_bytes == null ? null : Number(data.db_capacity_bytes),
        extra_recipient_emails: data.extra_recipient_emails || [],
    };
    settingsCache = { at: Date.now(), value };
    return value;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Admin settings form → { values, errors }. Sizes arrive in GB. */
function validateSettings(body = {}) {
    const values = {};
    const errors = {};
    const gb = (key, column) => {
        const raw = body[key];
        if (raw === null || raw === undefined || String(raw).trim() === '') { values[column] = null; return; }
        const number = Number(raw);
        if (!Number.isFinite(number) || number <= 0 || number > 1_000_000) errors[key] = 'Enter a size in GB greater than 0.';
        else values[column] = Math.round(number * GB);
    };
    gb('capacity_gb', 'capacity_bytes');
    gb('db_capacity_gb', 'db_capacity_bytes');
    const pct = (key) => {
        const number = Number(body[key]);
        if (!Number.isInteger(number) || number < 1 || number > 99) errors[key] = 'Enter a whole percentage from 1 to 99.';
        values[key] = number;
    };
    pct('warn_early_pct');
    pct('warn_high_pct');
    pct('warn_critical_pct');
    if (!errors.warn_early_pct && !errors.warn_high_pct && !errors.warn_critical_pct
        && !(values.warn_early_pct < values.warn_high_pct && values.warn_high_pct < values.warn_critical_pct)) {
        errors.warn_high_pct = 'Thresholds must increase: early < high < critical.';
    }
    const int = (key, min, max, message) => {
        const number = Number(body[key]);
        if (!Number.isInteger(number) || number < min || number > max) errors[key] = message;
        values[key] = number;
    };
    int('reminder_hours', 0, 720, 'Enter hours from 0 (no reminders) to 720.');
    values.notify_all_staff = body.notify_all_staff === true;
    const emails = (Array.isArray(body.extra_recipient_emails) ? body.extra_recipient_emails : String(body.extra_recipient_emails || '').split(/[\s,;]+/))
        .map((email) => String(email).trim().toLowerCase()).filter(Boolean);
    const badEmail = emails.find((email) => !EMAIL_RE.test(email) || email.length > 254);
    if (badEmail) errors.extra_recipient_emails = `"${badEmail.slice(0, 60)}" is not a valid email address.`;
    if (emails.length > 50) errors.extra_recipient_emails = 'Up to 50 extra recipients.';
    values.extra_recipient_emails = [...new Set(emails)];
    return { values, errors };
}

async function updateSettings(values, userId) {
    requireDb();
    const { error } = await supabase.from('storage_settings')
        .update({ ...values, updated_at: new Date().toISOString(), updated_by: /^[0-9a-f-]{36}$/i.test(String(userId || '')) ? userId : null })
        .eq('id', 1);
    if (error) throw dbError(error, 'Could not save storage settings.');
    settingsCache = null;
    usageCache = null;
    return getSettings({ fresh: true });
}

// ── Usage ────────────────────────────────────────────────────────────
let usageCache = null;
function invalidate() { usageCache = null; statusCache = null; }

/** Severity for a percentage under the current thresholds. */
function severityFor(percent, settings) {
    if (percent == null) return SEVERITY.none;
    if (percent >= 100) return SEVERITY.full;
    if (percent >= settings.warn_critical_pct) return SEVERITY.critical;
    if (percent >= settings.warn_high_pct) return SEVERITY.high;
    if (percent >= settings.warn_early_pct) return SEVERITY.early;
    return SEVERITY.none;
}

async function measureUsage({ fresh = false } = {}) {
    if (!fresh && usageCache && Date.now() - usageCache.at < CACHE_MS) return usageCache.value;
    requireDb();
    const settings = await getSettings({ fresh });
    const [{ data: rows, error }, { data: dbBytes, error: dbErr }, buckets] = await Promise.all([
        supabase.rpc('storage_monitor_usage'),
        supabase.rpc('storage_monitor_db_size'),
        supabase.storage.listBuckets().catch(() => ({ data: null })),
    ]);
    if (error) throw dbError(error, 'Could not measure storage usage.');
    const publicById = new Map((buckets?.data || []).map((bucket) => [bucket.id, bucket.public]));
    // One row per bucket from a GROUP BY: no file is counted twice.
    const byBucket = (rows || []).map((row) => ({
        bucket: row.bucket_id,
        files: Number(row.file_count) || 0,
        bytes: Number(row.total_bytes) || 0,
        lastChange: row.last_change || null,
        public: publicById.has(row.bucket_id) ? publicById.get(row.bucket_id) : null,
    })).sort((a, b) => b.bytes - a.bytes);
    for (const [id, isPublic] of publicById) {
        if (!byBucket.some((item) => item.bucket === id)) byBucket.push({ bucket: id, files: 0, bytes: 0, lastChange: null, public: isPublic });
    }
    const usedBytes = byBucket.reduce((sum, item) => sum + item.bytes, 0);
    const capacityBytes = settings.capacity_bytes;
    const percentUsed = capacityBytes ? Math.round((usedBytes / capacityBytes) * 1000) / 10 : null;
    const value = {
        provider: 'Supabase Storage',
        source: 'storage.objects (size Supabase recorded for each object)',
        exact: true,
        measuredAt: new Date().toISOString(),
        usedBytes,
        fileCount: byBucket.reduce((sum, item) => sum + item.files, 0),
        capacityBytes,
        capacitySource: capacityBytes ? 'Set by an administrator (your Supabase plan quota)' : null,
        availableBytes: capacityBytes ? Math.max(0, capacityBytes - usedBytes) : null,
        percentUsed,
        severity: severityFor(percentUsed, settings),
        byBucket,
        database: {
            bytes: dbErr ? null : Number(dbBytes) || 0,
            capacityBytes: settings.db_capacity_bytes,
            percentUsed: !dbErr && settings.db_capacity_bytes ? Math.round((Number(dbBytes) / settings.db_capacity_bytes) * 1000) / 10 : null,
        },
    };
    usageCache = { at: Date.now(), value };
    return value;
}

async function maybeSnapshot(usage) {
    const { data: last } = await supabase.from('storage_usage_snapshots').select('taken_at, used_bytes, capacity_bytes')
        .order('taken_at', { ascending: false }).limit(1).maybeSingle();
    const due = !last
        || Date.now() - new Date(last.taken_at).getTime() >= SNAPSHOT_EVERY_MS
        || Number(last.used_bytes) !== usage.usedBytes
        || (last.capacity_bytes == null ? null : Number(last.capacity_bytes)) !== usage.capacityBytes;
    if (!due) return false;
    const { error } = await supabase.from('storage_usage_snapshots').insert({
        taken_at: new Date().toISOString(),
        used_bytes: usage.usedBytes,
        file_count: usage.fileCount,
        capacity_bytes: usage.capacityBytes,
        db_bytes: usage.database.bytes,
        by_bucket: usage.byBucket.map(({ bucket, files, bytes }) => ({ bucket, files, bytes })),
    });
    if (error) console.error(`[storage] snapshot failed: ${error.message}`);
    return !error;
}

async function trend({ days = 30 } = {}) {
    requireDb();
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const { data, error } = await supabase.from('storage_usage_snapshots').select('taken_at, used_bytes, capacity_bytes')
        .gte('taken_at', since).order('taken_at', { ascending: true }).limit(2000);
    if (error) throw dbError(error, 'Could not load the usage history.');
    // At most one point per hour keeps the chart light.
    const byHour = new Map();
    for (const row of data || []) byHour.set(String(row.taken_at).slice(0, 13), row);
    return [...byHour.values()].map((row) => ({ at: row.taken_at, usedBytes: Number(row.used_bytes), capacityBytes: row.capacity_bytes == null ? null : Number(row.capacity_bytes) }));
}

// ── Messages ─────────────────────────────────────────────────────────
function formatBytes(bytes) {
    if (bytes == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Number(bytes);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

function pctText(value) {
    return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** The warning text for a severity (wording agreed with Sudarshan). */
function messageFor(severity, usage) {
    const used = usage.percentUsed;
    switch (severity) {
        case SEVERITY.early: return `Storage usage has reached ${pctText(used)}. Please review existing files and prepare for storage cleanup.`;
        case SEVERITY.high: return `High storage usage: ${pctText(used)} of available storage is being used. Please review large files and download what you need to keep.`;
        case SEVERITY.critical: return `Critical storage warning: Only ${pctText(Math.max(0, Math.round((100 - used) * 10) / 10))} of storage remains. Please download or archive important files and free up space.`;
        case SEVERITY.full: return 'Storage capacity has been reached. New uploads may fail. Please free up storage or increase the available capacity.';
        default: return '';
    }
}

function appUrl() {
    const base = (process.env.APP_PUBLIC_URL || ALLOWED_ORIGINS.find((origin) => origin.includes('aisudarshanpipes'))
        || ALLOWED_ORIGINS.find((origin) => origin.startsWith('https://')) || '').replace(/\/$/, '');
    return base ? `${base}/?view=storage#/app` : '';
}

// ── Email (Resend) ───────────────────────────────────────────────────
async function emailSender(settings) {
    if (process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) {
        return { apiKey: process.env.RESEND_API_KEY.trim(), fromEmail: process.env.RESEND_FROM_EMAIL.trim(), fromName: (process.env.RESEND_FROM_NAME || 'Sudarshan Pipes').trim() };
    }
    // Otherwise the Resend settings of the administrator who last saved
    // the storage settings (Settings → Email in the app).
    if (settings.updated_by) {
        try {
            const resend = require('../email/resendService');
            const config = await resend._getUserSettings(settings.updated_by);
            if (config.apiKey && config.fromEmail) return config;
        } catch (error) {
            console.error(`[storage] could not load Resend settings: ${error.message}`);
        }
    }
    return null;
}

async function recipients(settings) {
    const list = [...settings.extra_recipient_emails];
    if (settings.notify_all_staff) {
        const { data, error } = await supabase.rpc('storage_monitor_staff_emails');
        if (error) console.error(`[storage] staff emails unavailable: ${error.code || ''}`);
        for (const row of data || []) if (row?.email) list.push(String(row.email).toLowerCase());
    }
    return [...new Set(list)];
}

let sendEmailImpl = async (config, message) => {
    const resend = require('../email/resendService');
    const client = resend._getResend(config.apiKey);
    const from = config.fromName ? `${config.fromName} <${config.fromEmail}>` : config.fromEmail;
    const result = await client.emails.send({ from, ...message });
    if (result?.error) throw new Error(result.error.message || 'Resend rejected the email.');
};
/** Test seam. */
function setEmailSender(fn) { sendEmailImpl = fn; }

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

async function sendAlertEmails(settings, { subject, lines }) {
    const to = await recipients(settings);
    if (!to.length) return { status: 'no_recipients', count: 0 };
    const config = await emailSender(settings);
    if (!config) return { status: 'not_configured', count: 0, error: 'No Resend email sender is set up (Settings → Email, or RESEND_API_KEY / RESEND_FROM_EMAIL on the server).' };
    const link = appUrl();
    const text = [...lines, '', link ? `Open storage management: ${link}` : ''].join('\n').trim();
    const html = `${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')}${link ? `<p><a href="${escapeHtml(link)}">Open storage management</a></p>` : ''}`;
    let sent = 0;
    let lastError = '';
    for (const recipient of to) {
        try {
            await sendEmailImpl(config, { to: recipient, subject, text, html });
            sent++;
        } catch (error) {
            lastError = String(error.message || error).slice(0, 300);
        }
    }
    return {
        status: sent === to.length ? 'sent' : sent ? 'partial' : 'failed',
        count: sent,
        error: lastError || null,
    };
}

// ── Notifications ────────────────────────────────────────────────────
function emitStatus(payload) {
    try { io?.emit('storage:status', payload); } catch { /* realtime is best effort */ }
}

/**
 * Record a notification, push it to every signed-in browser and email
 * the recipients. Email status is stored truthfully (sent / failed /
 * not_configured / no_recipients) — never assumed.
 */
async function notify({ kind, severity = 0, usage = null, message, emailLines, subject }) {
    requireDb();
    const settings = await getSettings();
    const { data: row, error } = await supabase.from('storage_notifications').insert({
        kind,
        level: severity,
        percent_used: usage?.percentUsed ?? null,
        used_bytes: usage?.usedBytes ?? null,
        capacity_bytes: usage?.capacityBytes ?? null,
        message,
        email_status: 'pending',
    }).select('id, created_at').single();
    if (error) throw dbError(error, 'Could not record the storage notification.');
    statusCache = null;
    emitStatus({ kind, severity, percentUsed: usage?.percentUsed ?? null, message, at: row.created_at });
    const email = await sendAlertEmails(settings, { subject, lines: emailLines || [message] })
        .catch((sendError) => ({ status: 'failed', count: 0, error: String(sendError.message || sendError).slice(0, 300) }));
    await supabase.from('storage_notifications')
        .update({ email_status: email.status, email_recipients: email.count, email_error: email.error || null })
        .eq('id', row.id);
    return { id: row.id, email };
}

/** Latest "Download now + clean up", or null. */
async function lastCleanup() {
    try {
        const { data } = await supabase.from('storage_archives').select('cleaned_at, cleaned_files, cleaned_bytes, cleaned_by_email')
            .eq('status', 'cleaned').order('cleaned_at', { ascending: false }).limit(1);
        return data?.[0] || null;
    } catch {
        return null;
    }
}

function cleanupLine(last) {
    if (!last) return 'Last download & clean-up: none yet.';
    return `Last download & clean-up: ${new Date(last.cleaned_at).toISOString().replace('T', ' ').slice(0, 16)} UTC by ${last.cleaned_by_email || 'an administrator'} (${last.cleaned_files} file(s), ${formatBytes(last.cleaned_bytes)} freed).`;
}

function thresholdEmail(severity, usage, message, last, reminder) {
    const label = { 1: 'Storage early warning', 2: 'High storage usage', 3: 'CRITICAL: storage almost full', 4: 'Storage capacity reached' }[severity];
    return {
        subject: `${reminder ? 'Reminder: ' : ''}${label} — ${pctText(usage.percentUsed)} used`,
        lines: [
            message,
            `Used: ${formatBytes(usage.usedBytes)} of ${formatBytes(usage.capacityBytes)} (${pctText(usage.percentUsed)}). Remaining: ${formatBytes(usage.availableBytes)}.`,
            cleanupLine(last),
            'Recommended: an administrator can open Storage → "Download now", save the ZIP somewhere safe, and then clean up the downloaded files. Contact your administrator if more storage is required.',
        ],
    };
}

/** Measure, snapshot and alert. Returns { usage, severity, notified }. */
async function evaluate() {
    requireDb();
    const holder = `${HOLDER}:${crypto.randomBytes(4).toString('hex')}`;
    if (!(await tryLock('storage-monitor', LOCK_SECONDS, holder))) return { skipped: true };
    try {
        const settings = await getSettings({ fresh: true });
        const usage = await measureUsage({ fresh: true });
        await maybeSnapshot(usage);
        const { data: state, error } = await supabase.from('storage_alert_state').select('level, last_notified_at').eq('id', 1).maybeSingle();
        if (error) throw dbError(error, 'Could not read the alert state.');
        const previous = Number(state?.level) || 0;
        const severity = usage.severity;
        let notified = null;
        const now = new Date();
        const remindAfter = settings.reminder_hours > 0 && state?.last_notified_at
            ? new Date(state.last_notified_at).getTime() + settings.reminder_hours * 3600_000 : Infinity;

        if (severity > previous || (severity > 0 && severity === previous && now.getTime() >= remindAfter)) {
            const reminder = severity === previous;
            const message = messageFor(severity, usage);
            const email = thresholdEmail(severity, usage, message, await lastCleanup(), reminder);
            notified = await notify({ kind: reminder ? 'reminder' : 'threshold', severity, usage, message, subject: email.subject, emailLines: email.lines });
            await supabase.from('storage_alert_state').update({ level: severity, last_notified_at: now.toISOString(), last_percent: usage.percentUsed, updated_at: now.toISOString() }).eq('id', 1);
        } else if (severity !== previous) {
            // Usage fell (files removed or capacity raised): reset so the
            // next crossing alerts again.
            await supabase.from('storage_alert_state').update({ level: severity, last_percent: usage.percentUsed, updated_at: now.toISOString() }).eq('id', 1);
            emitStatus({ kind: 'level', severity, percentUsed: usage.percentUsed, message: messageFor(severity, usage), at: now.toISOString() });
        }
        statusCache = null;
        return { usage, severity, previous, notified };
    } finally {
        await unlock('storage-monitor', holder);
    }
}

async function listNotifications({ limit = 20, includeEmail = false } = {}) {
    requireDb();
    const columns = includeEmail
        ? 'id, created_at, kind, level, percent_used, used_bytes, capacity_bytes, message, email_status, email_recipients, email_error'
        : 'id, created_at, kind, level, percent_used, message';
    const { data, error } = await supabase.from('storage_notifications').select(columns)
        .order('created_at', { ascending: false }).limit(Math.min(Math.max(1, limit), 100));
    if (error) throw dbError(error, 'Could not load storage notifications.');
    // Keep only the selected fields, whatever the client library returns.
    const fields = columns.split(',').map((column) => column.trim());
    return (data || []).map((row) => Object.fromEntries(fields.map((field) => [field, row[field] ?? null])));
}

/**
 * What every signed-in user may see: the warning level and totals — no
 * file names, buckets or paths.
 */
let statusCache = null;
async function publicStatus() {
    if (statusCache && Date.now() - statusCache.at < CACHE_MS) return statusCache.value;
    const usage = await measureUsage();
    const last = await lastCleanup();
    const value = {
        configured: usage.capacityBytes != null,
        severity: usage.severity,
        severityName: SEVERITY_NAMES[usage.severity],
        percentUsed: usage.percentUsed,
        usedBytes: usage.usedBytes,
        capacityBytes: usage.capacityBytes,
        availableBytes: usage.availableBytes,
        measuredAt: usage.measuredAt,
        exact: usage.exact,
        message: messageFor(usage.severity, usage) || null,
        lastCleanup: last ? { at: last.cleaned_at, by: last.cleaned_by_email || null, files: last.cleaned_files, bytes: Number(last.cleaned_bytes) || 0 } : null,
    };
    statusCache = { at: Date.now(), value };
    return value;
}

module.exports = {
    SEVERITY,
    SEVERITY_NAMES,
    HOLDER,
    StorageError,
    MIGRATION_MESSAGE,
    isMissingSchema,
    dbError,
    requireDb,
    setIo,
    tryLock,
    unlock,
    getSettings,
    validateSettings,
    updateSettings,
    measureUsage,
    invalidate,
    severityFor,
    messageFor,
    formatBytes,
    trend,
    notify,
    evaluate,
    listNotifications,
    publicStatus,
    setEmailSender,
    emitStatus,
};
