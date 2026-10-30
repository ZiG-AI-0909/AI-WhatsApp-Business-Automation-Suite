// =============================================================
// Smoke test — Team & access (super admin gives areas by registered email;
// everyone works on one company workspace). Mounts the real auth
// middleware, team / KYC / technician routers and the area checks the way
// server.js does, with stand-in handlers for the heavy WhatsApp routes,
// against the in-memory Supabase fake. Never boots server.js; it reads
// server.js as text to check every signed-in route group has an area.
// =============================================================
process.env.SUPABASE_URL = 'https://team-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.AUTH_DISABLED = '';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
delete process.env.SUPER_ADMIN_EMAILS;

const assert = require('node:assert/strict');
const express = require('express');

const ID = {
    boss: 'b0550000-0000-4000-8000-000000000001',
    wa: 'aa000000-0000-4000-8000-000000000002',
    docs: 'dd000000-0000-4000-8000-000000000003',
    tech: 'cc000000-0000-4000-8000-000000000004',
    nobody: 'ee000000-0000-4000-8000-000000000005',
    owner2: 'ff000000-0000-4000-8000-000000000006',
};
const EMAIL = { boss: 'Boss@Sudarshan.in', wa: 'wa@example.com', docs: 'docs@example.com', tech: 'tech@example.com', nobody: 'new@example.com', owner2: 'office@sudarshan.in' };
const TOKENS = Object.fromEntries(Object.keys(ID).map((key) => [`t-${key}`, key]));
const ACCOUNTS = Object.keys(ID).map((key) => ({ user_id: ID[key], email: EMAIL[key].toLowerCase(), created_at: '2026-10-01T00:00:00Z', last_sign_in_at: null }));

const { createFakeSupabase, installFakeSupabase } = require('../../database/__tests__/fakeSupabase');
const fake = createFakeSupabase({
    rpc: {
        resolve_data_owner: ({ p_auth_user_id: auth, p_requested_owner_id: owner }) => ({ data: !owner || owner === auth ? auth : (owner === ID.owner2 && auth === ID.docs ? owner : null), error: null }),
        is_kyc_staff: ({ p_user_id: id }) => ({ data: id === ID.tech, error: null }),
        team_list_accounts: () => ({ data: ACCOUNTS, error: null }),
        team_find_account: ({ p_email: email }) => ({ data: ACCOUNTS.filter((row) => row.email === String(email).trim().toLowerCase()), error: null }),
        technician_staff_account_emails: () => ({ data: [], error: null }),
    },
});
const store = fake.store;
store.team_members = [];
store.team_settings = [{ id: 1, company_owner_id: null }];
store.technician_partner_registrations = [];
store.kyc_submissions = [];
installFakeSupabase(fake);

const auth = require('../../middleware/auth');
auth.supabaseAdmin.auth.getClaims = async (token) => (TOKENS[token]
    ? { data: { claims: { sub: ID[TOKENS[token]], email: EMAIL[TOKENS[token]], role: 'authenticated' } }, error: null }
    : { data: null, error: { message: 'invalid JWT' } });
auth.supabaseAdmin.auth.admin.getUserById = async (id) => ({ data: { user: ACCOUNTS.find((row) => row.user_id === id) ? { email: ACCOUNTS.find((row) => row.user_id === id).email } : null }, error: null });

const team = require('../teamAccess');
const { requireModule, onlyFor, clearTeamCache } = team;

// Stand-in for a data route: answers whose data it acted on.
const echo = () => { const router = express.Router(); router.all('*', (req, res) => res.json({ owner: req.user.id, shared: req.user.sharedAccess })); return router; };

