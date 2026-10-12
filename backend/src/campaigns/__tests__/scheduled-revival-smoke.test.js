// =============================================================
// Scheduled-campaign revival smoke test.
//
// Verifies, WITHOUT a live phone or real Supabase:
//   1. sessionManager.ensureConnected() revives an idle-disconnected
//      session from stored auth state (no human, no browser).
//   2. It refuses to invent a connection for a user with no stored
//      auth state (never linked / logged out) — returns false.
//   3. schedulerService fires a due schedule whose owner's session was
//      idle-disconnected (revival succeeds → campaign created+started).
//   4. When revival fails, the schedule is NOT fired, stays pending,
//      and last_error records the visible wait reason.
//   5. Concurrent ensureConnected calls for one user single-flight —
//      only one Baileys initialize happens.
//
// Run: node backend/src/campaigns/__tests__/scheduled-revival-smoke.test.js
// =============================================================
const assert = require('assert');

// ---- Shared in-memory Supabase mock (injected at the client boundary)
const state = {
    rows: {},                // table -> array of rows
    lastSocketConfig: null,
    lastSocket: null,
    initCount: 0,
};

// Row filtering shared by all builder methods (`await query` extracts
// `then` from the builder, so `this` is unavailable inside it).
function applyRows(rows, filters) {
    let out = rows;
    for (const f of filters) {
        if (f.op === 'eq') out = out.filter(r => r[f.col] === f.val);
        else if (f.op === 'in') out = out.filter(r => f.vals.includes(r[f.col]));
        else if (f.op === 'lte') out = out.filter(r => new Date(r[f.col]) <= new Date(f.val));
        else if (f.op === 'gte') out = out.filter(r => new Date(r[f.col]) >= new Date(f.val));
        else if (f.op === 'or') {
            // PostgREST or() filter string: "col.op.val,col.op.val".
            // Values match db.js postgrestValue (no quoting needed
            // for our shapes — ISO timestamps contain no delimiters).
            out = out.filter(r => f.expr.split(',').some(part => {
                const m = part.match(/^(\w+)\.(eq|lte|gte|neq)\.(.+)$/);
                if (!m) return false;
                const [, col, op, raw] = m;
                const val = raw === 'null' ? null : decodeURIComponent(raw);
                if (op === 'eq') return String(r[col]) === String(val);
                if (op === 'neq') return String(r[col]) !== String(val);
                if (val === null) return op === 'lte' || op === 'gte'; // not used
                if (op === 'lte') return r[col] === null || new Date(r[col]) <= new Date(val);
                if (op === 'gte') return r[col] !== null && new Date(r[col]) >= new Date(val);
                return false;
            }));
        }
    }
    return out;
}

// Filter-method mixin shared by select/update/delete builders.
function filterMethods(filters) {
    return {
        eq(col, val) { filters.push({ op: 'eq', col, val }); return this; },
        in(col, vals) { filters.push({ op: 'in', col, vals }); return this; },
        lte(col, val) { filters.push({ op: 'lte', col, val }); return this; },
        gte(col, val) { filters.push({ op: 'gte', col, val }); return this; },
        or(expr) { filters.push({ op: 'or', expr }); return this; },
    };
}

