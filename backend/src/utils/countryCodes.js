// =============================================================
// Country dial codes + phone normalization helpers.
//
// Single source of truth for "which country code gets prepended to
// phone numbers that lack one":
//   • Account-level default: app_settings key DEFAULT_COUNTRY_CODE
//     (per user_id, set from the Settings page).
//   • Per-upload override: countryCode passed alongside an Excel
//     upload (Campaigns flow) — takes precedence over the default.
//   • Env fallback: process.env.DEFAULT_COUNTRY_CODE (legacy), then
//     '91' (India) — preserves the pre-multi-tenant behavior.
//
// Keep this module dependency-free (no db import at require time) so
// smoke tests can load it in isolation.
// =============================================================

// Static list of supported countries: name + international dial code.
// Not exhaustive — covers the major markets this app's tenants target.
// NOTE: the United States and Canada deliberately both appear (both +1).
const COUNTRIES = [
    { name: 'India', dialCode: '91' },
    { name: 'United States', dialCode: '1' },
    { name: 'United Kingdom', dialCode: '44' },
    { name: 'United Arab Emirates', dialCode: '971' },
    { name: 'Australia', dialCode: '61' },
    { name: 'Canada', dialCode: '1' },
    { name: 'Nigeria', dialCode: '234' },
    { name: 'Kenya', dialCode: '254' },
    { name: 'South Africa', dialCode: '27' },
    { name: 'Singapore', dialCode: '65' },
    { name: 'Saudi Arabia', dialCode: '966' },
    { name: 'Qatar', dialCode: '974' },
    { name: 'Kuwait', dialCode: '965' },
    { name: 'Bahrain', dialCode: '973' },
    { name: 'Oman', dialCode: '968' },
    { name: 'Egypt', dialCode: '20' },
    { name: 'Pakistan', dialCode: '92' },
    { name: 'Bangladesh', dialCode: '880' },
    { name: 'Sri Lanka', dialCode: '94' },
    { name: 'Nepal', dialCode: '977' },
    { name: 'Malaysia', dialCode: '60' },
    { name: 'Indonesia', dialCode: '62' },
    { name: 'Philippines', dialCode: '63' },
    { name: 'Thailand', dialCode: '66' },
    { name: 'Vietnam', dialCode: '84' },
    { name: 'China', dialCode: '86' },
    { name: 'Hong Kong', dialCode: '852' },
    { name: 'Japan', dialCode: '81' },
    { name: 'South Korea', dialCode: '82' },
    { name: 'Israel', dialCode: '972' },
    { name: 'Turkey', dialCode: '90' },
    { name: 'Russia', dialCode: '7' },
    { name: 'Germany', dialCode: '49' },
    { name: 'France', dialCode: '33' },
    { name: 'Italy', dialCode: '39' },
    { name: 'Spain', dialCode: '34' },
    { name: 'Netherlands', dialCode: '31' },
    { name: 'Switzerland', dialCode: '41' },
    { name: 'Brazil', dialCode: '55' },
    { name: 'Mexico', dialCode: '52' },
    { name: 'Argentina', dialCode: '54' },
    { name: 'New Zealand', dialCode: '64' },
    { name: 'Ghana', dialCode: '233' },
    { name: 'Tanzania', dialCode: '255' },
    { name: 'Uganda', dialCode: '256' },
];

// Dial codes sorted longest-first so prefix matching prefers the most
// specific code (e.g. '971' wins over a hypothetical '97').
const DIAL_CODES = [...new Set(COUNTRIES.map((c) => c.dialCode))].sort((a, b) => b.length - a.length);

// Ultimate fallback — matches the historical DEFAULT_COUNTRY_CODE=91
// behavior and keeps the existing Sudarshan Pipes account unchanged.
const FALLBACK_COUNTRY_CODE = '91';

/** True when `dialCode` is a plausible dial code we recognize. */
function isValidDialCode(dialCode) {
    return typeof dialCode === 'string' && /^\d{1,4}$/.test(dialCode) && DIAL_CODES.includes(dialCode);
}

/**
 * Normalize a dial-code input from an untrusted request body.
 * Returns the dial code digits, or null when absent/invalid.
 */
function sanitizeDialCode(input) {
    const clean = String(input ?? '').replace(/[^\d]/g, '');
    return isValidDialCode(clean) ? clean : null;
}

function findCountry(dialCode) {
    return COUNTRIES.find((c) => c.dialCode === dialCode) || null;
}