function buildApp() {
    const app = express();
    app.use(express.json());
    const { requireAuth } = auth;
    const allowSettingsRead = (req, res, next) => (req.method === 'GET' ? next() : requireModule('settings')(req, res, next));
    app.use('/api/team', requireAuth, require('../../routes/team'));
    app.use('/api/contacts', requireAuth, requireModule('whatsapp'), echo());
    app.use('/api/settings', requireAuth, allowSettingsRead, echo());
    app.use('/api/proforma', requireAuth, requireModule('proforma'), echo());
    app.use('/api/copilot', requireAuth, requireModule('ask_ai', 'whatsapp'), echo());
    app.use('/api', requireAuth, onlyFor(/^\/(quotations(\/|$)|boq\/[^/]+\/quotation$)/, requireModule('documents')), (() => {
        const router = express.Router();
        router.all(['/quotations', '/quotations/*', '/boq/:id/quotation'], (req, res) => res.json({ owner: req.user.id }));
        return router;
    })());
    app.use('/api/kyc', requireAuth, require('../../routes/kyc'));
    app.use('/api/technicians', requireAuth, require('../../routes/technicians'));
    app.use('/api/campaigns', requireAuth, requireModule('whatsapp'), echo());
    return app;
}

async function main() {
    const results = [];
    const check = async (label, fn) => {
        try { await fn(); results.push(`ok   ${label}`); } catch (error) { results.push(`FAIL ${label}`); console.log(results.join('\n')); throw error; }
    };

    await check('server.js: every signed-in route group checks an area (or is meant for everyone)', async () => {
        const source = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'server.js'), 'utf8');
        const mounts = [...source.matchAll(/^app\.use\('([^']+)',\s*requireAuth,([^\n]*)/gm)].map((match) => ({ path: match[1], rest: match[2] }));
        assert.ok(mounts.length >= 20, `found ${mounts.length} mounts`);
        // Areas checked inside the router, or open to every signed-in account on purpose.
        const inRouter = new Set(['/api/kyc', '/api/technicians', '/api/storage', '/api/workspaces', '/api/team']);
        for (const mount of mounts) {
            if (inRouter.has(mount.path)) continue;
            if (mount.path === '/api' && /^\s*\(req, res\) => \{\s*$/.test(mount.rest)) continue; // the final 404 catch-all
            assert.ok(/requireModule\(|allowSettingsRead/.test(mount.rest), `${mount.path} has no area check`);
        }
    });

    const server = buildApp().listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (method, path, who, { body, headers = {} } = {}) => {
        const response = await fetch(`${base}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer t-${who}` } : {}), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, data: await response.json().catch(() => null) };
    };

    try {
        await check('before SUPER_ADMIN_EMAILS: behaves as today (own data, every area, KYC areas = KYC staff list)', async () => {
            const me = await call('GET', '/team/me', 'nobody');
            assert.equal(me.status, 200);
            assert.equal(me.data.enforced, false);
            assert.deepEqual(me.data.permissions, ['whatsapp', 'documents', 'proforma', 'ask_ai', 'settings']);
            assert.deepEqual((await call('GET', '/contacts', 'nobody')).data, { owner: ID.nobody, shared: false });
            assert.equal((await call('GET', '/technicians', 'nobody')).status, 403, 'not on the KYC staff list');
            assert.equal((await call('GET', '/technicians', 'tech')).status, 200, 'KYC staff');
            assert.deepEqual((await call('GET', '/team/me', 'tech')).data.permissions, ['whatsapp', 'documents', 'proforma', 'ask_ai', 'vendor_kyc', 'technicians', 'storage', 'settings']);
            const shared = await call('GET', '/contacts', 'docs', { headers: { 'X-Data-Owner': ID.owner2 } });
            assert.deepEqual(shared.data, { owner: ID.owner2, shared: true }, 'shared workspaces still work');
            assert.equal((await call('GET', '/team', 'tech')).status, 403, 'no super admins yet');
        });

        process.env.SUPER_ADMIN_EMAILS = 'boss@sudarshan.in, someone-not-signed-up@x.in';
        clearTeamCache();

        await check('on: no row = no access anywhere; own (empty) data', async () => {
            const me = await call('GET', '/team/me', 'nobody');
            assert.deepEqual(me.data, { enforced: true, super_admin: false, permissions: [], email: EMAIL.nobody, company_email: null });
            for (const path of ['/contacts', '/proforma', '/quotations', '/technicians', '/kyc/access', '/campaigns']) {
                const result = await call('GET', path, 'nobody');
                if (path === '/kyc/access') { assert.deepEqual(result.data, { staff: false }); continue; }
                assert.equal(result.status, 403, path);
                assert.equal(result.data.code, 'NO_ACCESS');
            }
            assert.equal((await call('GET', '/technicians', 'tech')).status, 403, 'the old KYC staff list no longer counts');
            assert.deepEqual((await call('GET', '/settings', 'nobody')).data, { owner: ID.nobody, shared: false });
        });

        await check('env super admin (any letter case): every area, owns the company workspace', async () => {
            const me = await call('GET', '/team/me', 'boss');
            assert.equal(me.data.super_admin, true);
            assert.deepEqual(me.data.permissions, team.MODULES);
            assert.equal(me.data.company_email, 'boss@sudarshan.in');
            assert.deepEqual((await call('GET', '/contacts', 'boss')).data, { owner: ID.boss, shared: false }, 'the owner works on own data, not "shared"');
            const list = await call('GET', '/team', 'boss');
            assert.equal(list.status, 200);
            assert.equal(list.data.company_owner.email, 'boss@sudarshan.in');
            assert.equal(list.data.accounts.length, ACCOUNTS.length);
            assert.ok(list.data.accounts.find((row) => row.user_id === ID.boss).env_super_admin);
        });

        await check('only super admins manage the team', async () => {
            for (const who of ['nobody', 'wa']) {
                assert.equal((await call('GET', '/team', who)).status, 403);
                assert.equal((await call('POST', '/team/members', who, { body: { email: EMAIL.nobody, permissions: ['whatsapp'] } })).status, 403);
            }
            assert.equal((await call('GET', '/team')).status, 401);
        });

        await check('give access by registered email; unknown email / unknown area refused', async () => {
            const unknown = await call('POST', '/team/members', 'boss', { body: { email: 'nobody-here@x.in', permissions: ['whatsapp'] } });
            assert.equal(unknown.status, 404);
            assert.equal(unknown.data.code, 'TEAM_NO_ACCOUNT');
            assert.equal((await call('POST', '/team/members', 'boss', { body: { email: EMAIL.wa, permissions: ['whatsapp', 'root'] } })).status, 400);
            for (const [who, permissions] of [['wa', ['whatsapp']], ['docs', ['proforma', 'documents', 'documents']], ['tech', ['technicians']]]) {
                const added = await call('POST', '/team/members', 'boss', { body: { email: ` ${EMAIL[who].toUpperCase()} `, permissions } });
                assert.equal(added.status, 201, JSON.stringify(added.data));
            }
            assert.deepEqual(store.team_members.find((row) => row.user_id === ID.docs).permissions, ['documents', 'proforma'], 'cleaned + standard order');
            assert.equal(store.team_members.find((row) => row.user_id === ID.docs).updated_by_email, EMAIL.boss);
        });

        await check('members work on the company workspace, only in their areas; header ignored', async () => {
            assert.deepEqual((await call('GET', '/contacts', 'wa')).data, { owner: ID.boss, shared: true });
            assert.deepEqual((await call('GET', '/contacts', 'wa', { headers: { 'X-Data-Owner': ID.wa } })).data, { owner: ID.boss, shared: true }, 'cannot ask for other data');
            assert.equal((await call('GET', '/proforma', 'wa')).status, 403);
            assert.equal((await call('GET', '/quotations', 'wa')).status, 403);
            assert.equal((await call('GET', '/copilot/brief', 'wa')).status, 200, 'copilot comes with WhatsApp');
            assert.equal((await call('GET', '/technicians', 'wa')).status, 403);
            assert.deepEqual((await call('GET', '/quotations/5', 'docs')).data, { owner: ID.boss });
            assert.equal((await call('POST', '/boq/9/quotation', 'docs')).status, 200);
            assert.equal((await call('GET', '/contacts', 'docs')).status, 403);
            assert.equal((await call('GET', '/technicians', 'tech')).status, 200);
            assert.deepEqual((await call('GET', '/kyc/access', 'tech')).data, { staff: false }, 'technicians ≠ vendor KYC');
            assert.equal((await call('GET', '/kyc/submissions', 'tech')).status, 403);
            assert.equal((await call('PUT', '/settings', 'wa', { body: {} })).status, 403, 'changing settings needs the Settings area');
            assert.deepEqual((await call('GET', '/team/me', 'wa')).data, { enforced: true, super_admin: false, permissions: ['whatsapp'], email: EMAIL.wa, company_email: 'boss@sudarshan.in' });
        });

        await check('changes apply at once; removing access → back to nothing', async () => {
            const wa = store.team_members.find((row) => row.user_id === ID.wa);
            assert.equal((await call('PUT', `/team/members/${ID.wa}`, 'boss', { body: { permissions: ['whatsapp', 'proforma'] } })).status, 200);
            assert.equal((await call('GET', '/proforma', 'wa')).status, 200);
            assert.deepEqual(wa.permissions, ['whatsapp', 'proforma']);
            assert.equal((await call('DELETE', `/team/members/${ID.wa}`, 'boss')).status, 200);
            assert.equal((await call('GET', '/contacts', 'wa')).status, 403);
            assert.deepEqual((await call('GET', '/team/me', 'wa')).data.permissions, []);
        });

        await check('super admins can promote; env super admins and yourself cannot be demoted', async () => {
            assert.equal((await call('PUT', `/team/members/${ID.docs}`, 'boss', { body: { permissions: [], is_super_admin: true } })).status, 200);
            assert.equal((await call('GET', '/team', 'docs')).status, 200, 'docs is now a super admin');
            assert.deepEqual((await call('GET', '/team/me', 'docs')).data.permissions, team.MODULES);
            const envDemote = await call('PUT', `/team/members/${ID.boss}`, 'docs', { body: { permissions: [], is_super_admin: false } });
            assert.equal(envDemote.status, 400);
            assert.equal(envDemote.data.code, 'TEAM_ENV_SUPER_ADMIN');
            assert.equal((await call('DELETE', `/team/members/${ID.boss}`, 'docs')).data.code, 'TEAM_ENV_SUPER_ADMIN');
            assert.equal((await call('PUT', `/team/members/${ID.docs}`, 'docs', { body: { permissions: [], is_super_admin: false } })).data.code, 'TEAM_SELF_DEMOTE');
            assert.equal((await call('PUT', `/team/members/${ID.docs}`, 'boss', { body: { permissions: ['documents'], is_super_admin: false } })).status, 200, 'another super admin can');
            assert.equal((await call('GET', '/team', 'docs')).status, 403);
            assert.equal((await call('PUT', '/team/members/not-a-uuid', 'boss', { body: { permissions: [] } })).status, 404);
        });

        await check('company workspace can be moved to another registered account', async () => {
            assert.equal((await call('PUT', '/team/company', 'boss', { body: { email: 'nobody-here@x.in' } })).status, 404);
            assert.equal((await call('PUT', '/team/company', 'boss', { body: { email: EMAIL.owner2 } })).status, 200);
            assert.deepEqual((await call('GET', '/quotations', 'docs')).data, { owner: ID.owner2 });
            assert.deepEqual((await call('GET', '/contacts', 'boss')).data, { owner: ID.owner2, shared: true }, 'the super admin now works on that data too');
            assert.equal((await call('GET', '/team', 'boss')).data.company_owner.email, EMAIL.owner2);
        });
    } finally {
        server.close();
        delete process.env.SUPER_ADMIN_EMAILS;
    }
    console.log(results.join('\n'));
    console.log(`\nteam access smoke: ${results.length} checks passed`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
