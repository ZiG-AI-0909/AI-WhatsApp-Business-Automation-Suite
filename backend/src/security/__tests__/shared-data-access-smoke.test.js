// =============================================================
// Smoke test — shared data access (private.user_data_shares).
//
// Boots the real requireAuth middleware, routes, services and db.js
// against an in-memory Supabase fake that evaluates PostgREST filters
// (eq/in/like/or/order/range/embeds), so every request goes through the
// same user_id scoping as production. The share check is the fake's
// version of public.resolve_data_owner (same rules as the SQL).
//
//   User 1  owner of the data
//   User 2  User 1 shared their data with User 2
//   User 3  unrelated user
// =============================================================
process.env.SUPABASE_URL = 'https://shared-access-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.AUTH_DISABLED = '';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('node:assert/strict');
const express = require('express');

const USER1 = 'e878e7d9-7c5a-4abc-a2bf-cd8c6b0b9e7b';
const USER2 = '860bbfc5-c97d-4c92-9b57-3318ab1b8cfc';
const USER3 = '3c1f0f5e-2b7a-4d43-9a8e-5d2f6b7c8d90';
const TOKENS = { 'token-user1': USER1, 'token-user2': USER2, 'token-user3': USER3 };
const EMAILS = { [USER1]: 'owner@example.com', [USER2]: 'colleague@example.com', [USER3]: 'other@example.com' };

// ── In-memory Supabase ─────────────────────────────────────────
const { createFakeSupabase, installFakeSupabase } = require('../../database/__tests__/fakeSupabase');

const shares = [{ owner_user_id: USER1, shared_user_id: USER2, created_at: '2026-10-01T00:00:00Z' }];
let rpcMissing = false;

function same(a, b) { return String(a) === String(b); }
function missingFunction(name) {
    return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
}

const fake = createFakeSupabase({
    rpc: {
        // Mirrors supabase-shared-access-migration.sql.
        resolve_data_owner({ p_auth_user_id: auth, p_requested_owner_id: owner }) {
            if (rpcMissing) return missingFunction('resolve_data_owner');
            if (!auth) return { data: null, error: null };
            if (!owner || owner === auth) return { data: auth, error: null };
            const allowed = shares.some(share => share.owner_user_id === owner && share.shared_user_id === auth);
            return { data: allowed ? owner : null, error: null };
        },
        list_data_owners({ p_auth_user_id: auth }) {
            if (rpcMissing) return missingFunction('list_data_owners');
            return {
                data: shares.filter(share => share.shared_user_id === auth)
                    .map(share => ({ owner_user_id: share.owner_user_id, owner_email: EMAILS[share.owner_user_id], shared_at: share.created_at })),
                error: null,
            };
        },
    },
});
const store = fake.store;
const supabase = installFakeSupabase(fake);
const auth = require('../../middleware/auth');
const fakeGetClaims = async (token) => (TOKENS[token]
    ? { data: { claims: { sub: TOKENS[token], email: EMAILS[TOKENS[token]], role: 'authenticated' } }, error: null }
    : { data: null, error: { message: 'invalid JWT' } });
auth.supabaseAdmin.auth.getClaims = fakeGetClaims;
supabase.auth.getClaims = fakeGetClaims;
const { clearDataOwnerCache } = require('../dataOwner');
const realtime = require('../../realtime');

