'use strict';

// Staff & Member Login (/staff-login) and the staff dashboard
// (/staff/dashboard). Field staff are rows of public.technician_staff, not
// Supabase Auth users: a Supabase account would pass requireAuth and open
// the admin app. So a staff member signs in with Staff ID + PIN (the same
// scrypt check and 5-wrong-PIN / 15-minute lock-out as the partner form's
// Staff mode, technicianStaff.resolveStaff) and gets a 12-hour session token:
// an HS256 JWT signed with STAFF_SESSION_SECRET, sent as a Bearer header.
// Not a cookie: the frontend (Vercel) and API (Render) are different sites,
// and phones block third-party cookies.
//
// Every request re-reads the staff row, so deactivating someone ends their
// sessions at once; the token also carries a fingerprint of the PIN hash,
// so a PIN change ends every older session.
//
// Dashboard data is always filtered by the session's staff id — never by an
// id from the request — and shows no documents, birth / marriage dates or
// addresses; mobile numbers are masked.

const crypto = require('crypto');
const QRCode = require('qrcode');
const { supabase, isAvailable } = require('../database/supabaseClient');
const { KycError, isMissingSchema, indiaDayStart } = require('../kyc/kycService');
const { STATUSES } = require('./technicianSchema');
const staffService = require('./technicianStaff');

const STAFF_TABLE = 'technician_staff';
const REGISTRATIONS = 'technician_partner_registrations';
const STAFF_COLUMNS = 'id, staff_code, full_name, active, pin_hash, pin_must_change, target_count, target_period';
const ROW_COLUMNS = 'id, submitted_at, full_name, shop_name, district, place, mobile, registration_source, status';
const SESSION_SECONDS = 12 * 60 * 60;
const AUDIENCE = 'staff-portal';
const PAGE_SIZE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIGRATION_MESSAGE = 'Staff login needs a database update: run supabase-technician-staff-migration.sql, supabase-employee-registration-migration.sql and supabase-technician-staff-portal-migration.sql in the Supabase SQL Editor.';

function dbError(error, message) {
    if (isMissingSchema(error) || error?.code === '42703') return new KycError(MIGRATION_MESSAGE, 503, 'STAFF_MIGRATION_PENDING');
    console.error(`[staff-portal] ${message}: ${error?.code || ''} ${error?.message || error}`);
    return new KycError(message, 500, 'STAFF_DB_ERROR');
}

function requireDb() {
    if (!isAvailable() || !supabase) throw new KycError('The database is not configured.', 503, 'KYC_UNAVAILABLE');
}

// ── Session tokens ─────────────────────────────────────────────────────

function secret() {
    const value = process.env.STAFF_SESSION_SECRET || '';
    if (value.length < 32) throw new KycError('Staff login is not set up yet. Please contact the office.', 503, 'STAFF_LOGIN_UNAVAILABLE');
    return value;
}

const base64url = (value) => Buffer.from(value).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest();
const pinFingerprint = (pinHash) => crypto.createHash('sha256').update(String(pinHash || '')).digest('base64url').slice(0, 22);

function issueSession(staff, now = Date.now()) {
    const iat = Math.floor(now / 1000);
    const head = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = base64url(JSON.stringify({ sub: staff.id, aud: AUDIENCE, sv: pinFingerprint(staff.pin_hash), iat, exp: iat + SESSION_SECONDS }));
    const signature = base64url(sign(`${head}.${body}`));
    return { token: `${head}.${body}.${signature}`, expires_at: new Date((iat + SESSION_SECONDS) * 1000).toISOString() };
}

/** Verified token claims, or null (bad signature, expired, wrong audience). */
function readSession(token, now = Date.now()) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const expected = sign(`${parts[0]}.${parts[1]}`);
    const given = Buffer.from(parts[2], 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
    if (claims?.aud !== AUDIENCE || !UUID.test(String(claims.sub || '')) || !(claims.exp > now / 1000)) return null;
    return claims;
}

