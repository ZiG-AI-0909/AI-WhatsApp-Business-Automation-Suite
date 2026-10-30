'use strict';

// Mechanic / technician registration — Staff Mode. Field staff who fill in
// the partner form on a mechanic's behalf are kept in public.technician_staff
// (see supabase-technician-staff-migration.sql); KYC reviewers manage that
// roster and see who registered whom.
//
//   * resolveStaff(): who is registering, from a /staff-login session
//     (staffPortal.js), a linked, signed-in app account or a Staff ID + PIN. Errors are CODES for the public form
//     (technician/i18n.js): staff_required, staff_pin_required,
//     staff_invalid, staff_locked, staff_inactive.
//   * performance(): counts derived from the registration rows, never
//     stored, so a failed submission, a retry or an edit cannot change them.
//     A Staff-mode ('staff') or personal-link ('referral') registration is
//     CREDITED when it is the first registration of that mobile number that
//     was not rejected; unreferred self-registrations are never credited.

const crypto = require('crypto');
const { supabase, isAvailable } = require('../database/supabaseClient');
const { KycError, isMissingSchema, indiaDayStart } = require('../kyc/kycService');
const { normalizeMobile } = require('./technicianSchema');

const TABLE = 'technician_staff';
const REGISTRATIONS = 'technician_partner_registrations';
// state … registration_source come from supabase-employee-registration-migration.sql.
const PUBLIC_COLUMNS = 'id, created_at, updated_at, staff_code, full_name, phone, active, target_count, target_period, auth_user_id, created_by_email, updated_by_email, state, state_code, email, registration_source';
const MIGRATION_MESSAGE = 'Staff registration tracking needs a database update: run supabase-technician-staff-migration.sql, then supabase-employee-registration-migration.sql, in the Supabase SQL Editor.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAFF_CODE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const PIN = /^\d{4,8}$/;
const TARGET_PERIODS = ['day', 'week', 'month'];
// Sources credited to a staff member: their personal link, or Staff mode.
const ATTRIBUTED = ['referral', 'staff'];
const MAX_PIN_FAILURES = Number(process.env.TECHNICIAN_STAFF_PIN_MAX_FAILURES || 5);
const PIN_LOCK_MS = Number(process.env.TECHNICIAN_STAFF_PIN_LOCK_MS || 15 * 60 * 1000);
const PAGE = 1000;
const MAX_ROWS = 50_000;
const IST_OFFSET_MS = 330 * 60 * 1000;

const missingSchema = (error) => isMissingSchema(error) || error?.code === '42703';

function dbError(error, message) {
    if (missingSchema(error)) return new KycError(MIGRATION_MESSAGE, 503, 'TECH_MIGRATION_PENDING');
    console.error(`[technician-staff] ${message}: ${error?.code || ''} ${error?.message || error}`);
    return new KycError(message, 500, 'TECH_DB_ERROR');
}

function requireDb() {
    if (!isAvailable() || !supabase) throw new KycError('The database is not configured.', 503, 'KYC_UNAVAILABLE');
}

// ── PIN hashing (scrypt, per-PIN salt) ─────────────────────────────────

