// =============================================================
// Email Phase 1 smoke test — per-user Resend settings + test email.
//
// Verifies, WITHOUT real Supabase or a real Resend call:
//   1. GET/PUT /api/settings round-trips the three Resend fields
//      (resendApiKey / resendFromEmail / resendFromName) per user,
//      with users fully isolated; the API key is never echoed back.
//   2. POST /api/settings/email/test sends one test email to the
//      logged-in user's own auth email using their SAVED key and
//      from-address (Resend SDK mocked at the require boundary).
//   3. Failure paths: missing config -> clear message; Resend API
//      error -> the provider's actual message is surfaced
//      (e.g. "The xxx.com domain is not verified").
//
// Run: node backend/src/settings/__tests__/email-phase1-smoke.test.js
// =============================================================
const assert = require('assert');
const path = require('path');

// ---- Shared in-memory Supabase mock (injected at the client boundary) ----
const state = { rows: {}, sendCalls: [], sendImpl: null };

function table(name) {
    if (!state.rows[name]) state.rows[name] = [];
    return {
        rows: state.rows[name],
        select(_cols, options = {}) {
            const filters = [];
            const orders = [];
            const headCount = !!(options.count && options.head);
            let orTerms = null;
            const run = async () => {
                let out = state.rows[name].filter(r => filters.every(f =>
                    f.like
                        ? String(r[f.col] || '').toLowerCase().includes(String(f.val).toLowerCase())
                        : r[f.col] === f.val));
                if (orTerms) {
                    out = out.filter(r => orTerms.some(t =>
                        String(r[t.col] || '').toLowerCase().includes(String(t.value).toLowerCase())));
                }
                for (const o of orders) out = [...out].sort((a, b) => (o.asc ? 1 : -1) * String(a[o.col]).localeCompare(String(b[o.col])));
                return out;
            };
            const builder = {
                eq(col, val) { filters.push({ col, val }); return builder; },
                like(col, pattern) { filters.push({ col, val: String(pattern).replace(/%/g, ''), like: true }); return builder; },
                order(col, opts) { orders.push({ col, asc: opts?.ascending !== false }); return builder; },
                limit(_n) { return builder; },
                range(_a, _b) { return builder; },
                // Minimal PostgREST .or() emulation for the contacts search:
                // "phone.like.*x*,name.like.*x*,..." — substring match per term.
                or(filterString) {
                    orTerms = filterString.split(',').map(term => {
                        const first = term.indexOf('.');
                        const col = term.slice(0, first);
                        const rest = term.slice(first + 1);
                        let value = rest.slice(rest.indexOf('.') + 1);
                        value = value.replace(/\*/g, '');
                        return { col, value };
                    });
                    return builder;
                },
                maybeSingle: async () => ({ data: (await run())[0] || null, error: null }),
                single: async () => {
                    const out = await run();
                    return { data: out[0] || null, error: out.length ? null : { code: 'PGRST116' } };
                },
                async then(resolve) {
                    if (headCount) return resolve({ data: null, error: null, count: (await run()).length });
                    return resolve({ data: await run(), error: null });
                },
            };
            return builder;
        },
        // db.insert() chains .select().single()
        insert(row) {
            const builder = {
                select() {
                    return {
                        single: async () => {
                            const stored = { ...row, id: (state.rows[name].length + 1) };
                            // Simulate the (user_id, key) composite PK upsert.
                            const idx = state.rows[name].findIndex(r => r.user_id === row.user_id && r.key === row.key);
                            if (idx >= 0) state.rows[name][idx] = { ...state.rows[name][idx], ...row };
                            else state.rows[name].push(stored);
                            return { data: stored, error: null };
                        },
                    };
                },
            };
            return builder;
        },
        update(_data) {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push({ col, val }); return builder; },
                select: async () => {
                    state.rows[name] = state.rows[name].map(r =>
                        filters.every(f => r[f.col] === f.val) ? { ...r, ..._data } : r);
                    return { data: state.rows[name].filter(r => filters.every(f => r[f.col] === f.val)), error: null };
                },
            };
            return builder;
        },
    };
}

// Inject the mock BEFORE requiring modules that use supabaseClient.
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

// ---- Mock the Resend SDK BEFORE resendService can lazy-require it ----
// resendService does `require('resend')` inside _getResend(); point the
// module cache at a fake whose send() is controlled per-test.
const resendModulePath = require.resolve('resend');
class MockResend {
    constructor(apiKey) {
        state.lastApiKey = apiKey;
        state.constructorCalls = (state.constructorCalls || 0) + 1;
        this.emails = {
            send: async (payload) => {
                state.sendCalls.push({ apiKey, payload });
                if (state.sendImpl) return state.sendImpl(payload);
                return { data: { id: 'mock-email-id' }, error: null };
            },
        };
    }
}
require.cache[resendModulePath] = {
    id: resendModulePath,
    filename: resendModulePath,
    loaded: true,
    exports: { Resend: MockResend, default: MockResend },
};