/** The active staff row behind a session token, or null. */
async function staffFromToken(token) {
    if (!token) return null;
    const claims = readSession(token);
    if (!claims) return null;
    requireDb();
    const { data, error } = await supabase.from(STAFF_TABLE).select(STAFF_COLUMNS).eq('id', claims.sub).maybeSingle();
    if (error) throw dbError(error, 'Could not check your sign-in.');
    if (!data || !data.active || pinFingerprint(data.pin_hash) !== claims.sv) return null;
    return data;
}

const bearer = (req) => {
    const header = (typeof req.get === 'function' ? req.get('authorization') : req.headers?.authorization) || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

/** Express middleware: req.staff = the signed-in staff member, or 401. */
async function requireStaffSession(req, res, next) {
    try {
        const staff = await staffFromToken(bearer(req));
        if (!staff) return res.status(401).json({ error: 'Please sign in again.', code: 'STAFF_SESSION_ENDED' });
        req.staff = staff;
        return next();
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not check your sign-in.', code: error.code });
    }
}

/** What the browser may know about the signed-in staff member. */
const profile = (staff) => ({
    staff_code: staff.staff_code,
    full_name: staff.full_name,
    pin_must_change: Boolean(staff.pin_must_change),
    target_count: staff.target_count ?? null,
    target_period: staff.target_period || 'month',
});

async function loadStaff(id) {
    const { data, error } = await supabase.from(STAFF_TABLE).select(STAFF_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw dbError(error, 'Could not sign you in.');
    return data;
}

// ── Login + PIN change ─────────────────────────────────────────────────

/**
 * @returns {{ session?, staff?, error?: 'invalid' | 'locked' | 'inactive' }}
 * 'invalid' covers unknown IDs, wrong PINs and empty fields alike.
 */
async function login({ staff_code: code, pin }) {
    secret(); // refuse before touching PIN counters when sessions cannot be issued
    const result = await staffService.resolveStaff({ code, pin });
    if (result.errors) {
        const reason = Object.values(result.errors)[0];
        return { error: reason === 'staff_locked' ? 'locked' : reason === 'staff_inactive' ? 'inactive' : 'invalid' };
    }
    const staff = await loadStaff(result.staff.id);
    if (!staff?.active) return { error: 'inactive' };
    return { session: issueSession(staff), staff: profile(staff) };
}

/**
 * Change the PIN (optional: an initial PIN keeps working until then).
 * The current PIN goes through the same lock-out as a login.
 * @returns {{ session?, staff?, errors? }} errors: { current_pin | new_pin: message }
 */
async function changePin(staff, { current_pin: currentPin, new_pin: newPin }) {
    const next = String(newPin ?? '').trim();
    const errors = {};
    if (!/^\d{4,8}$/.test(next)) errors.new_pin = 'The new PIN must be 4–8 digits.';
    else if (staffService.pinMatches(next, staff.pin_hash)) errors.new_pin = 'Choose a PIN different from the current one.';
    const check = await staffService.resolveStaff({ code: staff.staff_code, pin: currentPin });
    if (check.errors) {
        errors.current_pin = check.errors.staff_pin === 'staff_locked'
            ? 'Too many wrong PINs. Try again in 15 minutes.'
            : 'The current PIN is wrong.';
    }
    if (Object.keys(errors).length) return { errors };
    const { error } = await supabase.from(STAFF_TABLE)
        .update({ pin_hash: staffService.hashPin(next), pin_must_change: false, pin_failed_count: 0, pin_locked_until: null })
        .eq('id', staff.id);
    if (error) throw dbError(error, 'Could not change your PIN.');
    const updated = await loadStaff(staff.id);
    console.log(`[staff-portal] ${staff.staff_code} changed their PIN`);
    return { session: issueSession(updated), staff: profile(updated) };
}

// ── Dashboard data (always this staff member's own rows) ───────────────

/** 9845012345 → 98XXXXX345 */
function maskMobile(mobile) {
    const digits = String(mobile || '').replace(/\D/g, '');
    return digits.length >= 6 ? `${digits.slice(0, 2)}${'X'.repeat(digits.length - 5)}${digits.slice(-3)}` : 'XXXXXXXXXX';
}

/**
 * Today / this week / this month / all time (India time) and the target
 * progress, with the same credit rule as the admin report
 * (technicianStaff.creditedIds).
 */
async function summary(staff, { now = new Date() } = {}) {
    requireDb();
    const rows = await staffService.allRegistrations();
    const credited = staffService.creditedIds(rows);
    const mine = rows.filter((row) => row.staff_id === staff.id && staffService.ATTRIBUTED.includes(row.registration_source));
    const within = (row, window) => row.submitted_at >= window.start && row.submitted_at < window.end;
    const windows = { today: staffService.periodWindow('day', now), week: staffService.periodWindow('week', now), month: staffService.periodWindow('month', now) };
    const counts = { all: mine.length };
    for (const [key, window] of Object.entries(windows)) counts[key] = mine.filter((row) => within(row, window)).length;
    let target = null;
    if (staff.target_count) {
        const window = staffService.periodWindow(staff.target_period, now);
        const done = mine.filter((row) => credited.has(row.id) && within(row, window)).length;
        target = { ...window, target: staff.target_count, credited: done, percent: Math.round((done / staff.target_count) * 1000) / 10, met: done >= staff.target_count };
    }
    return {
        counts,
        by_source: { referral: mine.filter((row) => row.registration_source === 'referral').length, staff: mine.filter((row) => row.registration_source === 'staff').length },
        target,
    };
}

function readListFilters(query = {}) {
    const page = Number.parseInt(query.page, 10);
    return {
        from: indiaDayStart(query.from),
        to: indiaDayStart(query.to, 1),
        source: staffService.ATTRIBUTED.includes(query.source) ? query.source : '',
        status: STATUSES.includes(query.status) ? query.status : '',
        page: Number.isInteger(page) && page > 0 ? Math.min(page, 10000) : 1,
    };
}

/** One page of this staff member's registrations, newest first. */
async function registrations(staff, query = {}) {
    requireDb();
    const filters = readListFilters(query);
    let request = supabase.from(REGISTRATIONS).select(ROW_COLUMNS, { count: 'exact' })
        .eq('staff_id', staff.id)
        .in('registration_source', staffService.ATTRIBUTED);
    if (filters.source) request = request.eq('registration_source', filters.source);
    if (filters.status) request = request.eq('status', filters.status);
    if (filters.from) request = request.gte('submitted_at', filters.from);
    if (filters.to) request = request.lt('submitted_at', filters.to);
    const start = (filters.page - 1) * PAGE_SIZE;
    const { data, error, count } = await request
        .order('submitted_at', { ascending: false })
        .order('id', { ascending: false })
        .range(start, start + PAGE_SIZE - 1);
    if (error) throw dbError(error, 'Could not load your registrations.');
    const fields = ROW_COLUMNS.split(',').map((column) => column.trim());
    return {
        registrations: (data || []).map((row) => ({ ...Object.fromEntries(fields.map((field) => [field, row[field] ?? null])), mobile: maskMobile(row.mobile) })),
        total: count ?? (data || []).length,
        page: filters.page,
        page_size: PAGE_SIZE,
    };
}

/**
 * The personal link to the partner form, and its QR code (SVG). The origin
 * is the app's own (the request's Origin, already checked by the CORS layer).
 */
async function personalLink(staff, origin) {
    if (!/^https?:\/\/[^/\s]+$/i.test(String(origin || ''))) throw new KycError('Open this page from the app to get your link.', 400, 'STAFF_LINK_ORIGIN');
    const url = `${origin}/technician-registration?ref=${encodeURIComponent(staff.staff_code)}`;
    const qr_svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { url, qr_svg };
}

module.exports = {
    SESSION_SECONDS,
    issueSession,
    readSession,
    staffFromToken,
    requireStaffSession,
    profile,
    login,
    changePin,
    maskMobile,
    summary,
    registrations,
    personalLink,
};
