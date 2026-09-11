// =============================================================
// Phase 2 smoke test — per-user WhatsApp isolation.
//
// Verifies, WITHOUT a live phone or real Supabase:
//   1. Session manager isolates two fake users completely.
//   2. Auth state JSON round-trips (Buffers preserved) and writes
//      are per-user (mocked at the supabase client boundary).
//   3. Socket.IO emits go only to the owner's room.
//   4. POST /api/whatsapp/logout clears the caller's session +
//      Supabase row and never touches another user's.
//
// Run: node backend/src/whatsapp/__tests__/phase2-smoke.test.js
// (Set WHATSAPP_AUTH_STATE_DEBOUNCE_MS=0 in env for instant flush.)
// =============================================================
const assert = require('assert');

// ---- Shared in-memory Supabase mock (injected at the client boundary)
const state = {
    rows: {},                // table -> array of rows
    authGetUserCalls: [],
};

function table(name) {
    if (!state.rows[name]) state.rows[name] = [];
    return {
        rows: state.rows[name],
        _apply(rows, filters) {
            let out = rows;
            for (const f of filters) {
                if (f.op === 'eq') out = out.filter(r => r[f.col] === f.val);
                else if (f.op === 'in') out = out.filter(r => f.vals.includes(r[f.col]));
            }
            return out;
        },
        select(_cols) {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
                in(col, vals) { filters.push({ op: 'in', col, vals }); return builder; },
                maybeSingle: async () => {
                    const out = this._apply(state.rows[name], filters);
                    return { data: out[0] || null, error: null };
                },
                single: async () => {
                    const out = this._apply(state.rows[name], filters);
                    return { data: out[0] || null, error: out.length ? null : { code: 'PGRST116' } };
                },
                then(resolve) { return resolve({ data: this._apply(state.rows[name], filters), error: null }); },
            };
            return builder;
        },
        upsert(row) {
            const idx = state.rows[name].findIndex(r => r.user_id === row.user_id);
            if (idx >= 0) state.rows[name][idx] = { ...state.rows[name][idx], ...row };
            else state.rows[name].push({ ...row });
            return Promise.resolve({ data: row, error: null });
        },
        delete() {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push({ op: 'eq', col, val }); return builder; },
                select: async () => {
                    const before = state.rows[name].length;
                    state.rows[name] = state.rows[name].filter(r => !filters.every(f => r[f.col] === f.val));
                    return { data: [], error: null, deleted: before - state.rows[name].length };
                },
                then(resolve) {
                    state.rows[name] = state.rows[name].filter(r => !filters.every(f => r[f.col] === f.val));
                    return resolve({ data: [], error: null });
                },
            };
            return builder;
        },
        update(_data) {
            return {
                eq: (col, val) => ({
                    select: async () => {
                        state.rows[name] = state.rows[name].map(r => (r[col] === val ? { ...r, ..._data } : r));
                        return { data: state.rows[name].filter(r => r[col] === val), error: null };
                    },
                }),
            };
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

// Also mock Baileys' dynamic import used by sessionManager.
const baileysMock = {
    default: (config) => {
        const socket = makeMockSocket(config);
        state.lastSocketConfig = config;
        state.lastSocket = socket;
        return socket;
    },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    DisconnectReason: { loggedOut: 401 },
    normalizeMessageContent: (m) => m,
};
state.lastSocketConfig = null;
state.lastSocket = null;

function makeMockSocket(_config) {
    const handlers = {};
    return {
        ev: {
            on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn); },
            emit: (event, payload) => { for (const fn of handlers[event] || []) fn(payload); },
        },
        ws: { close: () => {} },
        logout: async () => { state.logoutCalled = (state.logoutCalled || 0) + 1; },
        onWhatsApp: async () => [{ exists: true, jid: 'mock@s.whatsapp.net' }],
        sendMessage: async (jid, content) => ({ key: { id: `mock-${Date.now()}` }, jid, content }),
    };
}

// sessionManager does `await import('@whiskeysockets/baileys')`. Intercept it.
const Module = require('module');
const originalImport = Module.prototype.import; // may not exist; we use a different hook below
// Node ESM import interception is tricky from CJS; sessionManager uses dynamic
// import() which resolves via the ESM loader. To keep the test dependency-free,
// sessionManager._getBaileys is monkeypatched after require instead.
const sessionManager = require('../../whatsapp/sessionManager');
sessionManager._getBaileys = async () => baileysMock;