function table(name) {
    if (!state.rows[name]) state.rows[name] = [];
    return {
        rows: state.rows[name],
        select(_cols) {
            const filters = [];
            const builder = {
                ...filterMethods(filters),
                order() { return builder; },
                limit() { return builder; },
                range() { return builder; },
                maybeSingle: async () => {
                    const out = applyRows(state.rows[name], filters);
                    return { data: out[0] || null, error: null };
                },
                single: async () => {
                    const out = applyRows(state.rows[name], filters);
                    return { data: out[0] || null, error: out.length ? null : { code: 'PGRST116' } };
                },
                then(resolve) { return resolve({ data: applyRows(state.rows[name], filters), error: null }); },
            };
            return builder;
        },
        upsert(row) {
            const idx = state.rows[name].findIndex(r => r.user_id === row.user_id);
            if (idx >= 0) state.rows[name][idx] = { ...state.rows[name][idx], ...row };
            else state.rows[name].push({ ...row });
            return Promise.resolve({ data: row, error: null });
        },
        insert(row) {
            const created = Array.isArray(row) ? row : [row];
            for (const r of created) {
                state.rows[name].push({
                    ...r,
                    id: r.id || `id-${state.rows[name].length + 1}`,
                    created_at: r.created_at || new Date().toISOString(),
                    // PostgREST column defaults are server-side; emulate the
                    // ones the campaign flow relies on when rows are created
                    // without them (db._parseCampaign expects strings).
                    ...(name === 'campaigns' && r.status === undefined ? { status: 'draft', processed: 0, sent: 0, failed: 0, replies: 0, opt_outs: 0, total_contacts: 0 } : {}),
                    ...(name === 'campaign_contacts' && r.status === undefined ? { status: 'pending', attempts: 0 } : {}),
                });
            }
            const last = state.rows[name][state.rows[name].length - 1];
            return { select: () => ({ single: async () => ({ data: last, error: null }) }) };
        },
        delete() {
            const filters = [];
            const builder = {
                ...filterMethods(filters),
                then(resolve) {
                    state.rows[name] = state.rows[name].filter(r => !applyRows([r], filters).length);
                    return resolve({ data: [], error: null });
                },
            };
            return builder;
        },
        update(_data) {
            const filters = [];
            const builder = {
                ...filterMethods(filters),
                // db.update awaits .select() after applying filters.
                select: async () => {
                    state.rows[name] = state.rows[name].map(r => (applyRows([r], filters).length ? { ...r, ..._data } : r));
                    return { data: applyRows(state.rows[name], filters), error: null };
                },
                then(resolve) {
                    state.rows[name] = state.rows[name].map(r => (applyRows([r], filters).length ? { ...r, ..._data } : r));
                    return resolve({ data: applyRows(state.rows[name], filters), error: null });
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

// ---- Baileys mock (sessionManager._getBaileys is monkeypatched below)
function makeMockSocket(_config) {
    const handlers = {};
    return {
        ev: {
            on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn); },
            emit: (event, payload) => { for (const fn of handlers[event] || []) fn(payload); },
        },
        ws: { close: () => {} },
        logout: async () => {},
        onWhatsApp: async () => [{ exists: true, jid: 'mock@s.whatsapp.net' }],
        sendMessage: async (jid, content) => ({ key: { id: `mock-${Date.now()}` }, jid, content }),
    };
}
const baileysMock = {
    default: (config) => {
        state.initCount += 1;
        const socket = makeMockSocket(config);
        state.lastSocketConfig = config;
        state.lastSocket = socket;
        // Auto-connect shortly after creation — stands in for WhatsApp
        // accepting the noise handshake, so ensureConnected's wait loop can
        // observe a real 'connected' transition.
        setTimeout(() => socket.ev.emit('connection.update', { connection: 'open' }), 20);
        return socket;
    },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    DisconnectReason: { loggedOut: 401 },
    normalizeMessageContent: (m) => m,
};

const sessionManager = require('../../whatsapp/sessionManager');
sessionManager._getBaileys = async () => baileysMock;

const authStateStore = require('../../whatsapp/authStateStore');

// auth_state is encrypted at rest; use the same test key everywhere.
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
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
        emit(event, data) {
            if (!rooms.has('__global__')) rooms.set('__global__', []);
            rooms.get('__global__').push({ event, data });
        },
    };
}

const USER_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const USER_B = 'bbbbbbbb-2222-2222-2222-222222222222';

async function waitFor(predicate, timeoutMs = 3000, label = 'condition') {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

const encryptAuthState = (st) => authStateStore.serializeAuthState(st); // mock store stores plaintext; encryption mocked below if needed

// The real encryption util requires a 32-byte key env (set above) — fine.
// But to keep this test focused, we store auth_state plaintext and rely on
// authStateStore's decrypt passthrough for legacy plaintext rows.

function seedLinkedUser(userId) {
    state.rows.whatsapp_sessions = state.rows.whatsapp_sessions || [];
    const existing = state.rows.whatsapp_sessions.find(r => r.user_id === userId);
    const payload = {
        user_id: userId,
        auth_state: JSON.stringify({ creds: { registered: true, noiseKey: { public: 'pk', private: 'sk' } }, keys: {} }),
        updated_at: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, payload);
    else state.rows.whatsapp_sessions.push(payload);
}

function resetSchedules() {
    state.rows.campaign_schedules = [
        {
            id: 'sched-1',
            user_id: USER_A,
            name: 'Monday blast',
            template_message: 'hello {{name}}',
            file_path: '/tmp/contacts.xlsx',
            buttons: '[]',
            settings: '{}',
            allow_missing_fields: 0,
            schedule_type: 'once',
            status: 'pending',
            next_run_at: new Date(Date.now() - 60000).toISOString(), // due
            updated_at: new Date().toISOString(),
        },
    ];
}

// campaignService reads the Excel file — stub the parser before first use.
const excelParserPath = require.resolve('../excelParser');
const excelParser = require('../excelParser');
excelParser.parse = async () => ({
    validation: { valid: 1, invalid: 0, total: 1 },
    getValidRows: undefined,
    phoneColumn: 'phone',
    rows: [{ phone: '15551234567', name: 'Test' }],
});
excelParser.getValidRows = (result) => result.rows || [];
excelParser.getDynamicFields = () => [];
void excelParserPath;

// campaignService.start asserts owner-connected; ensureConnected covers the
// web path. For determinism we let the real flow run: status is connected
// after revival, so the assert passes without patching.

// ---- Tests --------------------------------------------------------

async function test1_ensureConnectedRevivesIdleSession() {
    console.log('▶ Test 1: ensureConnected revives an idle-disconnected session from stored auth state');
    const io = makeFakeIO();
    sessionManager.setIO(io);

    // Link A: stored auth state exists.
    seedLinkedUser(USER_A);
    state.rows.whatsapp_sessions = state.rows.whatsapp_sessions.map(r =>
        r.user_id === USER_A ? { ...r, auth_state: encryptAuthState({ creds: { registered: true, noiseKey: Buffer.from('nk') }, keys: {} }) } : r
    );

    await sessionManager.initialize(USER_A);
    state.lastSocket.ev.emit('connection.update', { connection: 'open' });
    await waitFor(() => sessionManager.getStatus(USER_A) === 'connected', 3000, 'A connected');

    // Simulate the 2h idle timeout: intentional disconnect keeps auth state.
    await sessionManager.disconnect(USER_A);
    assert.strictEqual(sessionManager.getStatus(USER_A), 'disconnected');

    // Unattended revival — exactly what the scheduler/message queue calls.
    const revived = await sessionManager.ensureConnected(USER_A, 5000);
    assert.strictEqual(revived, true, 'ensureConnected returned true after idle disconnect');
    assert.strictEqual(sessionManager.getStatus(USER_A), 'connected', 'session reconnected');
    console.log('✅ Test 1 passed\n');
}

async function test2_ensureConnectedRefusesUnlinkedUser() {
    console.log('▶ Test 2: ensureConnected returns false for a user with no stored auth state');
    const revived = await sessionManager.ensureConnected(USER_B, 2000);
    assert.strictEqual(revived, false, 'no revival without stored auth state');
    assert.strictEqual(sessionManager.getStatus(USER_B), 'disconnected', 'no session invented for B');
    console.log('✅ Test 2 passed\n');
}

async function test3_schedulerFiresAfterRevival() {
    console.log('▶ Test 3: scheduler fires a due schedule after reviving an idle-disconnected session');
    const io = makeFakeIO();
    const schedulerService = require('../schedulerService');
    schedulerService.startPolling(io); // runs one pass immediately

    // A's session: disconnect again so the scheduler must revive it.
    await sessionManager.disconnect(USER_A);

    resetSchedules();

    // Reconnect A first (seed auth row) then drop, so revival path is used.
    seedLinkedUser(USER_A);
    state.rows.whatsapp_sessions = state.rows.whatsapp_sessions.map(r =>
        r.user_id === USER_A ? { ...r, auth_state: encryptAuthState({ creds: { registered: true, noiseKey: Buffer.from('nk2') }, keys: {} }) } : r
    );
    await sessionManager.initialize(USER_A);
    state.lastSocket.ev.emit('connection.update', { connection: 'open' });
    await waitFor(() => sessionManager.getStatus(USER_A) === 'connected', 3000, 'A reconnected');
    await sessionManager.disconnect(USER_A);            await schedulerService._fireDueSchedules();

            // Campaign was created and started → schedule marked completed (once).
            const schedule = state.rows.campaign_schedules.find(s => s.id === 'sched-1');
    assert.strictEqual(schedule.status, 'completed', 'once-schedule completed after firing');
    assert.ok(schedule.last_campaign_id, 'campaign id recorded');
    assert.strictEqual(schedule.last_error, null, 'no wait error after success');

    const campaign = state.rows.campaigns.find(c => c.id === schedule.last_campaign_id);
    assert.ok(campaign, 'campaign row created');
    console.log('✅ Test 3 passed\n');
}

async function test4_schedulerSkipsAndRecordsWhenRevivalFails() {
    console.log('▶ Test 4: revival failure leaves the schedule waiting with a visible reason');
    const io = makeFakeIO();
    const schedulerService = require('../schedulerService');
    schedulerService.startPolling(io);

    // B has never linked — revival must fail for B's due schedule.
    state.rows.campaign_schedules = [
        {
            id: 'sched-2',
            user_id: USER_B,
            name: 'Never linked',
            template_message: 'hi',
            file_path: '/tmp/contacts.xlsx',
            buttons: '[]',
            settings: '{}',
            allow_missing_fields: 0,
            schedule_type: 'once',
            status: 'pending',
            next_run_at: new Date(Date.now() - 60000).toISOString(),
            updated_at: new Date().toISOString(),
        },
    ];

    await schedulerService._fireDueSchedules();

    const schedule = state.rows.campaign_schedules.find(s => s.id === 'sched-2');
    assert.strictEqual(schedule.status, 'pending', 'schedule still pending (waits, not fails)');
    assert.ok(schedule.last_error && /Waiting for WhatsApp connection/.test(schedule.last_error), `visible wait reason recorded, got: ${schedule.last_error}`);

    const roomB = io.rooms.get(`user:${USER_B}`) || [];
    assert.ok(roomB.some(e => e.event === 'schedule:waiting_connection'), 'waiting event emitted to owner room');
    console.log('✅ Test 4 passed\n');
}

async function test5_concurrentRevivalSingleFlight() {
    console.log('▶ Test 5: concurrent ensureConnected calls single-flight');
    seedLinkedUser(USER_A);
    state.rows.whatsapp_sessions = state.rows.whatsapp_sessions.map(r =>
        r.user_id === USER_A ? { ...r, auth_state: encryptAuthState({ creds: { registered: true, noiseKey: Buffer.from('nk3') }, keys: {} }) } : r
    );
    await sessionManager.initialize(USER_A);
    state.lastSocket.ev.emit('connection.update', { connection: 'open' });
    await waitFor(() => sessionManager.getStatus(USER_A) === 'connected', 3000, 'A connected for test 5');
    await sessionManager.disconnect(USER_A);

    const before = state.initCount;
    const [r1, r2, r3] = await Promise.all([
        sessionManager.ensureConnected(USER_A, 5000),
        sessionManager.ensureConnected(USER_A, 5000),
        sessionManager.ensureConnected(USER_A, 5000),
    ]);
    assert.deepStrictEqual([r1, r2, r3], [true, true, true], 'all callers report success');
    // At most one extra initialize: the racing single-flight may or may not
    // have won, but a stampede (3) is impossible.
    assert.ok(state.initCount - before <= 1, `no revival stampede (adds: ${state.initCount - before})`);
    console.log('✅ Test 5 passed\n');
}

async function main() {
    try {
        await test1_ensureConnectedRevivesIdleSession();
        await test2_ensureConnectedRefusesUnlinkedUser();
        await test3_schedulerFiresAfterRevival();
        await test4_schedulerSkipsAndRecordsWhenRevivalFails();
        await test5_concurrentRevivalSingleFlight();
        console.log('🎉 ALL SCHEDULED-REVIVAL SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ SMOKE TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