/**
 * Decide whether an already-cleaned (digits-only) phone number appears to
 * include a country code, so we DON'T double-prepend.
 *
 * Heuristic (documented, deterministic):
 *   • A leading '+' on the ORIGINAL string always means international
 *     format — the digits are already complete.
 *   • A leading '00' is the international dial-out prefix — strip it and
 *     treat the rest as complete.
 *   • Otherwise the number must be at least 11 digits AND start with a
 *     recognized dial code AND leave a plausible subscriber number
 *     (>= 7 digits) behind. This keeps bare 10-digit national numbers
 *     (e.g. 9876543210) out of the "has code" bucket even when they
 *     happen to start with dial-code digits ("91…").
 */
function _appearsToHaveCountryCode(rawPhone, cleanDigits) {
    if (typeof rawPhone === 'string' && rawPhone.trim().startsWith('+')) return true;
    if (cleanDigits.startsWith('00')) return true;
    if (cleanDigits.length < 11) return false;
    for (const code of DIAL_CODES) {
        if (cleanDigits.startsWith(code) && cleanDigits.length - code.length >= 7) return true;
    }
    return false;
}

/**
 * Prepend `countryCode` to a phone number unless it already looks like it
 * carries one. Returns digits only (non-digits stripped).
 *
 * Also handles national trunk prefixes: UK-style numbers written locally as
 * "07700900123" (or India's "09876543210") carry a leading '0' that is not
 * part of the E.164 number. That single '0' is stripped BEFORE the dial code
 * is prepended, and the stripped value is re-checked for an embedded code so
 * e.g. "091987654321" still resolves to 919876543210 — not a double prefix.
 *
 * @param {string} phone - Raw phone value (may contain +, spaces, dashes…)
 * @param {string|null} countryCode - Dial code to prepend, e.g. '91'
 * @returns {string}
 */
function ensureCountryCode(phone, countryCode) {
    const raw = String(phone ?? '');
    const clean = raw.replace(/[^\d]/g, '');
    if (!clean) return '';
    if (_appearsToHaveCountryCode(raw, clean)) {
        // Strip a leading '00' international prefix; the country code follows it.
        return clean.replace(/^00/, '');
    }
    const code = sanitizeDialCode(countryCode);
    if (!code) return clean; // nothing to prepend — keep legacy digits-only form
    // Drop one national trunk '0', then re-check for an embedded country code
    // in the remainder (e.g. "091987654321" → "919876543210" is already intl).
    const trunkStripped = clean.replace(/^0/, '');
    if (trunkStripped && _appearsToHaveCountryCode(raw, trunkStripped)) return trunkStripped;
    return `${code}${trunkStripped || clean}`;
}

/**
 * Resolve the effective country code for a user, in precedence order:
 *   1. explicit override (per-upload selection, already validated upstream)
 *   2. the user's stored app_settings row (key DEFAULT_COUNTRY_CODE)
 *   3. process.env.DEFAULT_COUNTRY_CODE
 *   4. '91' (India) — historical default
 *
 * DB access is lazy-required so this module stays import-safe in tests and
 * the require graph stays acyclic (db.js never imports utils).
 *
 * @param {string|null} userId - Owner of the settings row
 * @param {string|null} override - Per-upload dial code (validated if given)
 * @returns {Promise<string>} dial code digits, e.g. '91'
 */
async function resolveCountryCode(userId, override = null) {
    const safeOverride = sanitizeDialCode(override);
    if (safeOverride) return safeOverride;

    try {
        const db = require('../database/db');
        if (db.isAvailable() && userId) {
            const row = await db.getOne('app_settings', 'key', 'DEFAULT_COUNTRY_CODE', userId);
            const stored = sanitizeDialCode(row?.value);
            if (stored) return stored;
        }
    } catch (error) {
        // Missing table or db hiccup must never block an upload — fall through.
        console.error('[countryCodes] failed to load account default:', error.message);
    }

    return sanitizeDialCode(process.env.DEFAULT_COUNTRY_CODE) || FALLBACK_COUNTRY_CODE;
}

/**
 * Human-readable line for upload confirmations, e.g.
 * "342 contacts found. Numbers will be formatted as +91 XXXXXXXXXX unless
 * they already include a country code."
 */
function formattingNotice(contactCount, dialCode) {
    const count = Number(contactCount) || 0;
    return `${count} contact${count === 1 ? '' : 's'} found. Numbers will be formatted as +${dialCode} XXXXXXXXXX unless they already include a country code.`;
}

module.exports = {
    COUNTRIES,
    DIAL_CODES,
    FALLBACK_COUNTRY_CODE,
    isValidDialCode,
    sanitizeDialCode,
    findCountry,
    ensureCountryCode,
    resolveCountryCode,
    formattingNotice,
};