const authStateStore = require('../../whatsapp/authStateStore');
const { emitToUser } = require('../../realtime');

// auth_state is encrypted at rest — the store's writes are ciphertext, and
// rows seeded by this test are encrypted with the same test key so reads
// revive. (Legacy plaintext seeded rows also revive via passthrough; we
// seed ciphertext to mirror post-migration reality.)
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const { encrypt, decrypt } = require('../../utils/encryption');
const encryptAuthState = (state) => encrypt(authStateStore.serializeAuthState(state));
const decryptAuthState = (value) => decrypt(value);

process.env.WHATSAPP_AUTH_STATE_DEBOUNCE_MS = '0';

// ---- Fake room-tracking Socket.IO --------------------------------
function makeFakeIO() {
    const rooms = new Map(); // room -> array of payloads {event, data}
    return {
        rooms,
        to(room) {
            if (!rooms.has(room)) rooms.set(room, []);
            return { emit: (event, data) => rooms.get(room).push({ event, data }) };
        },
        emit(event, data) { // global broadcast — tracked separately to catch leaks
            if (!rooms.has('__global__')) rooms.set('__global__', []);
            rooms.get('__global__').push({ event, data });
        },
    };
}

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

async function waitFor(predicate, timeoutMs = 3000, label = 'condition') {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

async function test1_sessionIsolation() {
    console.log('▶ Test 1: session manager isolates two fake userIds');
    const io = makeFakeIO();
    sessionManager.setIO(io);

    await sessionManager.initialize(USER_A);
    const socketA = state.lastSocket;
    assert.ok(socketA, 'User A socket created');
    assert.ok(state.lastSocketConfig.auth, 'socket created with auth state');

    // A connects: status + QR go only to A's room.
    socketA.ev.emit('connection.update', { qr: 'mock-qr-string' });
    await waitFor(() => (io.rooms.get(`user:${USER_A}`) || []).some(e => e.event === 'whatsapp:qr'), 3000, 'QR event in A room');
    const roomA = io.rooms.get(`user:${USER_A}`) || [];
    const roomB = io.rooms.get(`user:${USER_B}`) || [];
    assert.ok(roomA.some(e => e.event === 'whatsapp:qr'), 'QR event went to A room');
    assert.strictEqual(roomB.length, 0, 'User B room received NOTHING from A');
    assert.strictEqual(sessionManager.getStatus(USER_B), 'disconnected', 'B status unaffected');
    assert.strictEqual(sessionManager.getQRDataUrl(USER_B), null, 'B QR unaffected');

    // A becomes connected.
    socketA.ev.emit('connection.update', { connection: 'open' });
    await waitFor(() => sessionManager.getStatus(USER_A) === 'connected', 3000, 'A connected');
    assert.strictEqual(sessionManager.getStatus(USER_B), 'disconnected');

    // B initializes a separate session.
    await sessionManager.initialize(USER_B);
    const socketB = state.lastSocket;
    assert.notStrictEqual(socketB, socketA, 'B got its own socket, not A\'s');
    assert.strictEqual(sessionManager.getStatus(USER_A), 'connected', 'A status untouched by B init');

    // B connects too.
    socketB.ev.emit('connection.update', { connection: 'open' });
    await waitFor(() => sessionManager.getStatus(USER_B) === 'connected', 3000, 'B connected');

    // Sending resolves per-user.
    await sessionManager.sendMessage(USER_A, '15551234567', 'hello from A');
    await sessionManager.sendMessage(USER_B, '15551234567', 'hello from B');

    // Cross-user reads stay isolated.
    assert.strictEqual(sessionManager.getQRDataUrl(USER_A), null, 'A QR cleared after connect');
    console.log('✅ Test 1 passed\n');
}

async function test2_authStateRoundTrip() {
    console.log('▶ Test 2: Supabase auth-state read/write round-trip');
    const creds = {
        noiseKey: Buffer.from('noise-key-bytes'),
        signedIdentityKey: Buffer.from('identity-key'),
        registrationId: 12345,
        me: { id: '15550001111', name: 'Tester' },
    };
    const serialized = authStateStore.serializeAuthState({ creds, keys: {} });
    const revived = authStateStore.reviveAuthState(serialized);

    assert.ok(Buffer.isBuffer(revived.creds.noiseKey), 'Buffer revived as Buffer');
    assert.strictEqual(revived.creds.noiseKey.toString('utf8'), 'noise-key-bytes', 'Buffer content intact');
    assert.strictEqual(revived.creds.registrationId, 12345, 'numbers survive');
    assert.strictEqual(revived.creds.me.id, '15550001111', 'nested objects survive');

    // Per-user write + read via the store (mocked supabase boundary).
    await authStateStore.useSupabaseAuthState(USER_A);
    const rowA = state.rows.whatsapp_sessions.find(r => r.user_id === USER_A);
    assert.ok(!rowA, 'no row written before saveCreds/flush (lazy writes)');

    const authA = await authStateStore.useSupabaseAuthState(USER_A);
    authA.state.creds = { noiseKey: Buffer.from('a-state') };
    await authA.flush();

    const storedA = state.rows.whatsapp_sessions.find(r => r.user_id === USER_A);
    assert.ok(storedA, 'user A row written to whatsapp_sessions');
    // auth_state is now ENCRYPTED at rest (v1:iv:tag:ciphertext). The $b
    // Buffer markers only exist inside the encrypted payload, so assert
    // ciphertext here and prove the $b round-trip via the revived read.
    const { isEncrypted } = require('../../utils/encryption');
    assert.ok(isEncrypted(storedA.auth_state), 'auth_state stored as versioned ciphertext (not plaintext)');

    // Fresh instance reads back the same bytes.
    const authA2 = await authStateStore.useSupabaseAuthState(USER_A);
    assert.strictEqual(authA2.state.creds.noiseKey.toString('utf8'), 'a-state', 'round-trip restored Buffer');

    // B writing must not touch A's row.
    const authB = await authStateStore.useSupabaseAuthState(USER_B);
    authB.state.creds = { noiseKey: Buffer.from('b-state') };
    await authB.flush();
    const storedA2 = state.rows.whatsapp_sessions.find(r => r.user_id === USER_A);
    const revivedA2 = authStateStore.reviveAuthState(decryptAuthState(storedA2.auth_state));
    assert.strictEqual(revivedA2.creds.noiseKey.toString('utf8'), 'a-state', 'A row untouched by B write');
    console.log('✅ Test 2 passed\n');
}

async function test3_socketRoomScoping() {
    console.log('▶ Test 3: Socket.IO emits are room-scoped');
    const io = makeFakeIO();
    sessionManager.setIO(io); // route session-manager events into THIS io

    emitToUser(io, USER_A, 'whatsapp:status', { status: 'connected' });
    emitToUser(io, USER_B, 'whatsapp:status', { status: 'waiting_qr' });

    const roomA = io.rooms.get(`user:${USER_A}`) || [];
    const roomB = io.rooms.get(`user:${USER_B}`) || [];
    assert.strictEqual(roomA.length, 1, 'A got exactly one event');
    assert.strictEqual(roomA[0].data.status, 'connected', 'A got A payload');
    assert.strictEqual(roomB[0].data.status, 'waiting_qr', 'B got B payload');

    // sessionManager status pushes also go only to the owner's room.
    // (initialize returns the cached session here, so grab A's socket
    // directly from the session record.)
    await sessionManager.initialize(USER_A);
    const socketA = sessionManager.sessions.get(USER_A).socket;
    const before = (io.rooms.get(`user:${USER_B}`) || []).length;
    socketA.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 }, message: 'stream errored' } } });
    await waitFor(() => (io.rooms.get(`user:${USER_A}`) || []).some(e => e.event === 'whatsapp:status' && e.data.status === 'reconnecting'), 3000, 'A reconnecting status');
    const after = (io.rooms.get(`user:${USER_B}`) || []).length;
    assert.strictEqual(before, after, 'B received nothing during A reconnect cycle');
    // Hygiene: stop auto-reconnect timers so they don't fire mid-test-4.
    sessionManager.disconnect(USER_A);
    sessionManager.disconnect(USER_B);
    console.log('✅ Test 3 passed\n');
}

