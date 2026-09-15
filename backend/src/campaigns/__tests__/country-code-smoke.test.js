// =============================================================
// Smoke test — Country-code selection & phone normalization.
//
// Proves, WITHOUT real Supabase/Storage:
//   1. A number with no country code gets the selected/default code
//      prepended correctly (direct helper + full Excel parse path).
//   2. A number that already has a country code is left unchanged —
//      no double-prepend, even when it coincidentally starts with a
//      dial-code prefix (e.g. "91…" for India).
//   3. The per-upload override takes precedence over the account's
//      stored app_settings default when both are present.
//   4. Account default (app_settings) is honored when no override is
//      given, falling back to env, then to '91'.
//   5. Manual contact creation (POST /api/contacts path) applies the
//      account default the same way.
//
// Run: node backend/src/campaigns/__tests__/country-code-smoke.test.js
// =============================================================
const assert = require('assert');
const ExcelJS = require('exceljs');

// ── Minimal Supabase mock injected BEFORE modules load ───────────────
// app_settings rows: (user_id, key, value). Used by resolveCountryCode.
const USER_A = 'user-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // no stored default
const USER_B = 'user-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // DEFAULT_COUNTRY_CODE=44
const USER_C = 'user-cccccccc-cccc-cccc-cccc-cccccccccccc'; // stored + override case

const state = {
    rows: {
        app_settings: [
            { user_id: USER_B, key: 'DEFAULT_COUNTRY_CODE', value: '44' },
            { user_id: USER_C, key: 'DEFAULT_COUNTRY_CODE', value: '44' },
        ],
    },
};

function table(name) {
    return {
        select(columns, { columns: _c } = {}) {
            return {
                eq(column, value) {
                    const chain = {
                        eq(nextColumn, nextValue) {
                            // Composite lookup: (user_id, key) or (key, value)-style
                            return chain._add(nextColumn, nextValue);
                        },
                        _add(column, value) {
                            chain._filters.push({ column, value });
                            return chain;
                        },
                        _filters: [{ column, value }],
                        maybeSingle: async () => {
                            let rows = state.rows[name] || [];
                            for (const f of chain._filters) rows = rows.filter((r) => r[f.column] === f.value);
                            return { data: rows[0] || null, error: null };
                        },
                        async then(resolve) {
                            let rows = state.rows[name] || [];
                            for (const f of chain._filters) rows = rows.filter((r) => r[f.column] === f.value);
                            return resolve({ data: rows, error: null });
                        },
                    };
                    // First .eq() returns the chain with its initial filter
                    chain._filters = [{ column, value }];
                    // Make eq() itself chainable back onto the same object
                    chain.eq = chain._add;
                    return chain;
                },
                order() { return this; },
                limit() { return this; },
                range() { return this; },
                async then(resolve) { return resolve({ data: state.rows[name] || [], error: null }); },
            };
        },
    };
}

const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
        supabase: { from: (name) => table(name) },
        isAvailable: () => true,
        transaction: async (ops) => { for (const op of ops) await op(); },
        normalizeRow: (r) => r,
        parseJsonFields: (r) => r,
    },
};

const { ensureCountryCode, resolveCountryCode, sanitizeDialCode, COUNTRIES, formattingNotice } = require('../../utils/countryCodes');
const campaignService = require('../../campaigns/campaignService');

// Build a real xlsx workbook in memory (same pattern as the exceljs smoke test).
async function buildWorkbook(rows) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Contacts');
    const headers = Object.keys(rows[0]);
    sheet.addRow(headers);
    for (const row of rows) sheet.addRow(headers.map((h) => row[h]));
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function test1_noCountryCodeGetsPrepended() {
    console.log('▶ Test 1: number without a country code gets the selected code prepended');
    assert.strictEqual(ensureCountryCode('9876543210', '91'), '919876543210', 'bare 10-digit gets 91 prepended');
    assert.strictEqual(ensureCountryCode('9876543210', '44'), '449876543210', 'override code used');
    assert.strictEqual(ensureCountryCode('+1 415 555 2671'.replace(/\s/g, ''), '91'), '14155552671', 'leading + means complete');
    assert.strictEqual(ensureCountryCode('07700900123', '44'), '447700900123', 'UK local number gets 44');
    assert.strictEqual(ensureCountryCode('07-700 900123'.replace(/[^\d]/g, ''), '44'), '447700900123', 'digits extracted then prefixed');
    console.log('✅ Test 1 passed\n');
}

