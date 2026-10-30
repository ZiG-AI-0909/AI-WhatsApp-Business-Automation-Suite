'use strict';

// Employee self-registration (public link /employee-registration). A
// prospective employee enters name, mobile, state of operation and email
// (required); public.register_employee() (see
// supabase-employee-registration-migration.sql) allocates the Employee ID
// SEPL-{STATE}{NNN} from a per-state counter and inserts the roster row in
// one transaction, so concurrent registrations never share an ID.
//
// The initial PIN is the last 4 digits of the mobile number. It is hashed
// like every staff PIN (technicianStaff.hashPin), flagged pin_must_change,
// and returned only in the response to the registration itself — never by
// a lookup, a list or a log line.

const { supabase, isAvailable } = require('../database/supabaseClient');
const { KycError, isMissingSchema } = require('../kyc/kycService');
const { normalizeMobile } = require('./technicianSchema');
const { hashPin } = require('./technicianStaff');

// The 28 states of India and their Employee ID codes.
const STATE_CODES = {
    'Andhra Pradesh': 'AP',
    'Arunachal Pradesh': 'AR',
    Assam: 'AS',
    Bihar: 'BR',
    Chhattisgarh: 'CG',
    Goa: 'GA',
    Gujarat: 'GJ',
    Haryana: 'HR',
    'Himachal Pradesh': 'HP',
    Jharkhand: 'JH',
    Karnataka: 'KA',
    Kerala: 'KL',
    'Madhya Pradesh': 'MP',
    Maharashtra: 'MH',
    Manipur: 'MN',
    Meghalaya: 'ML',
    Mizoram: 'MZ',
    Nagaland: 'NL',
    Odisha: 'OD',
    Punjab: 'PB',
    Rajasthan: 'RJ',
    Sikkim: 'SK',
    'Tamil Nadu': 'TN',
    Telangana: 'TS',
    Tripura: 'TR',
    'Uttar Pradesh': 'UP',
    Uttarakhand: 'UK',
    'West Bengal': 'WB',
};
const STATES = Object.keys(STATE_CODES);

const MIGRATION_MESSAGE = 'Employee registration needs a database update: run supabase-employee-registration-migration.sql in the Supabase SQL Editor.';
const DUPLICATE_MESSAGE = 'This mobile number is already registered. If you have lost your Employee ID or PIN, please contact your manager.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOBILE = /^[6-9][0-9]{9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** SEPL-TN001 … SEPL-TN999, then SEPL-TN1000 (never truncated). Mirrors register_employee(). */
const formatEmployeeId = (stateCode, sequence) => `SEPL-${stateCode}${String(sequence).padStart(3, '0')}`;

/** Initial PIN: last 4 digits of the normalised 10-digit mobile number. */
const pinFromMobile = (mobile) => normalizeMobile(mobile).slice(-4);

const maskMobile = (mobile) => {
    const digits = normalizeMobile(mobile);
    return digits.length === 10 ? `+91 ${'•'.repeat(6)}${digits.slice(-4)}` : '';
};

/**
 * Registration fields. Errors are plain English (the form is English-only).
 * @returns {{ values: object, errors: object }}
 */
function validateEmployee(body = {}) {
    const values = {};
    const errors = {};
    values.full_name = String(body.full_name ?? '').replace(/\s+/g, ' ').trim();
    if (!values.full_name) errors.full_name = 'Enter your full name.';
    else if (values.full_name.length < 2 || values.full_name.length > 120) errors.full_name = 'Your name must be 2–120 characters.';
    else if (!/\p{L}/u.test(values.full_name) || /[<>{}\\]/.test(values.full_name)) errors.full_name = 'Enter your name using letters.';

    values.phone = normalizeMobile(body.mobile);
    if (!values.phone) errors.mobile = 'Enter your mobile number.';
    else if (!MOBILE.test(values.phone)) errors.mobile = 'Enter a valid 10-digit Indian mobile number (starting with 6, 7, 8 or 9).';

    values.state = String(body.state ?? '').trim();
    values.state_code = STATE_CODES[values.state] || null;
    if (!values.state) errors.state = 'Choose your state of operation.';
    else if (!values.state_code) errors.state = 'Choose a state from the list.';

    values.email = String(body.email ?? '').trim().toLowerCase();
    if (!values.email) errors.email = 'Enter your email address.';
    else if (values.email.length > 254 || !EMAIL.test(values.email)) errors.email = 'Enter a valid email address.';
    return { values, errors };
}

/**
 * Register an employee. A retry of the same submission (same client id and
 * mobile) returns the same Employee ID instead of creating a second one.
 * @returns {{ employee?: object, pin?: string, duplicate?: boolean, errors?: object }}
 */
async function registerEmployee(body = {}, { clientId } = {}) {
    const { values, errors } = validateEmployee(body);
    if (Object.keys(errors).length) return { errors };
    if (!isAvailable() || !supabase) throw new KycError('The database is not configured.', 503, 'KYC_UNAVAILABLE');

    const pin = pinFromMobile(values.phone);
    const { data, error } = await supabase.rpc('register_employee', {
        p_full_name: values.full_name,
        p_phone: values.phone,
        p_email: values.email || null,
        p_state: values.state,
        p_state_code: values.state_code,
        p_pin_hash: hashPin(pin),
        p_client_id: UUID.test(String(clientId || '')) ? String(clientId).toLowerCase() : null,
    });
    if (error) {
        if (error.code === '23505') throw new KycError(DUPLICATE_MESSAGE, 409, 'EMPLOYEE_DUPLICATE');
        if (isMissingSchema(error) || error.code === '42703') throw new KycError(MIGRATION_MESSAGE, 503, 'TECH_MIGRATION_PENDING');
        console.error(`[employee] registration failed: ${error.code || ''} ${error.message || error}`);
        throw new KycError('Your registration could not be saved. Please try again.', 500, 'EMPLOYEE_DB_ERROR');
    }
    const row = Array.isArray(data) ? data[0] : data;
    // A repeated client id with a different mobile is not the same submission.
    if (!row || row.outcome === 'duplicate' || (row.outcome === 'repeat' && row.phone !== values.phone)) {
        throw new KycError(DUPLICATE_MESSAGE, 409, 'EMPLOYEE_DUPLICATE');
    }
    return {
        duplicate: row.outcome === 'repeat',
        pin,
        employee: {
            employee_id: row.staff_code,
            full_name: values.full_name,
            state: values.state,
            mobile_masked: maskMobile(values.phone),
            registered_at: row.created_at || null,
        },
    };
}

/** Roster rows matching the management screen's search box and state filter. */
function filterEmployees(rows, { q = '', state = '' } = {}) {
    const needle = String(q).trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    return rows.filter((row) => (!state || row.state === state)
        && (!needle
            || [row.staff_code, row.full_name, row.state, row.email].some((value) => String(value || '').toLowerCase().includes(needle))
            || (digits.length >= 3 && String(row.phone || '').includes(digits))));
}

module.exports = {
    STATE_CODES,
    STATES,
    formatEmployeeId,
    pinFromMobile,
    maskMobile,
    validateEmployee,
    registerEmployee,
    filterEmployees,
};