async function test4_logoutEndpoint() {
    console.log('▶ Test 4: logout endpoint clears session + row, never touches others');
    // Seed: both users have stored auth rows and live sessions.
    state.rows.whatsapp_sessions = [
        { user_id: USER_A, auth_state: encryptAuthState({ creds: { noiseKey: Buffer.from('a') } }), updated_at: new Date().toISOString() },
        { user_id: USER_B, auth_state: encryptAuthState({ creds: { noiseKey: Buffer.from('b') } }), updated_at: new Date().toISOString() },
    ];
    await sessionManager.initialize(USER_A);
    await sessionManager.initialize(USER_B);
    assert.ok(sessionManager.sessions.has(USER_A));
    assert.ok(sessionManager.sessions.has(USER_B));

    // Simulate the authenticated request context for A only.
    const logoutRoute = require('../../routes/whatsapp');
    // The route is an express Router; call the handler through a tiny shim.
    const req = { user: { id: USER_A } };
    let statusCode = null; let body = null;
    const res = {
        json: (data) => { body = data; statusCode = 200; },
        status(code) { statusCode = code; return { json: (d) => { body = d; } }; },
    };
    // Find the POST /logout layer in the router stack.
    const layer = logoutRoute.stack.find(l => l.route?.path === '/logout' && l.route?.methods?.post);
    assert.ok(layer, 'POST /logout route exists');
    await layer.route.stack[layer.route.stack.length - 1].handle(req, res);

    assert.strictEqual(statusCode, 200, 'logout succeeded');
    assert.ok(state.logoutCalled >= 1, 'Baileys logout() was actually called');
    assert.ok(!state.rows.whatsapp_sessions.some(r => r.user_id === USER_A), 'A auth row deleted');
    assert.ok(state.rows.whatsapp_sessions.some(r => r.user_id === USER_B), 'B auth row untouched');
    assert.ok(!sessionManager.sessions.has(USER_A), 'A session removed from manager');
    assert.ok(sessionManager.sessions.has(USER_B), 'B session still live in manager');
    console.log('✅ Test 4 passed\n');
}