// ---- Quiet the routes' dependency on env/AI service ----
process.env.SUPABASE_URL = 'https://mock.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'mock-secret';

const settingsRoute = require('../../routes/settings');
const resendService = require('../../email/resendService');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const EMAIL_A = 'owner-a@example.com';
const EMAIL_B = 'owner-b@example.com';

function makeReqRes(userId, email, body = {}) {
    const req = { user: { id: userId, email }, body };
    let statusCode = null;
    let responseBody = null;
    const res = {
        json: (data) => { responseBody = data; statusCode = statusCode ?? 200; },
        status(code) { statusCode = code; return { json: (d) => { responseBody = d; } }; },
    };
    return {
        req, res,
        get status() { return statusCode; },
        get body() { return responseBody; },
    };
}

// Locate a route layer in the router stack by method + path.
function findRoute(router, method, routePath) {
    const layer = router.stack.find(l => l.route?.path === routePath && l.route?.methods?.[method]);
    assert.ok(layer, `${method.toUpperCase()} ${routePath} route exists`);
    // Route stack: [router-level middleware..., final handler]
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function test1_settingsRoundTrip() {
    console.log('▶ Test 1: Resend settings save/read round-trip (per-user, isolated)');
    const putHandler = findRoute(settingsRoute, 'put', '/');
    const getHandler = findRoute(settingsRoute, 'get', '/');

    // A saves all three Resend fields.
    const putA = makeReqRes(USER_A, EMAIL_A, {
        resendApiKey: 're_test_secret_key_A',
        resendFromEmail: 'hello@domain-a.com',
        resendFromName: 'Domain A Business',
    });
    await putHandler(putA.req, putA.res);
    assert.strictEqual(putA.status, 200, `PUT /settings succeeded (${putA.body?.error || ''})`);
    assert.strictEqual(putA.body.email.apiKeySet, true, 'apiKeySet reported true after save');
    assert.strictEqual(putA.body.email.fromEmail, 'hello@domain-a.com');
    assert.strictEqual(putA.body.email.fromName, 'Domain A Business');
    assert.ok(!JSON.stringify(putA.body).includes('re_test_secret_key_A'), 'raw API key never echoed back');

    // Rows land in app_settings keyed by (user_id, key).
    const storedKeys = state.rows.app_settings.filter(r => r.user_id === USER_A).map(r => r.key).sort();
    assert.deepStrictEqual(storedKeys, ['RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'RESEND_FROM_NAME'], 'all three keys stored');

    // Read-back round-trips.
    const getA = makeReqRes(USER_A, EMAIL_A);
    await getHandler(getA.req, getA.res);
    assert.strictEqual(getA.status, 200);
    assert.strictEqual(getA.body.email.apiKeySet, true);
    assert.strictEqual(getA.body.email.fromEmail, 'hello@domain-a.com');
    assert.strictEqual(getA.body.email.fromName, 'Domain A Business');
    assert.ok(!JSON.stringify(getA.body).includes('re_test_secret_key_A'), 'raw API key never in GET response');

    // B saves different values; A's stay untouched.
    const putB = makeReqRes(USER_B, EMAIL_B, {
        resendApiKey: 're_test_secret_key_B',
        resendFromEmail: 'team@domain-b.com',
    });
    await putHandler(putB.req, putB.res);
    const getA2 = makeReqRes(USER_A, EMAIL_A);
    await getHandler(getA2.req, getA2.res);
    assert.strictEqual(getA2.body.email.fromEmail, 'hello@domain-a.com', "B's save did not overwrite A's fromEmail");
    assert.strictEqual(getA2.body.email.fromName, 'Domain A Business', "B's save did not overwrite A's fromName");

    const getB = makeReqRes(USER_B, EMAIL_B);
    await getHandler(getB.req, getB.res);
    assert.strictEqual(getB.body.email.fromEmail, 'team@domain-b.com');
    assert.strictEqual(getB.body.email.fromName, '', "B has no fromName — reported empty, not A's");
    console.log('✅ Test 1 passed\n');
}

async function test2_testEmailUsesSavedCredentials() {
    console.log('▶ Test 2: test-email endpoint sends with SAVED creds to own auth email');
    const testHandler = findRoute(settingsRoute, 'post', '/email/test');

    state.sendCalls = [];
    const call = makeReqRes(USER_A, EMAIL_A);
    await testHandler(call.req, call.res);

    assert.strictEqual(call.status, 200, `test endpoint succeeded (${call.body?.error || ''})`);
    assert.strictEqual(state.sendCalls.length, 1, 'exactly one Resend send');
    const { apiKey, payload } = state.sendCalls[0];
    assert.strictEqual(apiKey, 're_test_secret_key_A', 'used the SAVED per-user API key');
    assert.strictEqual(payload.to, EMAIL_A, 'sent to the logged-in user auth email');
    assert.strictEqual(payload.from, 'Domain A Business <hello@domain-a.com>', 'used saved from-name + from-email');
    assert.ok(payload.subject, 'has a subject');
    assert.ok(payload.html, 'has an html body');
    assert.strictEqual(call.body.success, true);
    assert.strictEqual(call.body.messageId, 'mock-email-id');

    // B's test uses B's own credentials, not A's.
    const callB = makeReqRes(USER_B, EMAIL_B);
    await testHandler(callB.req, callB.res);
    assert.strictEqual(state.sendCalls.length, 2);
    assert.strictEqual(state.sendCalls[1].apiKey, 're_test_secret_key_B', "B's send used B's key");
    assert.strictEqual(state.sendCalls[1].payload.from, 'team@domain-b.com', "B has no fromName so from is bare address");
    console.log('✅ Test 2 passed\n');
}

async function test3_failurePathsSurfaceProviderErrors() {
    console.log('▶ Test 3: missing config + Resend API errors are surfaced verbatim');
    const testHandler = findRoute(settingsRoute, 'post', '/email/test');

    // USER_C has saved nothing: expect a clear "no key" message, no send.
    const USER_C = '33333333-3333-3333-3333-333333333333';
    state.sendCalls = [];
    const callC = makeReqRes(USER_C, 'owner-c@example.com');
    await testHandler(callC.req, callC.res);
    assert.strictEqual(callC.status, 400);
    assert.ok(/No Resend API key saved yet/i.test(callC.body.error), `clear missing-key message (got: ${callC.body.error})`);
    assert.strictEqual(state.sendCalls.length, 0, 'no send attempted without a key');

    // Resend rejecting the domain: the provider's actual message surfaces.
    state.sendImpl = async () => ({ data: null, error: { name: 'validation_error', message: 'The example.com domain is not verified. Add it in Resend and add a DNS record.' } });
    const callD = makeReqRes(USER_A, EMAIL_A);
    await testHandler(callD.req, callD.res);
    assert.strictEqual(callD.status, 400);
    assert.ok(
        callD.body.error.includes('The example.com domain is not verified'),
        `provider error message surfaced verbatim (got: ${callD.body.error})`,
    );

    // Thrown transport-level error also surfaces its message.
    state.sendImpl = async () => { throw new Error('connect ETIMEDOUT'); };
    const callE = makeReqRes(USER_A, EMAIL_A);
    await testHandler(callE.req, callE.res);
    assert.strictEqual(callE.status, 400);
    assert.ok(callE.body.error.includes('connect ETIMEDOUT'), `transport error surfaced (got: ${callE.body.error})`);

    state.sendImpl = null;
    console.log('✅ Test 3 passed\n');
}

async function test4_contactEmailField() {
    console.log('▶ Test 4: contacts accept and normalize an optional email');
    const contactService = require('../../contacts/contactService');

    // Insert path stores the email; empty/whitespace becomes null.
    const created = await contactService.upsert('919812345678', { name: 'Raj', email: ' Raj@Example.COM ' }, USER_A);
    assert.strictEqual(created.email, 'raj@example.com', 'email trimmed + lowercased');

    // Update path can set and clear it.
    const updated = await contactService.update(created.id, { email: 'new@domain.com' }, USER_A);
    assert.strictEqual(updated.email, 'new@domain.com', 'update path stores email');
    const cleared = await contactService.update(created.id, { email: '' }, USER_A);
    assert.strictEqual(cleared.email, null, 'empty email stored as null');

    // Search includes email — set it again first (previous step cleared it).
    await contactService.update(created.id, { email: 'Searchable@Domain.com' }, USER_A);
    const listed = await contactService.list(USER_A, { search: 'searchable@domain' });
    assert.strictEqual(listed.data.length, 1, 'search matches on email (case-insensitive)');
    console.log('✅ Test 4 passed\n');
}

async function main() {
    try {
        await test1_settingsRoundTrip();
        await test2_testEmailUsesSavedCredentials();
        await test3_failurePathsSurfaceProviderErrors();
        await test4_contactEmailField();
        console.log('🎉 ALL EMAIL PHASE 1 SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ SMOKE TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