function hashPin(pin) {
    const salt = crypto.randomBytes(16);
    return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(String(pin), salt, 32).toString('hex')}`;
}

// Used for unknown Staff IDs too, so the response time does not reveal
// which IDs exist.
const DUMMY_HASH = hashPin('000000');

function pinMatches(pin, stored) {
    const [scheme, saltHex, hashHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

/**
 * Why a PIN a staff member picks themselves is refused, or '' when it is
 * fine: 4–8 digits (the login rule), not one digit repeated (0000), not a
 * run (1234, 4321, 123456), not a repeated pair (1212).
 */
function newPinProblem(pin) {
    const text = String(pin ?? '');
    if (!PIN.test(text)) return 'The PIN must be 4–8 digits.';
    const steps = [...text].slice(1).map((digit, index) => Number(digit) - Number(text[index]));
    const weak = /^(\d)\1+$/.test(text)
        || steps.every((step) => step === 1) || steps.every((step) => step === -1)
        || /^(\d\d)\1+$/.test(text);
    return weak ? 'This PIN is too easy to guess (like 0000, 1234 or 1212). Choose another.' : '';
}

/**
 * Columns for any PIN change. A PIN set by an admin is temporary
 * (mustChange: the dashboard reminds the staff member to change it); a PIN
 * the staff member chose is not. Clears the lock-out; sessions end because
 * their token holds a fingerprint of the old hash (staffPortal.js).
 */
function newPinFields(pin, { mustChange }) {
    return {
        pin_hash: hashPin(pin),
        pin_must_change: Boolean(mustChange),
        pin_failed_count: 0,
        pin_locked_until: null,
    };
}

const normalizeStaffCode = (value) => String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');

// ── Who is registering (public form) ───────────────────────────────────

/** The signed-in app user behind an optional "Authorization: Bearer" header, or null. */
async function authUserFromRequest(req) {
    const header = (typeof req.get === 'function' ? req.get('authorization') : req.headers?.authorization) || '';
    if (!header.startsWith('Bearer ')) return null;
    const { supabaseAdmin } = require('../middleware/auth');
    if (!supabaseAdmin) return null;
    try {
        const { data, error } = await supabaseAdmin.auth.getClaims(header.slice(7).trim());
        return !error && UUID.test(String(data?.claims?.sub || '')) ? data.claims.sub : null;
    } catch {
        return null; // an expired token just means "enter your Staff ID"
    }
}

const identity = (row, via) => ({ id: row.id, staff_code: row.staff_code, full_name: row.full_name, via });

/**
 * Staff member for a Staff-mode registration.
 * @returns {{ staff?: object, errors?: object }} errors: { staff_code | staff_pin: code }
 */
async function resolveStaff({ code, pin, authUserId, sessionStaffId, now = Date.now() } = {}) {
    requireDb();
    // Signed in at /staff-login (staffPortal.js has already checked the token).
    if (sessionStaffId) {
        const { data, error } = await supabase.from(TABLE).select('id, staff_code, full_name, active').eq('id', sessionStaffId).maybeSingle();
        if (error) throw dbError(error, 'Could not check the staff member.');
        if (data) return data.active ? { staff: identity(data, 'session') } : { errors: { staff_code: 'staff_inactive' } };
    }
    if (authUserId) {
        const { data, error } = await supabase.from(TABLE).select('id, staff_code, full_name, active').eq('auth_user_id', authUserId).maybeSingle();
        if (error) throw dbError(error, 'Could not check the staff member.');
        if (data) return data.active ? { staff: identity(data, 'account') } : { errors: { staff_code: 'staff_inactive' } };
    }
    const staffCode = normalizeStaffCode(code);
    const pinText = String(pin ?? '').trim();
    const errors = {};
    if (!staffCode) errors.staff_code = 'staff_required';
    if (!pinText) errors.staff_pin = 'staff_pin_required';
    if (Object.keys(errors).length) return { errors };
    if (!STAFF_CODE.test(staffCode) || !PIN.test(pinText)) {
        pinMatches(pinText, DUMMY_HASH);
        return { errors: { staff_pin: 'staff_invalid' } };
    }
    const { data: row, error } = await supabase.from(TABLE)
        .select('id, staff_code, full_name, active, pin_hash, pin_failed_count, pin_locked_until')
        .eq('staff_code', staffCode)
        .maybeSingle();
    if (error) throw dbError(error, 'Could not check the staff member.');
    if (!row) {
        pinMatches(pinText, DUMMY_HASH);
        return { errors: { staff_pin: 'staff_invalid' } };
    }
    if (row.pin_locked_until && Date.parse(row.pin_locked_until) > now) return { errors: { staff_pin: 'staff_locked' } };
    if (!pinMatches(pinText, row.pin_hash)) {
        const failures = (row.pin_failed_count || 0) + 1;
        const lock = failures >= MAX_PIN_FAILURES;
        await supabase.from(TABLE)
            .update({ pin_failed_count: lock ? 0 : failures, pin_locked_until: lock ? new Date(now + PIN_LOCK_MS).toISOString() : row.pin_locked_until })
            .eq('id', row.id);
        return { errors: { staff_pin: lock ? 'staff_locked' : 'staff_invalid' } };
    }
    if (row.pin_failed_count || row.pin_locked_until) {
        await supabase.from(TABLE).update({ pin_failed_count: 0, pin_locked_until: null }).eq('id', row.id);
    }
    // Checked after the PIN, so a wrong PIN never tells whether an ID exists.
    if (!row.active) return { errors: { staff_code: 'staff_inactive' } };
    return { staff: identity(row, 'pin') };
}

/**
 * Columns written on a Staff-mode ('staff') or personal-link ('referral')
 * registration (set once; the database locks them).
 */
function attributionFor(staff, source = 'staff') {
    return { registration_source: source, staff_id: staff.id, staff_code: staff.staff_code, staff_name: staff.full_name };
}

/**
 * The active staff member behind a ?ref= code, or null (unknown, inactive or
 * malformed). A bad ref never blocks a registration; it just isn't credited.
 */
async function findReferrer(code) {
    const staffCode = normalizeStaffCode(code);
    if (!STAFF_CODE.test(staffCode)) return null;
    requireDb();
    const { data, error } = await supabase.from(TABLE).select('id, staff_code, full_name, active').eq('staff_code', staffCode).maybeSingle();
    if (error) throw dbError(error, 'Could not check the referral link.');
    return data?.active ? { id: data.id, staff_code: data.staff_code, full_name: data.full_name } : null;
}

// ── Roster (KYC reviewers) ─────────────────────────────────────────────

/**
 * Staff roster fields. Errors are plain English (staff UI).
 * Staff ID cannot change after creation (registrations keep it).
 */
function validateStaff(body = {}, { creating = false } = {}) {
    const values = {};
    const errors = {};
    if (creating) {
        values.staff_code = normalizeStaffCode(body.staff_code);
        if (!values.staff_code) errors.staff_code = 'Enter a Staff ID.';
        else if (!STAFF_CODE.test(values.staff_code)) errors.staff_code = 'Use 2–20 letters, digits or dashes, e.g. SE-014.';
    }
    if (creating || 'full_name' in body) {
        values.full_name = String(body.full_name ?? '').replace(/\s+/g, ' ').trim();
        if (values.full_name.length < 2 || values.full_name.length > 120) errors.full_name = 'Enter the staff member\'s name (2–120 characters).';
    }
    if ('phone' in body) {
        const phone = normalizeMobile(body.phone);
        values.phone = phone || null;
        if (phone && !/^[6-9][0-9]{9}$/.test(phone)) errors.phone = 'Enter a 10-digit mobile number, or leave it empty.';
    }
    if (creating || (body.pin !== undefined && body.pin !== '')) {
        const pin = String(body.pin ?? '').trim();
        if (!PIN.test(pin)) errors.pin = 'The PIN must be 4–8 digits.';
        else values.pin_hash = hashPin(pin);
    }
    if ('target_count' in body) {
        const text = String(body.target_count ?? '').trim();
        const count = Number(text);
        values.target_count = text ? count : null;
        if (text && (!Number.isInteger(count) || count < 1 || count > 100000)) errors.target_count = 'The target must be a whole number from 1, or empty for no target.';
    }
    if ('target_period' in body || creating) {
        values.target_period = TARGET_PERIODS.includes(body.target_period) ? body.target_period : 'month';
    }
    // State of operation can change; the Employee ID keeps the state it was issued for.
    if ('state' in body) {
        const { STATE_CODES } = require('./employeeRegistration');
        values.state = String(body.state ?? '').trim() || null;
        values.state_code = values.state ? STATE_CODES[values.state] || null : null;
        if (values.state && !values.state_code) errors.state = 'Choose a state from the list.';
    }
    if ('email' in body) {
        values.email = String(body.email ?? '').trim().toLowerCase() || null;
        if (values.email && (values.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email))) errors.email = 'Enter a valid email, or leave it empty.';
    }
    if ('active' in body) values.active = body.active === true || body.active === 'true';
    else if (creating) values.active = true;
    const accountEmail = 'account_email' in body ? String(body.account_email ?? '').trim().toLowerCase() : undefined;
    if (accountEmail && (accountEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(accountEmail))) errors.account_email = 'Enter a valid email, or leave it empty.';
    return { values, accountEmail, errors };
}

async function accountEmails() {
    const { data, error } = await supabase.rpc('technician_staff_account_emails');
    if (error) {
        if (!missingSchema(error)) console.error(`[technician-staff] account emails: ${error.message}`);
        return new Map();
    }
    return new Map((data || []).map((row) => [row.staff_id, row.email]));
}

// Only these fields ever leave the server (never pin_hash or the lock-out state).
const PUBLIC_FIELDS = PUBLIC_COLUMNS.split(',').map((column) => column.trim());
const publicRow = (row) => Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, row[field] ?? null]));

async function listStaff() {
    requireDb();
    const { data, error } = await supabase.from(TABLE).select(PUBLIC_COLUMNS).order('staff_code', { ascending: true });
    if (error) throw dbError(error, 'Could not load the staff list.');
    const emails = await accountEmails();
    return (data || []).map((row) => ({ ...publicRow(row), account_email: row.auth_user_id ? emails.get(row.id) || null : null }));
}

async function getStaff(id) {
    if (!UUID.test(String(id || ''))) throw new KycError('Staff member not found.', 404, 'TECH_STAFF_NOT_FOUND');
    requireDb();
    const { data, error } = await supabase.from(TABLE).select(PUBLIC_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw dbError(error, 'Could not load the staff member.');
    if (!data) throw new KycError('Staff member not found.', 404, 'TECH_STAFF_NOT_FOUND');
    return publicRow(data);
}

async function linkAccount(id, email) {
    if (email === undefined) return null;
    if (!email) {
        const { error } = await supabase.from(TABLE).update({ auth_user_id: null }).eq('id', id);
        if (error) throw dbError(error, 'Could not unlink the app account.');
        return null;
    }
    const { data, error } = await supabase.rpc('technician_staff_link_account', { p_staff_id: id, p_email: email });
    if (error) {
        if (error.code === '23505') return { account_email: 'That app account is already linked to another staff member.' };
        throw dbError(error, 'Could not link the app account.');
    }
    return data ? null : { account_email: 'No app account uses this email. The staff member can still register with their Staff ID and PIN.' };
}

async function createStaff(body, actor = {}) {
    requireDb();
    const { values, accountEmail, errors } = validateStaff(body, { creating: true });
    if (Object.keys(errors).length) return { errors };
    const { data: existing, error: lookupError } = await supabase.from(TABLE).select('id').eq('staff_code', values.staff_code).maybeSingle();
    if (lookupError) throw dbError(lookupError, 'Could not add the staff member.');
    if (existing) return { errors: { staff_code: 'This Staff ID is already used.' } };
    const row = {
        id: crypto.randomUUID(),
        ...values,
        created_by: UUID.test(String(actor.id || '')) ? actor.id : null,
        created_by_email: actor.email || null,
        updated_by_email: actor.email || null,
    };
    const { data, error } = await supabase.from(TABLE).insert(row).select('id').single();
    if (error) {
        if (error.code === '23505') return { errors: { staff_code: 'This Staff ID is already used.' } };
        throw dbError(error, 'Could not add the staff member.');
    }
    const linkErrors = await linkAccount(data.id, accountEmail || undefined);
    const [staff] = (await listStaff()).filter((item) => item.id === data.id);
    return { staff, errors: linkErrors || undefined };
}

async function updateStaff(id, body, actor = {}) {
    await getStaff(id);
    const { values, accountEmail, errors } = validateStaff(body);
    if (Object.keys(errors).length) return { errors };
    const changes = { ...values, updated_by_email: actor.email || null };
    // A new PIN also clears a lock-out.
    if (values.pin_hash) Object.assign(changes, { pin_failed_count: 0, pin_locked_until: null });
    const { error } = await supabase.from(TABLE).update(changes).eq('id', id);
    if (error) throw dbError(error, 'Could not save the staff member.');
    const linkErrors = await linkAccount(id, accountEmail);
    const [staff] = (await listStaff()).filter((row) => row.id === id);
    return { staff, errors: linkErrors || undefined };
}

/**
 * Delete a staff member who never registered a partner. Anyone with
 * registrations is kept (attribution is history): deactivate them instead.
 * The database also retires a SEPL- Employee ID so it is never issued again.
 */
async function deleteStaff(id, actor = {}) {
    const staff = await getStaff(id);
    const { data, error } = await supabase.rpc('delete_technician_staff', { p_staff_id: id });
    // 23503: a registration arrived between the check and the delete.
    if (error && error.code !== '23503') throw dbError(error, 'Could not delete the staff member.');
    if (data === 'not_found') throw new KycError('Staff member not found.', 404, 'TECH_STAFF_NOT_FOUND');
    if (data !== 'deleted') {
        throw new KycError(`${staff.full_name} (${staff.staff_code}) has registered partners, so they cannot be deleted. Deactivate them instead; their history stays.`, 409, 'TECH_STAFF_HAS_REGISTRATIONS');
    }
    console.log(`[technician-staff] ${staff.staff_code} deleted by ${actor.email || 'unknown'}`);
    return staff;
}

// ── Performance ────────────────────────────────────────────────────────

/** Start/end (ISO) of the current day, week (Monday start) or month in India time. */
function periodWindow(period, now = new Date()) {
    const ist = new Date(now.getTime() + IST_OFFSET_MS);
    const [y, m, d] = [ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()];
    let start;
    let end;
    if (period === 'month') {
        start = Date.UTC(y, m, 1);
        end = Date.UTC(y, m + 1, 1);
    } else if (period === 'week') {
        start = Date.UTC(y, m, d - ((ist.getUTCDay() + 6) % 7));
        end = start + 7 * 86400000;
    } else {
        start = Date.UTC(y, m, d);
        end = start + 86400000;
    }
    return { period, start: new Date(start - IST_OFFSET_MS).toISOString(), end: new Date(end - IST_OFFSET_MS).toISOString() };
}

async function allRegistrations() {
    const rows = [];
    for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
        const { data, error } = await supabase.from(REGISTRATIONS)
            .select('id, mobile, submitted_at, status, registration_source, staff_id')
            .order('submitted_at', { ascending: true })
            .order('id', { ascending: true })
            .range(offset, offset + PAGE - 1);
        if (error) throw dbError(error, 'Could not load the staff report.');
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return rows;
}

/** Registration ids that count toward a staff target (see the header). */
function creditedIds(rows) {
    const first = new Map();
    for (const row of rows) {
        if (row.status === 'rejected' || first.has(row.mobile)) continue;
        first.set(row.mobile, row);
    }
    return new Set([...first.values()].filter((row) => ATTRIBUTED.includes(row.registration_source) && row.staff_id).map((row) => row.id));
}

function readRange(query = {}) {
    return { from: indiaDayStart(query.from), to: indiaDayStart(query.to, 1) };
}

/**
 * Per-staff counts for [from, to) plus each target's current period.
 * @param {{ from?: string|null, to?: string|null }} range ISO bounds (null = open)
 */
async function performance(range = {}, { now = new Date() } = {}) {
    requireDb();
    const roster = await listStaff();
    const rows = await allRegistrations();
    const credited = creditedIds(rows);
    const inRange = (row, from, to) => (!from || row.submitted_at >= from) && (!to || row.submitted_at < to);

    // submitted = every registration credited to that staff member's name
    // (Staff mode + personal link), split into staff_mode and referrals.
    const blank = () => ({ submitted: 0, staff_mode: 0, referrals: 0, credited: 0, duplicates: 0, approved: 0, rejected: 0 });
    const byStaff = new Map(roster.map((staff) => [staff.id, blank()]));
    const totals = { all: 0, self: 0, referral: 0, staff: 0, credited: 0 };
    for (const row of rows) {
        if (!inRange(row, range.from, range.to)) continue;
        totals.all++;
        if (!ATTRIBUTED.includes(row.registration_source)) { totals.self++; continue; }
        totals[row.registration_source]++;
        const counts = byStaff.get(row.staff_id);
        if (!counts) continue;
        counts.submitted++;
        if (row.registration_source === 'staff') counts.staff_mode++;
        else counts.referrals++;
        if (row.status === 'approved') counts.approved++;
        if (row.status === 'rejected') counts.rejected++;
        else if (credited.has(row.id)) { counts.credited++; totals.credited++; }
        else counts.duplicates++;
    }

    const staff = roster.map((member) => {
        let target = null;
        if (member.target_count) {
            const window = periodWindow(member.target_period, now);
            const done = rows.filter((row) => row.staff_id === member.id && credited.has(row.id) && inRange(row, window.start, window.end)).length;
            target = { ...window, target: member.target_count, credited: done, percent: Math.round((done / member.target_count) * 1000) / 10, met: done >= member.target_count };
        }
        return {
            id: member.id,
            staff_code: member.staff_code,
            full_name: member.full_name,
            active: member.active,
            ...byStaff.get(member.id),
            target,
        };
    });
    staff.sort((a, b) => b.credited - a.credited || b.submitted - a.submitted || a.staff_code.localeCompare(b.staff_code));
    return { range: { from: range.from || null, to: range.to || null }, totals, staff };
}

module.exports = {
    TABLE,
    TARGET_PERIODS,
    normalizeStaffCode,
    hashPin,
    pinMatches,
    newPinProblem,
    newPinFields,
    authUserFromRequest,
    resolveStaff,
    attributionFor,
    findReferrer,
    ATTRIBUTED,
    allRegistrations,
    validateStaff,
    listStaff,
    createStaff,
    updateStaff,
    deleteStaff,
    periodWindow,
    creditedIds,
    readRange,
    performance,
};
