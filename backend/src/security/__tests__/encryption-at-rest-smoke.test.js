// =============================================================
// Security smoke test — encryption at rest (secrets never plaintext).
//
// Proves, WITHOUT real Supabase:
//   1. Saving settings through the NORMAL app flow (PUT /api/settings)
//      stores secret-bearing values as ciphertext, NOT plaintext —
//      inspected at the raw stored-value level.
//   2. Reading back through the NORMAL flow decrypts to the original
//      value (AI path via getUserSettings(), email path via the mocked
//      Resend client receiving the real key).
//   3. The WhatsApp auth_state written by the real store is ciphertext
//      in the raw row and round-trips back to identical Buffers.
//   4. ENCRYPTION_KEY is enforced: encrypt()/decrypt() refuse to run
//      without it (fail loud, never silently plaintext).
//   5. Legacy plaintext values still decrypt via passthrough (pre-
//      migration rows keep working until the migration script runs).
//
// Run: node backend/src/security/__tests__/encryption-at-rest-smoke.test.js
// =============================================================
const assert = require('assert');

// The key under test (64 hex chars = 32 bytes for AES-256).
const TEST_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
process.env.ENCRYPTION_KEY = TEST_KEY;

// ---- Shared in-memory Supabase mock (injected at the client boundary) ----
const state = { rows: {} };

function table(name) {
    if (!state.rows[name]) state.rows[name] = [];
    return {
        rows: state.rows[name],
        select(_cols, _options = {}) {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push({ col, val }); return builder; },
                order() { return builder; },
                limit() { return builder; },
                range() { return builder; },
                maybeSingle: async () => ({
                    data: state.rows[name].find((r) => filters.every((f) => r[f.col] === f.val)) || null,
                    error: null,
                }),
                single: async () => ({
                    data: state.rows[name].find((r) => filters.every((f) => r[f.col] === f.val)) || null,
                    error: null,
                }),
                async then(resolve) {
                    return resolve({ data: state.rows[name].filter((r) => filters.every((f) => r[f.col] === f.val)), error: null });
                },
            };
            return builder;
        },
        insert(row) {
            return {
                select() {
                    return {
                        single: async () => {
                            const stored = { ...row, id: state.rows[name].length + 1 };
                            // Composite PK (user_id, key) upsert emulation.
                            const idx = state.rows[name].findIndex((r) => r.user_id === row.user_id && r.key === row.key);
                            if (idx >= 0) state.rows[name][idx] = { ...state.rows[name][idx], ...row };
                            else state.rows[name].push(stored);
                            return { data: stored, error: null };
                        },
                    };
                },
            };
        },
        upsert(row) {
            // Composite PK (user_id) upsert emulation for whatsapp_sessions.
            const idx = state.rows[name].findIndex((r) => r.user_id === row.user_id);
            if (idx >= 0) state.rows[name][idx] = { ...state.rows[name][idx], ...row };
            else state.rows[name].push({ ...row });
            return Promise.resolve({ data: row, error: null });
        },
        update(_data) {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push({ col, val }); return builder; },
                select: async () => {
                    state.rows[name] = state.rows[name].map((r) =>
                        filters.every((f) => r[f.col] === f.val) ? { ...r, ..._data } : r);
                    return { data: state.rows[name].filter((r) => filters.every((f) => r[f.col] === f.val)), error: null };
                },
            };
            return builder;
        },
    };
}

// Inject BEFORE requiring modules that use supabaseClient.
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

// Mock the Resend SDK so the email read-back test can observe the key
// that actually reaches the provider.
const resendModulePath = require.resolve('resend');
class MockResend {
    constructor(apiKey) { state.lastResendKey = apiKey; this.emails = { send: async () => ({ data: { id: 'x' }, error: null }) }; }
}
require.cache[resendModulePath] = {
    id: resendModulePath,
    filename: resendModulePath,
    loaded: true,
    exports: { Resend: MockResend, default: MockResend },
};

process.env.SUPABASE_URL = 'https://mock.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'mock-secret';

// ---- Load the real modules ----
const { encrypt, decrypt, isEncrypted, assertEncryptionKey } = require('../../utils/encryption');
const settingsRoute = require('../../routes/settings');
const incomingMessageService = require('../../conversations/incomingMessageService');
const authStateStore = require('../../whatsapp/authStateStore');

const USER = '55555555-5555-5555-5555-555555555501';

