// =============================================================
// Security smoke test — AI key exfiltration guard (never-mix).
//
// Proves, WITHOUT any real external AI provider:
//   1. A tenant who sets a custom AI_BASE_URL WITHOUT their own
//      AI_API_KEY never causes the server's env-level AI_API_KEY to
//      be sent to that custom URL — the request goes to the env
//      base URL (server default) instead, and the reply still flows.
//   2. A tenant with BOTH their own key and custom URL gets exactly
//      their key sent to their URL (BYO provider works).
//   3. No tenant config at all → env key goes to the env base URL.
//   4. Unit-level: resolveAiConfig() never returns a mix of a stored
//      URL with the env key, for every combination of inputs.
//
// The "providers" are local HTTP capture servers; the flow under test
// is the real incomingMessageService.process() with a mocked Supabase
// layer and a sendMessage spy — the same code path that handles real
// WhatsApp messages.
// =============================================================
const assert = require('assert');
const http = require('http');

process.env.AI_API_KEY = 'sk-SERVER-LEVEL-SECRET-KEY';
// AI_BASE_URL is set after the local capture servers start listening
// (see main()) so the "server default" endpoint is local, never real.

// ---- Supabase mock (injected before requiring modules) ----
const state = { rows: {}, sent: [] };

function makeTable(name) {
    if (!state.rows[name]) state.rows[name] = [];
    const rows = state.rows[name];
    const filters = [];
    const builder = {
        select() { return builder; },
        eq(col, val) { filters.push((r) => r[col] === val); return builder; },
        maybeSingle: async () => ({ data: rows.find((r) => filters.every((f) => f(r))) || null, error: null }),
        single: async () => ({ data: rows.find((r) => filters.every((f) => f(r))) || null, error: null }),
        limit() { return builder; },
        range() { return builder; },
        order() { return builder; },
        or() { return builder; },
        insert(row) {
            return {
                select() {
                    return {
                        single: async () => {
                            const stored = Array.isArray(row) ? row[0] : row;
                            rows.push({ id: rows.length + 1, ...stored });
                            return { data: stored, error: null };
                        },
                    };
                },
            };
        },
        update(_data) {
            return {
                eq() { return this; },
                select: async () => {
                    Object.assign(rows[0] || {}, _data);
                    return { data: rows, error: null };
                },
            };
        },
        async then(resolve) { return resolve({ data: rows, error: null }); },
    };
    return builder;
}

const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
        supabase: { from: makeTable },
        isAvailable: () => true,
        transaction: async (ops) => { for (const op of ops) await op(); },
        normalizeRow: (r) => r,
        parseJsonFields: (r) => r,
    },
};

// Mock the knowledge base (avoids embedding/IO).
const kbPath = require.resolve('../../ai/knowledgeBase');
require.cache[kbPath] = {
    id: kbPath,
    filename: kbPath,
    loaded: true,
    exports: { getRelevantContext: async () => '' },
};

// Local capture servers standing in for AI providers.
constMaliciousHits = [];
const evilHits = [];
const legitHits = [];

const evilServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        evilHits.push({ auth: req.headers.authorization || '', body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'HACKED-REPLY' } }] }));
    });
});
const legitServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        legitHits.push({ auth: req.headers.authorization || '', body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'legit provider reply' } }] }));
    });
});

// Unique user per test: getUserSettings() caches settings for 60s per
// userId, so reusing one id would leak settings across test cases.
const USERS = {
  noKeyCustomURL: '44444444-4444-4444-4444-444444444441',
  ownKeyCustomURL: '44444444-4444-4444-4444-444444444442',
  noConfig: '44444444-4444-4444-4444-444444444443',
};

// Minimal in-memory conversation service data (one row per test user).
state.rows.conversations = Object.entries(USERS).map(([name, id], i) => ({ id: i + 1, user_id: id, phone: '911234567890', ai_enabled: true, status: 'open' }));
state.rows.contacts = [];
state.rows.app_settings = [];

// ---- Load the real services ----
const { resolveAiConfig } = require('../../utils/aiConfig');
const incomingMessageService = require('../../conversations/incomingMessageService');
const conversationService = require('../../conversations/conversationService');
const contactService = require('../../contacts/contactService');

// Neutralize contact upsert + message saving so the test stays hermetic.
contactService.upsert = async () => ({ id: 1, marketing_opt_in: true });
contactService.setOptOut = async () => {};
conversationService.getOrCreate = async () => ({ conversation: state.rows.conversations[0], contact: { id: 1, name: '' } });
conversationService.saveMessage = async () => ({ id: 1 });
conversationService.setStatus = async () => {};
conversationService.setAIEnabled = async () => {};
conversationService.getHistory = async () => [{ role: 'user', content: 'hi' }];

function setUserSettings(user, settings) {
    state.rows.app_settings = Object.entries(settings).map(([key, value]) => ({ user_id: user, key, value }));
}

async function runProcess(user) {
    state.sent = [];
    const sendMessage = async (phone, body) => { state.sent.push({ phone, body }); };
    await incomingMessageService.process(
        { provider: 'web', from: '911234567890', text: 'What is the price of 4 inch pipes?', type: 'text' },
        user,
        null, // io not needed (emitToUser tolerates null)
        sendMessage,
    );
    return state.sent;
}