// BUG 3 regression: when Baileys runs out of QR refs it closes with
// DisconnectReason.timedOut (408). The manager must schedule an auto-restart
// (fresh initialize → fresh QR) instead of getting stuck in 'reconnecting'.
async function test5_qrRefsExhaustedAutoRestart() {
    console.log('▶ Test 5: QR refs exhausted (timedOut 408) auto-restarts with a fresh QR');
    const socketA = sessionManager.sessions.get(USER_B).socket; // B survived test 4
    assert.ok(socketA, 'B session socket present before the test');

    // Make DisconnectReason include timedOut for this test (the real Baileys
    // mock above only lists loggedOut: 401).
    baileysMock.DisconnectReason = { loggedOut: 401, timedOut: 408 };

    // Shrink the backoff so the auto-restart fires quickly.
    const originalBase = process.env.WA_RECONNECT_BASE_MS;
    process.env.WA_RECONNECT_BASE_MS = '10';

    // Simulate Baileys giving up after all QR refs were consumed unscanned.
    socketA.ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 408 }, message: 'QR refs attempts ended' } },
    });

    // The manager must push 'reconnecting' and then automatically re-initialize.
    await waitFor(() => (sessionManager.getStatus(USER_B) === 'reconnecting'), 2000, 'reconnecting status after 408 close');
    await waitFor(() => state.lastSocketConfig && state.lastSocket !== socketA, 2000, 'fresh Baileys socket created');
    await waitFor(() => sessionManager.getStatus(USER_B) === 'initializing', 2000, 'fresh connection initializing');

    // Cleanup so no timer leaks into other suites / the process exit.
    await sessionManager.disconnect(USER_B);
    baileysMock.DisconnectReason = { loggedOut: 401 };
    if (originalBase === undefined) delete process.env.WA_RECONNECT_BASE_MS;
    else process.env.WA_RECONNECT_BASE_MS = originalBase;
    console.log('✅ Test 5 passed\n');
}

async function main() {
    try {
        await test1_sessionIsolation();
        await test2_authStateRoundTrip();
        await test3_socketRoomScoping();
        await test4_logoutEndpoint();
        await test5_qrRefsExhaustedAutoRestart();
        console.log('🎉 ALL PHASE 2 SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ SMOKE TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