function findRoute(router, method, path) {
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods?.[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} route exists`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeReqRes(user, body) {
    const req = { user, body: body || {}, query: {}, headers: {} };
    let statusCode = null;
    const res = {
        json: (data) => { statusCode = 200; state.lastResponse = data; },
        status(code) { statusCode = code; return { json: (d) => { state.lastResponse = d; } }; },
    };
    return { req, res, getStatus: () => statusCode };
}

const SECRET_VALUE = 'sk-super-secret-tenant-key-DO-NOT-STORE-PLAINTEXT-9876';

async function test1_settingsStoredEncryptedNotPlaintext() {
    console.log('▶ Test 1: normal settings save stores ciphertext, never plaintext');
    const putHandler = findRoute(settingsRoute, 'put', '/');
    const call = makeReqRes({ id: USER, email: 'owner@example.com' }, {
        aiApiKey: SECRET_VALUE,
        resendApiKey: 're_send_secret_email_key_123456',
        resendFromEmail: 'hello@domain-a.com',
        businessName: 'Sudarshan Pipes', // non-secret control value
    });
    await putHandler(call.req, call.res);
    assert.strictEqual(call.getStatus(), 200, `PUT succeeded (${state.lastResponse?.error || ''})`);

    // Inspect the RAW stored rows.
    const rawRows = state.rows.app_settings.filter((r) => r.user_id === USER);
    const aiRow = rawRows.find((r) => r.key === 'AI_API_KEY');
    const resendRow = rawRows.find((r) => r.key === 'RESEND_API_KEY');
    const nameRow = rawRows.find((r) => r.key === 'BUSINESS_NAME');

    assert.ok(aiRow && resendRow, 'secret rows stored');
    assert.ok(isEncrypted(aiRow.value), 'AI_API_KEY stored value carries the versioned ciphertext prefix');
    assert.ok(isEncrypted(resendRow.value), 'RESEND_API_KEY stored value carries the ciphertext prefix');
    assert.ok(!aiRow.value.includes(SECRET_VALUE), 'raw AI_API_KEY row does NOT contain the plaintext secret');
    assert.ok(!JSON.stringify(rawRows).includes(SECRET_VALUE), 'NO raw app_settings row contains the plaintext secret');
    assert.strictEqual(nameRow.value, 'Sudarshan Pipes', 'non-secret values stay plaintext (only secrets encrypted)');
    assert.notStrictEqual(aiRow.value, SECRET_VALUE, 'stored value differs from plaintext');
    console.log('✅ Test 1 passed\n');
}

async function test2_decryptOnNormalReadBack() {
    console.log('▶ Test 2: normal read-back paths decrypt to the original value');
    // AI path: the exact reader the AI request flow uses.
    const aiSettings = await incomingMessageService.getUserSettings(USER);
    assert.strictEqual(aiSettings.AI_API_KEY, SECRET_VALUE, 'getUserSettings() returns the DECRYPTED key for the AI path');

    // Email path: the mocked Resend client must receive the real key.
    const resendService = require('../../email/resendService');
    await resendService.getConfig(USER);
    await resendService.sendTestEmail(USER, 'owner@example.com');
    assert.strictEqual(state.lastResendKey, 're_send_secret_email_key_123456', 'Resend send uses the decrypted key');
    console.log('✅ Test 2 passed\n');
}

async function test3_authStateEncryptedAtRestAndRoundTrips() {
    console.log('▶ Test 3: WhatsApp auth_state is ciphertext at rest and round-trips');
    const auth = await authStateStore.useSupabaseAuthState(USER);
    const noiseKeyBytes = Buffer.from('session-noise-key-bytes-XYZ');
    auth.state.creds = { noiseKey: noiseKeyBytes, registrationId: 4242 };
    await auth.flush();

    const rawRow = state.rows.whatsapp_sessions.find((r) => r.user_id === USER);
    assert.ok(rawRow, 'row written');
    const storedValue = rawRow.auth_state;
    assert.ok(isEncrypted(storedValue), 'stored auth_state is versioned ciphertext');
    assert.ok(!storedValue.includes('session-noise-key-bytes-XYZ'), 'raw stored value does NOT contain the plaintext key material');
    assert.ok(!storedValue.includes('registrationId'), 'raw stored value leaks no JSON structure');

    // Fresh read through the normal flow restores the exact Buffers.
    const auth2 = await authStateStore.useSupabaseAuthState(USER);
    assert.ok(Buffer.isBuffer(auth2.state.creds.noiseKey), 'noiseKey revived as Buffer');
    assert.strictEqual(auth2.state.creds.noiseKey.toString('utf8'), 'session-noise-key-bytes-XYZ', 'key material round-trips');
    assert.strictEqual(auth2.state.creds.registrationId, 4242, 'plain values round-trip');
    console.log('✅ Test 3 passed\n');
}

function test4_failsLoudWithoutKey() {
    console.log('▶ Test 4: missing ENCRYPTION_KEY fails loudly (never silent plaintext)');
    delete process.env.ENCRYPTION_KEY;
    try {
        encrypt('x');
        assert.fail('encrypt() without key must throw');
    } catch (error) {
        assert.ok(/ENCRYPTION_KEY is not set/.test(error.message), `encrypt threw the loud error (${error.message.slice(0, 60)}...)`);
    }
    try {
        assertEncryptionKey();
        assert.fail('assertEncryptionKey() without key must throw');
    } catch (error) {
        assert.ok(/ENCRYPTION_KEY is not set/.test(error.message), 'assertEncryptionKey throws the startup error');
    }
    process.env.ENCRYPTION_KEY = TEST_KEY;
    console.log('✅ Test 4 passed\n');
}

async function test5_legacyPlaintextPassthrough() {
    console.log('▶ Test 5: legacy plaintext rows decrypt via passthrough (pre-migration)');
    // Fresh user (getUserSettings caches per userId for 60s).
    const LEGACY_USER = '55555555-5555-5555-5555-555555555502';
    // Seed a legacy row the OLD app wrote (plaintext).
    state.rows.app_settings.push({ user_id: LEGACY_USER, key: 'AI_API_KEY', value: 'sk-legacy-plaintext-key' });
    const settings = await incomingMessageService.getUserSettings(LEGACY_USER);
    assert.strictEqual(settings.AI_API_KEY, 'sk-legacy-plaintext-key', 'legacy plaintext value still readable (migration keeps app working)');
    console.log('✅ Test 5 passed\n');
}

async function main() {
    try {
        await test1_settingsStoredEncryptedNotPlaintext();
        await test2_decryptOnNormalReadBack();
        await test3_authStateEncryptedAtRestAndRoundTrips();
        test4_failsLoudWithoutKey();
        await test5_legacyPlaintextPassthrough();
        console.log('🎉 ALL ENCRYPTION-AT-REST SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