async function test1_customURL_withoutOwnKey_neverReceivesEnvKey() {
    console.log('▶ Test 1: custom base URL + no stored key → env key NEVER sent to the custom URL');
    evilHits.length = 0;
    legitHits.length = 0;
    setUserSettings(USERS.noKeyCustomURL, { AI_BASE_URL: `http://127.0.0.1:${evilServer.address().port}/v1` });

    const sent = await runProcess(USERS.noKeyCustomURL);

    assert.strictEqual(evilHits.length, 0, `custom (malicious) URL must receive ZERO requests, got ${evilHits.length}`);
    assert.strictEqual(legitHits.length, 1, 'request went to the server-default endpoint instead');
    assert.ok(!JSON.stringify(evilHits).includes('sk-SERVER-LEVEL-SECRET-KEY'), 'env key never appears in any request to the custom URL');
    assert.ok(sent.some((m) => m.body === 'legit provider reply'), 'reply from the default provider still flows to the customer');
    console.log('✅ Test 1 passed\n');
}

async function test2_ownKey_andOwnURL_getsOwnKey() {
    console.log('▶ Test 2: tenant with own key + custom URL → BYO provider works');
    evilHits.length = 0;
    legitHits.length = 0;
    setUserSettings(USERS.ownKeyCustomURL, {
        AI_API_KEY: 'sk-TENANTS-OWN-KEY',
        AI_BASE_URL: `http://127.0.0.1:${evilServer.address().port}/v1`,
    });

    const sent = await runProcess(USERS.ownKeyCustomURL);

    assert.strictEqual(evilHits.length, 1, 'tenant request reaches their own custom URL');
    assert.strictEqual(evilHits[0].auth, 'Bearer sk-TENANTS-OWN-KEY', 'tenant key — not the server key — is sent');
    assert.ok(sent.some((m) => m.body === 'HACKED-REPLY'), 'tenant gets replies from their own provider');
    console.log('✅ Test 2 passed\n');
}

async function test3_noConfig_usesEnvPair() {
    console.log('▶ Test 3: no tenant config → env key goes to the env/default endpoint');
    evilHits.length = 0;
    legitHits.length = 0;
    setUserSettings(USERS.noConfig, {});

    await runProcess(USERS.noConfig);

    assert.strictEqual(evilHits.length, 0, 'no tenant URL configured, nothing else contacted');
    assert.strictEqual(legitHits.length, 1, 'default endpoint used');
    assert.strictEqual(legitHits[0].auth, 'Bearer sk-SERVER-LEVEL-SECRET-KEY', 'env key sent to the default endpoint');
    console.log('✅ Test 3 passed\n');
}

function test4_resolverUnitMatrix() {
    console.log('▶ Test 4: resolveAiConfig() never mixes a stored URL with the env key');
    const EVIL = 'https://evil.example.com/v1';
    const cases = [
        { name: 'own key + own URL', in: { storedKey: 'k1', storedBaseURL: EVIL, envKey: 'SK', envBaseURL: 'https://real/v1' }, out: { apiKey: 'k1', baseURL: EVIL, usingCustomProvider: true, customURLIgnored: false } },
        { name: 'own key, no URL → env URL', in: { storedKey: 'k1', storedBaseURL: '', envKey: 'SK', envBaseURL: 'https://real/v1' }, out: { apiKey: 'k1', baseURL: 'https://real/v1', usingCustomProvider: false, customURLIgnored: false } },
        { name: 'no key + own URL → env key + env URL, URL ignored', in: { storedKey: '', storedBaseURL: EVIL, envKey: 'SK', envBaseURL: 'https://real/v1' }, out: { apiKey: 'SK', baseURL: 'https://real/v1', usingCustomProvider: false, customURLIgnored: true } },
        { name: 'no key + own URL, no env URL → env key + NVIDIA default', in: { storedKey: '', storedBaseURL: EVIL, envKey: 'SK', envBaseURL: '' }, out: { apiKey: 'SK', baseURL: 'https://integrate.api.nvidia.com/v1', usingCustomProvider: false, customURLIgnored: true } },
        { name: 'nothing → env key + default', in: { storedKey: '', storedBaseURL: '', envKey: 'SK', envBaseURL: '' }, out: { apiKey: 'SK', baseURL: 'https://integrate.api.nvidia.com/v1', usingCustomProvider: false, customURLIgnored: false } },
        { name: 'whitespace-only URL treated as unset', in: { storedKey: '', storedBaseURL: '   ', envKey: 'SK', envBaseURL: 'https://real/v1' }, out: { apiKey: 'SK', baseURL: 'https://real/v1', usingCustomProvider: false, customURLIgnored: false } },
    ];
    for (const c of cases) {
        const got = resolveAiConfig(c.in);
        assert.deepStrictEqual(got, c.out, `case: ${c.name}`);
        // Global invariant: a tenant URL in → tenant key out, always.
        if (c.in.storedBaseURL.trim() && got.baseURL === c.in.storedBaseURL.trim()) {
            assert.strictEqual(got.apiKey, c.in.storedKey && c.in.storedKey.trim(), 'custom URL only ever pairs with the tenant key');
        }
    }
    console.log('✅ Test 4 passed\n');
}

async function main() {
    await new Promise((r) => evilServer.listen(0, r));
    await new Promise((r) => legitServer.listen(0, r));
    // Point the server-default endpoint at the local capture server so no
    // test traffic ever reaches a real AI provider.
    process.env.AI_BASE_URL = `http://127.0.0.1:${legitServer.address().port}/v1`;
    try {
        await test1_customURL_withoutOwnKey_neverReceivesEnvKey();
        await test2_ownKey_andOwnURL_getsOwnKey();
        await test3_noConfig_usesEnvPair();
        test4_resolverUnitMatrix();
        console.log('🎉 ALL AI KEY EXFILTRATION GUARD TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        evilServer.close();
        legitServer.close();
    }
}

main();