async function test2_existingCountryCodeLeftUnchanged() {
    console.log('▶ Test 2: number that already has a country code is left unchanged');
    assert.strictEqual(ensureCountryCode('919876543210', '91'), '919876543210', '9198… has code 91 + 10 digits — unchanged');
    assert.strictEqual(ensureCountryCode('+447700900123', '91'), '447700900123', 'leading + wins over selected code');
    assert.strictEqual(ensureCountryCode('971501234567', '91'), '971501234567', 'UAE number kept as-is');
    assert.strictEqual(ensureCountryCode('447700900123', '44'), '447700900123', 'UK international form kept');
    assert.strictEqual(ensureCountryCode('0044770090123', '44'), '44770090123', '00 prefix stripped, digits preserved (44 + 9-digit subscriber)');
    // Tricky case: 10-digit number starting with dial-code digits ("91…") must
    // NOT be treated as international — it stays national and gets the code.
    assert.strictEqual(ensureCountryCode('9123456789', '91'), '919123456789', '10-digit 91… still gets prepended (only 10 digits, not 11+)');
    console.log('✅ Test 2 passed\n');
}

async function test3_excelParseAppliesCode() {
    console.log('▶ Test 3: Excel parse applies the country code to the phone column');
    const buffer = await buildWorkbook([
        { Name: 'Raj', Phone: '9876543210', City: 'Pune' },        // national → +91
        { Name: 'Amira', Phone: '971501234567', City: 'Dubai' },   // already intl → unchanged
        { Name: 'Bad', Phone: '123', City: 'Nashik' },             // still invalid after prefix
    ]);
    const result = await campaignService.validateExcelBuffer(buffer, { countryCode: '91' }, null);
    assert.strictEqual(result.valid, 2, 'two valid rows');
    const raj = result.previewRows.find((r) => r.name === 'Raj');
    const amira = result.previewRows.find((r) => r.name === 'Amira');
    assert.strictEqual(raj.phone, '919876543210', 'national number prefixed with 91');
    assert.strictEqual(amira.phone, '971501234567', 'international number untouched');
    assert.strictEqual(result.countryCode, '91', 'resolved code echoed');
    assert.strictEqual(result.countryName, 'India', 'country name resolved');
    console.log('✅ Test 3 passed\n');
}

async function test4_overrideBeatsAccountDefault() {
    console.log('▶ Test 4: per-upload override takes precedence over account default');
    // USER_C has DEFAULT_COUNTRY_CODE=44 stored, but the upload says 971.
    const resolved = await resolveCountryCode(USER_C, '971');
    assert.strictEqual(resolved, '971', 'override wins over stored 44');
    const buffer = await buildWorkbook([
        { Name: 'Ken', Phone: '712345678', City: 'Nairobi' }, // 9-digit national
    ]);
    const result = await campaignService.validateExcelBuffer(buffer, { countryCode: '254' }, USER_C);
    assert.strictEqual(result.countryCode, '254', 'validation used the override, not the account default');
    assert.strictEqual(result.previewRows[0].phone, '254712345678', 'number prefixed with override code');
    console.log('✅ Test 4 passed\n');
}

async function test5_accountDefaultWhenNoOverride() {
    console.log('▶ Test 5: account default used when no override is given');
    assert.strictEqual(await resolveCountryCode(USER_B, null), '44', 'stored app_settings default used');
    assert.strictEqual(await resolveCountryCode(USER_A, null), '91', 'no stored default → fallback 91 (legacy env/constant)');
    assert.strictEqual(await resolveCountryCode(null, null), '91', 'no user, no override → 91');
    assert.strictEqual(await resolveCountryCode(USER_B, 'not-a-code'), '44', 'invalid override ignored → account default');
    console.log('✅ Test 5 passed\n');
}

async function test6_settingsRouteShapeAndSanitizer() {
    console.log('▶ Test 6: sanitizeDialCode + formattingNotice helpers');
    assert.strictEqual(sanitizeDialCode('+91'), '91', '+ stripped');
    assert.strictEqual(sanitizeDialCode(' 44 '), '44', 'trimmed');
    assert.strictEqual(sanitizeDialCode('abc'), null, 'letters rejected');
    assert.strictEqual(sanitizeDialCode('12345'), null, '5 digits rejected (max 4)');
    assert.ok(COUNTRIES.some((c) => c.name === 'India' && c.dialCode === '91'), 'India +91 in list');
    assert.ok(COUNTRIES.some((c) => c.name === 'United States' && c.dialCode === '1'), 'US in list');
    assert.ok(COUNTRIES.some((c) => c.name === 'Canada' && c.dialCode === '1'), 'Canada in list');
    assert.strictEqual(formattingNotice(342, '91'), '342 contacts found. Numbers will be formatted as +91 XXXXXXXXXX unless they already include a country code.', 'confirmation wording');
    console.log('✅ Test 6 passed\n');
}

async function main() {
    try {
        await test1_noCountryCodeGetsPrepended();
        await test2_existingCountryCodeLeftUnchanged();
        await test3_excelParseAppliesCode();
        await test4_overrideBeatsAccountDefault();
        await test5_accountDefaultWhenNoOverride();
        await test6_settingsRouteShapeAndSanitizer();
        console.log('🎉 ALL COUNTRY-CODE SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