function seed() {
    store.contacts = [
        { id: 101, user_id: USER1, phone: '919800000001', name: 'Owner Customer A', company: 'Acme', marketing_opt_in: 1, tags: '[]', updated_at: '2026-10-02T00:00:00Z' },
        { id: 102, user_id: USER1, phone: '919800000002', name: 'Owner Customer B', company: 'Beta', marketing_opt_in: 0, tags: '[]', updated_at: '2026-10-01T00:00:00Z' },
        { id: 111, user_id: USER2, phone: '919800000011', name: 'Colleague Own Lead', marketing_opt_in: 1, tags: '[]', updated_at: '2026-10-01T00:00:00Z' },
        { id: 121, user_id: USER3, phone: '919800000021', name: 'Unrelated Lead', marketing_opt_in: 1, tags: '[]', updated_at: '2026-10-01T00:00:00Z' },
    ];
    store.conversations = [
        { id: 201, user_id: USER1, contact_id: 101, status: 'open', ai_enabled: 1, unread_count: 1, last_message_at: '2026-10-02T00:00:00Z' },
    ];
    store.messages = [
        { id: 301, user_id: USER1, conversation_id: 201, direction: 'inbound', body: 'Need 110 mm pipes', created_at: '2026-10-02T00:00:00Z' },
        { id: 302, user_id: USER1, conversation_id: 201, direction: 'outbound', body: 'Sharing the price list', created_at: '2026-10-02T00:01:00Z' },
    ];
    store.campaigns = [
        { id: 401, user_id: USER1, name: 'Owner October campaign', status: 'completed', template_message: 'Hi {{name}}', total_contacts: 1, processed: 1, sent: 1, failed: 0, replies: 0, opt_outs: 0, settings: '{}', buttons: '[]', created_at: '2026-10-01T00:00:00Z' },
    ];
    store.campaign_contacts = [
        { id: 501, user_id: USER1, campaign_id: 401, contact_id: 101, status: 'sent', rendered_message: 'Hi Owner Customer A' },
    ];
    store.quotations = [
        { id: 601, user_id: USER1, status: 'draft', quote_number: null, customer_name: 'Owner Client', project_name: 'MGNVY', created_at: '2026-10-03T00:00:00Z', supply_type: 'intra', gst_percent: 18, discount_percent: 0, freight: 0, validity_days: 30, terms: [], company: {}, integrity: {} },
    ];
    store.quotation_items = [
        { id: 701, user_id: USER1, quotation_id: 601, line_no: 1, section: 'A', description: 'HDPE pipe 110 mm', unit: 'm', qty: 100, rate: null, include: true, flags: [], spec: {} },
        { id: 702, user_id: USER1, quotation_id: 601, line_no: 2, section: 'A', description: 'HDPE pipe 160 mm', unit: 'm', qty: 50, rate: null, include: true, flags: [], spec: {} },
    ];
    store.app_settings = [
        { id: 801, user_id: USER1, key: 'AI_API_KEY', value: 'sk-owner-secret' },
    ];
}

function buildApp() {
    const app = express();
    app.use(express.json());
    const { requireAuth } = auth;
    app.use('/api/workspaces', requireAuth, require('../../routes/workspaces'));
    app.use('/api/whatsapp', requireAuth, require('../../routes/whatsapp'));
    app.use('/api/contacts', requireAuth, require('../../routes/contacts'));
    app.use('/api/conversations', requireAuth, require('../../routes/conversations'));
    app.use('/api/campaigns', requireAuth, require('../../routes/campaigns'));
    app.use('/api/settings', requireAuth, require('../../routes/settings'));
    app.use('/api', requireAuth, require('../../routes/quotations'));
    return app;
}

async function main() {
    seed();
    const server = buildApp().listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (method, path, { token, owner, body } = {}) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (owner !== undefined) headers['X-Data-Owner'] = owner;
        const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        let data = null;
        try { data = await response.json(); } catch { /* empty */ }
        return { status: response.status, data };
    };
    const ids = rows => rows.map(row => row.id).sort((a, b) => a - b);
    const owned = (table, id) => store[table].find(row => same(row.id, id));
    const results = [];
    const check = async (label, fn) => {
        try { await fn(); results.push(`ok   ${label}`); } catch (error) { results.push(`FAIL ${label}`); throw error; }
    };

    try {
        // ── Unauthenticated ─────────────────────────────────────
        await check('unauthenticated: GET/POST/PUT/DELETE rejected with 401', async () => {
            assert.equal((await call('GET', '/contacts')).status, 401);
            assert.equal((await call('GET', '/contacts', { owner: USER1 })).status, 401);
            assert.equal((await call('POST', '/contacts', { body: { phone: '9876543210' } })).status, 401);
            assert.equal((await call('PUT', '/contacts/101', { body: { name: 'x' } })).status, 401);
            assert.equal((await call('DELETE', '/contacts/101')).status, 401);
            assert.equal((await call('GET', '/quotations/601', { token: 'forged-token', owner: USER1 })).status, 401);
            assert.equal(owned('contacts', 101).name, 'Owner Customer A');
        });

        // ── User 1: own data ───────────────────────────────────
        await check('User 1 SELECT own contacts, conversations, campaigns, quotations', async () => {
            const contacts = await call('GET', '/contacts', { token: 'token-user1' });
            assert.equal(contacts.status, 200);
            assert.deepEqual(ids(contacts.data.data), [101, 102]);
            assert.equal((await call('GET', '/conversations/201', { token: 'token-user1' })).status, 200);
            assert.deepEqual(ids((await call('GET', '/campaigns', { token: 'token-user1' })).data.data), [401]);
            const quotation = await call('GET', '/quotations/601', { token: 'token-user1' });
            assert.equal(quotation.status, 200);
        });
        await check('User 1 INSERT/UPDATE/DELETE own contact', async () => {
            const created = await call('POST', '/contacts', { token: 'token-user1', body: { phone: '+919811111111', name: 'Owner New' } });
            assert.equal(created.status, 201);
            assert.equal(owned('contacts', created.data.id).user_id, USER1);
            assert.equal((await call('PUT', `/contacts/${created.data.id}`, { token: 'token-user1', body: { name: 'Owner Renamed' } })).status, 200);
            assert.equal(owned('contacts', created.data.id).name, 'Owner Renamed');
            assert.equal((await call('DELETE', `/contacts/${created.data.id}`, { token: 'token-user1' })).status, 200);
            assert.equal(owned('contacts', created.data.id), undefined);
        });
        await check('User 1 cannot open User 2\'s data (sharing is one-way)', async () => {
            const response = await call('GET', '/contacts', { token: 'token-user1', owner: USER2 });
            assert.equal(response.status, 403);
            assert.equal(response.data.code, 'WORKSPACE_FORBIDDEN');
        });

        // ── User 2: own workspace keeps existing behaviour ──────
        await check('User 2 without a workspace header sees only their own records', async () => {
            const contacts = await call('GET', '/contacts', { token: 'token-user2' });
            assert.deepEqual(ids(contacts.data.data), [111]);
            assert.equal((await call('GET', '/conversations/201', { token: 'token-user2' })).status, 404);
            assert.equal((await call('GET', '/quotations/601', { token: 'token-user2' })).status, 404);
        });

        // ── User 2: User 1's shared workspace ──────────────────
        const asShared = { token: 'token-user2', owner: USER1 };
        await check('User 2 lists workspaces: own + User 1 shared', async () => {
            const response = await call('GET', '/workspaces', asShared);
            assert.equal(response.status, 200);
            assert.equal(response.data.self.id, USER2);
            assert.equal(response.data.active, USER1);
            assert.equal(response.data.sharedAccess, true);
            assert.deepEqual(response.data.shared.map(item => item.id), [USER1]);
        });
        await check('User 2 SELECT User 1 contacts (search, filter, pagination, stats)', async () => {
            const contacts = await call('GET', '/contacts', asShared);
            assert.equal(contacts.status, 200);
            assert.deepEqual(ids(contacts.data.data), [101, 102]);
            assert.equal(contacts.data.total, 2);
            assert.deepEqual(ids((await call('GET', '/contacts?search=Customer%20B', asShared)).data.data), [102]);
            assert.deepEqual(ids((await call('GET', '/contacts?opt_in=1', asShared)).data.data), [101]);
            assert.deepEqual(ids((await call('GET', '/contacts?limit=1&page=2', asShared)).data.data), [102]);
            const stats = await call('GET', '/contacts/stats', asShared);
            assert.deepEqual(stats.data, { total: 2, optedIn: 1, optedOut: 1 });
        });
        await check('User 2 SELECT User 1 conversation and its messages (child rows)', async () => {
            const conversation = await call('GET', '/conversations/201', asShared);
            assert.equal(conversation.status, 200);
            const messages = await call('GET', '/conversations/201/messages', asShared);
            assert.deepEqual(messages.data.map(message => message.id).sort(), [301, 302]);
            const list = await call('GET', '/conversations', asShared);
            assert.equal(list.status, 200);
            assert.deepEqual(list.data.data.map(row => row.id), [201]);
        });
        await check('User 2 SELECT User 1 campaigns, campaign contacts and campaign stats', async () => {
            assert.deepEqual(ids((await call('GET', '/campaigns', asShared)).data.data), [401]);
            const recipients = await call('GET', '/campaigns/401/contacts', asShared);
            assert.equal(recipients.status, 200);
            assert.deepEqual((recipients.data.data || recipients.data).map(row => row.id), [501]);
            const stats = await call('GET', '/campaigns/stats', asShared);
            assert.equal(stats.data.total, 1);
            assert.equal(stats.data.totalSent, 1);
        });
        await check('User 2 SELECT User 1 quotations and quotation items', async () => {
            const list = await call('GET', '/quotations', asShared);
            assert.deepEqual(list.data.data.map(row => row.id), [601]);
            const detail = await call('GET', '/quotations/601', asShared);
            assert.equal(detail.status, 200);
            const items = detail.data.items || detail.data.quotation?.items || [];
            assert.equal(items.length, 2);
        });
        let sharedContactId;
        await check('User 2 INSERT in User 1 workspace: row is owned by User 1', async () => {
            const created = await call('POST', '/contacts', { ...asShared, body: { phone: '+919822222222', name: 'Added by colleague', user_id: USER2 } });
            assert.equal(created.status, 201);
            sharedContactId = created.data.id;
            assert.equal(owned('contacts', sharedContactId).user_id, USER1, 'shared-workspace records belong to the workspace owner');
        });
        await check('User 2 UPDATE User 1 records (contact, conversation status)', async () => {
            assert.equal((await call('PUT', '/contacts/101', { ...asShared, body: { name: 'Renamed by colleague' } })).status, 200);
            assert.equal(owned('contacts', 101).name, 'Renamed by colleague');
            assert.equal(owned('contacts', 101).user_id, USER1, 'ownership unchanged');
            assert.equal((await call('PATCH', '/conversations/201/status', { ...asShared, body: { status: 'resolved' } })).status, 200);
            assert.equal(owned('conversations', 201).status, 'resolved');
        });
        await check('User 2 DELETE User 1 records (contact, draft quotation)', async () => {
            assert.equal((await call('DELETE', `/contacts/${sharedContactId}`, asShared)).status, 200);
            assert.equal(owned('contacts', sharedContactId), undefined);
            assert.equal((await call('DELETE', '/quotations/601', asShared)).status, 200);
            assert.equal(owned('quotations', 601), undefined);
        });
        await check('User 2 cannot manage User 1 secrets or WhatsApp connection', async () => {
            const settings = await call('PUT', '/settings', { ...asShared, body: { aiApiKey: 'sk-attacker' } });
            assert.equal(settings.status, 403);
            assert.equal(settings.data.code, 'OWNER_ONLY');
            assert.equal(store.app_settings.find(row => row.key === 'AI_API_KEY').value, 'sk-owner-secret');
            for (const [method, path] of [['GET', '/whatsapp/qr'], ['POST', '/whatsapp/connect'], ['POST', '/whatsapp/logout'], ['POST', '/whatsapp/business/connect']]) {
                assert.equal((await call(method, path, asShared)).status, 403, `${method} ${path}`);
            }
            const status = await call('GET', '/whatsapp/status', asShared);
            assert.equal(status.status, 200);
            assert.equal(status.data.qrAvailable, false);
            const readSettings = await call('GET', '/settings', asShared);
            assert.equal(readSettings.status, 200);
            assert.ok(!JSON.stringify(readSettings.data).includes('sk-owner-secret'), 'secret values are never returned');
        });
        await check('User 1 can still change their own settings (not blocked as owner)', async () => {
            const response = await call('PUT', '/settings', { token: 'token-user1', body: { businessName: 'Owner Co' } });
            assert.notEqual(response.status, 403);
        });

        // ── User 3: unrelated ─────────────────────────────────
        await check('User 3 is refused User 1 workspace for SELECT/INSERT/UPDATE/DELETE', async () => {
            const asIntruder = { token: 'token-user3', owner: USER1 };
            for (const [method, path, body] of [
                ['GET', '/contacts'], ['GET', '/quotations'], ['GET', '/conversations/201/messages'],
                ['POST', '/contacts', { phone: '+919833333333' }],
                ['PUT', '/contacts/101', { name: 'hijacked' }],
                ['DELETE', '/contacts/102'],
            ]) {
                const response = await call(method, path, { ...asIntruder, body });
                assert.equal(response.status, 403, `${method} ${path}`);
                assert.equal(response.data.code, 'WORKSPACE_FORBIDDEN');
            }
            assert.equal(owned('contacts', 101).name, 'Renamed by colleague');
            assert.ok(owned('contacts', 102));
            assert.ok(!store.contacts.some(row => row.phone === '919833333333'));
        });
        await check('User 3 own workspace: no User 1 rows, cross-user ids do nothing', async () => {
            assert.deepEqual(ids((await call('GET', '/contacts', { token: 'token-user3' })).data.data), [121]);
            assert.equal((await call('PUT', '/contacts/102', { token: 'token-user3', body: { name: 'x' } })).status, 404);
            await call('DELETE', '/contacts/102', { token: 'token-user3' });
            assert.ok(owned('contacts', 102), 'User 1 contact survives a delete by User 3');
            assert.equal((await call('GET', '/conversations/201', { token: 'token-user3' })).status, 404);
            assert.deepEqual((await call('GET', '/conversations/201/messages', { token: 'token-user3' })).data, []);
            const created = await call('POST', '/contacts', { token: 'token-user3', body: { phone: '+919844444444', user_id: USER1 } });
            assert.equal(owned('contacts', created.data.id).user_id, USER3, 'body user_id is ignored');
        });
        await check('Spoofed workspace header values are rejected', async () => {
            for (const owner of ['not-a-uuid', `${USER1}'--`, USER3]) {
                assert.equal((await call('GET', '/contacts', { token: 'token-user2', owner })).status, 403, owner);
            }
            assert.deepEqual(ids((await call('GET', '/contacts', { token: 'token-user2', owner: '' })).data.data), [111], 'empty header = own workspace');
        });
        await check('Revoking the share removes access', async () => {
            shares.length = 0;
            clearDataOwnerCache();
            assert.equal((await call('GET', '/contacts', asShared)).status, 403);
            assert.deepEqual((await call('GET', '/workspaces', { token: 'token-user2' })).data.shared, []);
            shares.push({ owner_user_id: USER1, shared_user_id: USER2, created_at: '2026-10-01T00:00:00Z' });
            clearDataOwnerCache();
        });
        await check('Missing migration: shared requests fail closed (503), own data unaffected', async () => {
            rpcMissing = true;
            clearDataOwnerCache();
            const response = await call('GET', '/contacts', asShared);
            assert.equal(response.status, 503);
            assert.equal(response.data.code, 'WORKSPACE_MIGRATION_PENDING');
            assert.equal((await call('GET', '/contacts', { token: 'token-user2' })).status, 200);
            rpcMissing = false;
            clearDataOwnerCache();
        });

        // ── Realtime ───────────────────────────────────────────
        await check('Realtime: shared socket joins shared room; QR events stay owner-only', async () => {
            const emitted = [];
            const io = { to: room => ({ emit: (event) => emitted.push([room, event]) }) };
            realtime.emitToUser(io, USER1, 'message:new', {});
            realtime.emitToUser(io, USER1, 'whatsapp:qr', {});
            assert.deepEqual(emitted, [
                [`user:${USER1}`, 'message:new'],
                [`user:${USER1}:shared`, 'message:new'],
                [`user:${USER1}`, 'whatsapp:qr'],
            ]);

            let middleware;
            realtime.attachRealtimeAuth({ use: fn => { middleware = fn; }, on: () => {} });
            const connect = (token, dataOwner) => new Promise((resolve) => {
                const socket = { handshake: { auth: { token, dataOwner } }, data: {}, rooms: [], join(room) { this.rooms.push(room); } };
                middleware(socket, error => resolve({ error, socket }));
            });
            const colleague = await connect('token-user2', USER1);
            assert.equal(colleague.error, undefined);
            assert.deepEqual(colleague.socket.rooms, [`user:${USER1}:shared`]);
            const owner = await connect('token-user1');
            assert.deepEqual(owner.socket.rooms, [`user:${USER1}`]);
            const intruder = await connect('token-user3', USER1);
            assert.ok(intruder.error, 'unrelated user cannot join');
            assert.deepEqual(intruder.socket.rooms, []);
            const anonymous = await connect(undefined, USER1);
            assert.ok(anonymous.error);
        });
    } finally {
        server.close();
        console.log(results.join('\n'));
    }
    console.log('Shared data access smoke test passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
