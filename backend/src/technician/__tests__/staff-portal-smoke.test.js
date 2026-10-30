// =============================================================
// Smoke test — Staff & Member Login + staff dashboard (/api/staff-portal)
// and personal-link ("referral") attribution on the partner form. Mounts the
// real routers on a throwaway Express app against the in-memory Supabase
// fake. Never boots server.js.
// =============================================================
process.env.SUPABASE_URL = 'https://staff-portal-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.AUTH_DISABLED = '';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.STAFF_SESSION_SECRET = 's'.repeat(48);
process.env.TECHNICIAN_SUBMIT_LIMIT_PER_HOUR = '100';
process.env.TECHNICIAN_STAFF_SUBMIT_LIMIT_PER_HOUR = '100';
process.env.TECHNICIAN_STAFF_VERIFY_LIMIT_PER_15MIN = '200';
process.env.STAFF_LOGIN_LIMIT_PER_15MIN = '200';

const assert = require('node:assert/strict');
const express = require('express');

const REVIEWER = 'aa11aa11-1111-4111-8111-111111111111';
const TOKENS = { 'token-reviewer': REVIEWER };

const { createFakeSupabase, installFakeSupabase } = require('../../database/__tests__/fakeSupabase');
const fake = createFakeSupabase({
    rpc: {
        is_kyc_staff: ({ p_user_id: id }) => ({ data: id === REVIEWER, error: null }),
        resolve_data_owner: ({ p_auth_user_id: auth }) => ({ data: auth, error: null }),
        technician_staff_account_emails: () => ({ data: [], error: null }),
    },
});
const store = fake.store;
const supabase = installFakeSupabase(fake);
supabase.storage = { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }), createSignedUrls: async () => ({ data: [], error: null }) }) };

const auth = require('../../middleware/auth');
auth.supabaseAdmin.auth.getClaims = async (token) => (TOKENS[token]
    ? { data: { claims: { sub: TOKENS[token], email: `${token}@example.com`, role: 'authenticated' } }, error: null }
    : { data: null, error: { message: 'invalid JWT' } });

const { hashPin } = require('../technicianStaff');
const portal = require('../staffPortal');

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const C = 'c0000000-0000-4000-8000-00000000000c';
const staffRow = (id, code, name, pin, extra = {}) => ({
    id, staff_code: code, full_name: name, phone: null, active: true, pin_hash: hashPin(pin), pin_failed_count: 0, pin_locked_until: null,
    pin_must_change: false, target_count: null, target_period: 'month', auth_user_id: null, ...extra,
});
store.technician_staff = [
    staffRow(A, 'SEPL-TN001', 'Anitha Kumar', '9012', { pin_must_change: true, target_count: 3, target_period: 'month' }), // initial PIN
    staffRow(B, 'SEPL-TN002', 'Bala Murugan', '4444'),
    staffRow(C, 'SEPL-TN003', 'Chitra Devi', '5555', { active: false }),
];

const NOW = Date.now();
const iso = (offsetMinutes) => new Date(NOW + offsetMinutes * 60000).toISOString();
const reg = (id, staffId, source, mobile, minutesAgo, extra = {}) => {
    const staff = store.technician_staff.find((row) => row.id === staffId);
    return {
        id, submitted_at: iso(-minutesAgo), status: 'pending', full_name: `Partner ${id.slice(-2)}`, shop_name: 'Motor Works', district: 'Coimbatore', place: 'Pollachi',
        mobile, address: '12, Secret Street', pincode: '642001', state: 'Tamil Nadu', date_of_birth: '1990-05-14', date_of_marriage: '2015-02-01',
        documents: { aadhaar: { path: `technicians/${id}/aadhaar.png` } },
        registration_source: source, staff_id: staff ? staff.id : null, staff_code: staff ? staff.staff_code : null, staff_name: staff ? staff.full_name : null, ...extra,
    };
};
store.technician_partner_registrations = [
    reg('00000000-0000-4000-8000-000000000001', A, 'referral', '9845012345', 5),
    reg('00000000-0000-4000-8000-000000000002', A, 'staff', '9845012346', 60 * 24 * 40), // 40 days ago
    reg('00000000-0000-4000-8000-000000000003', B, 'referral', '9845012347', 10),
    reg('00000000-0000-4000-8000-000000000004', null, 'self', '9845012348', 15),
];

const PARTNER = { full_name: 'Murugan Selvam', district: 'Coimbatore', place: 'Pollachi', mobile: '9000000001', address: '12, Kamaraj Street', pincode: '642001', state: 'Tamil Nadu' };

function buildApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/public/technician', require('../../routes/technicianPublic'));
    app.use('/api/staff-portal', require('../../routes/staffPortal'));
    app.use('/api/technicians', auth.requireAuth, require('../../routes/technicians'));
    return app;
}

async function main() {
    const results = [];
    const check = async (label, fn) => {
        try { await fn(); results.push(`ok   ${label}`); } catch (error) { results.push(`FAIL ${label}`); console.log(results.join('\n')); throw error; }
    };

    await check('session token: signed, 12 h, audience-bound; tampering / expiry / other secret rejected', async () => {
        const staff = store.technician_staff[1];
        const { token, expires_at } = portal.issueSession(staff, NOW);
        assert.equal(Date.parse(expires_at) - Math.floor(NOW / 1000) * 1000, 12 * 3600 * 1000);
        assert.equal(portal.readSession(token).sub, B);
        const [head, body, sig] = token.split('.');
        const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), sub: A })).toString('base64url');
        assert.equal(portal.readSession(`${head}.${forged}.${sig}`), null, 'cannot switch to another staff member');
        assert.equal(portal.readSession(token, NOW + 13 * 3600 * 1000), null, 'expired');
        assert.equal(portal.readSession('nope'), null);
        process.env.STAFF_SESSION_SECRET = 'x'.repeat(48);
        assert.equal(portal.readSession(token), null, 'other secret');
        process.env.STAFF_SESSION_SECRET = 's'.repeat(48);
    });

    await check('mobile masked as 98XXXXX345; IST format "30 Oct 2026, 12:41 PM"', async () => {
        assert.equal(portal.maskMobile('9845012345'), '98XXXXX345');
        const { pathToFileURL } = require('node:url');
        const file = require('path').join(__dirname, '..', '..', '..', '..', 'frontend', 'src', 'staff', 'istTime.js');
        const { formatIst } = await import(pathToFileURL(file).href);
        assert.equal(formatIst('2026-10-30T07:11:00Z'), '30 Oct 2026, 12:41 PM');
        assert.equal(formatIst('2026-09-03T18:45:00Z'), '4 Sep 2026, 12:15 AM', 'next day in India; "Sep", never "Sept"');
        assert.equal(formatIst(''), '');
    });

    const server = buildApp().listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const ORIGIN = 'https://app.example.com';
    const call = async (method, path, { token, body, origin } = {}) => {
        const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.30' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (origin) headers.Origin = origin;
        const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, data: await response.json().catch(() => null), headers: response.headers };
    };
    const submit = async (fields, { staffMode = false } = {}) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        const response = await fetch(`${base}/public/technician${staffMode ? '?staff=1' : ''}`, { method: 'POST', body: form, headers: { 'X-Forwarded-For': '203.0.113.31' } });
        for (const row of store.technician_partner_registrations) { row.submitted_at ||= new Date().toISOString(); row.status ||= 'pending'; }
        return { status: response.status, data: await response.json().catch(() => null) };
    };
    const login = (code, pin) => call('POST', '/staff-portal/login', { body: { staff_code: code, pin } });

    let tokenA;
    let tokenB;
    try {
        await check('login: generic "Invalid Staff ID or PIN" for wrong PIN, unknown ID and empty fields', async () => {
            const wrong = await login('SEPL-TN002', '0000');
            const unknown = await login('SEPL-XX999', '0000');
            const empty = await login('', '');
            for (const result of [wrong, unknown, empty]) {
                assert.equal(result.status, 401);
                assert.equal(result.data.error, 'Invalid Staff ID or PIN.');
            }
            await login('SEPL-TN002', '4444'); // reset B's failure count
        });

        await check('login: success → 12 h token + profile, no PIN hash; initial PIN still works', async () => {
            const result = await login(' sepl-tn001 ', '9012');
            assert.equal(result.status, 200, JSON.stringify(result.data));
            assert.equal(result.headers.get('cache-control'), 'no-store');
            assert.deepEqual(result.data.staff, { staff_code: 'SEPL-TN001', full_name: 'Anitha Kumar', pin_must_change: true, target_count: 3, target_period: 'month' });
            assert.ok(!JSON.stringify(result.data).includes('scrypt'), 'never the PIN hash');
            tokenA = result.data.token;
            tokenB = (await login('SEPL-TN002', '4444')).data.token;
        });

        await check('login: inactive staff refused; 5 wrong PINs lock (423), even with the right PIN', async () => {
            const inactive = await login('SEPL-TN003', '5555');
            assert.equal(inactive.status, 403);
            assert.match(inactive.data.error, /not active/);
            assert.equal((await login('SEPL-TN003', '0000')).status, 401, 'a wrong PIN does not reveal the status');
            for (let attempt = 1; attempt <= 5; attempt++) {
                const result = await login('SEPL-TN002', '1111');
                assert.equal(result.status, attempt < 5 ? 401 : 423, `attempt ${attempt}`);
            }
            const locked = await login('SEPL-TN002', '4444');
            assert.equal(locked.status, 423);
            assert.match(locked.data.error, /locked for 15 minutes/);
            store.technician_staff.find((row) => row.id === B).pin_locked_until = null; // as if 15 minutes passed
        });

        await check('missing / short STAFF_SESSION_SECRET → 503 "not configured on the server", counters untouched; health names it', async () => {
            const saved = process.env.STAFF_SESSION_SECRET;
            for (const value of [undefined, 'too-short']) {
                if (value === undefined) delete process.env.STAFF_SESSION_SECRET;
                else process.env.STAFF_SESSION_SECRET = value;
                const result = await login('SEPL-TN002', '0000');
                assert.equal(result.status, 503);
                assert.deepEqual(result.data, { error: 'Staff login is not configured on the server.', code: 'STAFF_LOGIN_NOT_CONFIGURED' });
                const health = await call('GET', '/staff-portal/health');
                assert.equal(health.status, 200);
                assert.deepEqual(health.data, { configured: false, missing: ['STAFF_SESSION_SECRET'], database: 'ok' });
            }
            process.env.STAFF_SESSION_SECRET = saved;
            assert.equal(store.technician_staff.find((row) => row.id === B).pin_failed_count, 0);
            const ok = await call('GET', '/staff-portal/health');
            assert.deepEqual(ok.data, { configured: true, missing: [], database: 'ok' });
            assert.ok(!JSON.stringify(ok.data).includes(saved), 'no secret in the health answer');
        });

        await check('dashboard routes need a session (401); the admin routes do not accept it', async () => {
            for (const path of ['/staff-portal/me', '/staff-portal/summary', '/staff-portal/registrations', '/staff-portal/link']) {
                assert.equal((await call('GET', path)).status, 401, path);
                assert.equal((await call('GET', path, { token: 'garbage' })).status, 401, path);
            }
            assert.equal((await call('GET', '/technicians', { token: tokenA })).status, 401, 'a staff session is not an admin login');
        });

        await check('registrations: only my own, newest first, masked, no private fields — params cannot widen it', async () => {
            const mine = await call('GET', '/staff-portal/registrations', { token: tokenA });
            assert.equal(mine.status, 200, JSON.stringify(mine.data));
            assert.equal(mine.data.total, 2);
            assert.deepEqual(mine.data.registrations.map((row) => row.id.slice(-1)), ['1', '2'], 'newest first');
            const row = mine.data.registrations[0];
            assert.deepEqual(Object.keys(row).sort(), ['district', 'full_name', 'id', 'mobile', 'place', 'registration_source', 'shop_name', 'status', 'submitted_at']);
            assert.equal(row.mobile, '98XXXXX345');
            const text = JSON.stringify(mine.data);
            for (const secret of ['Secret Street', '1990-05-14', '2015-02-01', 'aadhaar', '9845012345']) assert.ok(!text.includes(secret), `no ${secret}`);
            for (const sneaky of [`?staff=${B}`, `?staff_id=${B}`, `?staff_code=SEPL-TN002`, '?source=self']) {
                const result = await call('GET', `/staff-portal/registrations${sneaky}`, { token: tokenA });
                assert.ok(result.data.registrations.every((item) => item.full_name !== 'Partner 03' && item.full_name !== 'Partner 04'), sneaky);
            }
            const others = await call('GET', '/staff-portal/registrations', { token: tokenB });
            assert.deepEqual(others.data.registrations.map((item) => item.id.slice(-1)), ['3']);
        });

        await check('registrations: filters (filled by, status, India dates) and paging', async () => {
            assert.equal((await call('GET', '/staff-portal/registrations?source=referral', { token: tokenA })).data.total, 1);
            assert.equal((await call('GET', '/staff-portal/registrations?source=staff', { token: tokenA })).data.total, 1);
            assert.equal((await call('GET', '/staff-portal/registrations?status=approved', { token: tokenA })).data.total, 0);
            const old = new Date(NOW - 40 * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
            assert.equal((await call('GET', `/staff-portal/registrations?from=${old}&to=${old}`, { token: tokenA })).data.total, 1);
            const page = await call('GET', '/staff-portal/registrations?page=2', { token: tokenA });
            assert.equal(page.data.page, 2);
            assert.equal(page.data.registrations.length, 0);
            assert.equal(page.data.page_size, 20);
        });

        await check('summary: today / week / month / all time + target (referrals count)', async () => {
            const summary = await call('GET', '/staff-portal/summary', { token: tokenA });
            assert.equal(summary.status, 200, JSON.stringify(summary.data));
            assert.equal(summary.data.counts.all, 2);
            assert.equal(summary.data.counts.today, 1);
            assert.deepEqual(summary.data.by_source, { referral: 1, staff: 1 });
            assert.equal(summary.data.target.target, 3);
            assert.equal(summary.data.target.credited, 1, 'this month: the referral (the Staff-mode one is 40 days old)');
            assert.equal((await call('GET', '/staff-portal/summary', { token: tokenB })).data.target, null, 'no target set');
        });

        await check('personal link: /technician-registration?ref=<own code> on the app origin, with a QR SVG', async () => {
            const link = await call('GET', '/staff-portal/link', { token: tokenA, origin: ORIGIN });
            assert.equal(link.status, 200, JSON.stringify(link.data));
            assert.equal(link.data.url, `${ORIGIN}/technician-registration?ref=SEPL-TN001`);
            assert.match(link.data.qr_svg, /^<svg[\s\S]*<\/svg>\s*$/);
            assert.equal((await call('GET', '/staff-portal/link', { token: tokenA })).status, 400, 'no origin');
        });

        await check('ref lookup: active staff → name; inactive / unknown / malformed → null', async () => {
            assert.deepEqual((await call('GET', '/public/technician/ref/sepl-tn002')).data, { staff: { staff_code: 'SEPL-TN002', full_name: 'Bala Murugan' } });
            for (const code of ['SEPL-TN003', 'SEPL-ZZ999', '%3Cscript%3E']) assert.deepEqual((await call('GET', `/public/technician/ref/${code}`)).data, { staff: null }, code);
        });

        await check('form via ?ref=: referral credited to that staff member; forged staff fields ignored', async () => {
            const result = await submit({ ...PARTNER, mobile: '9000000011', ref_code: 'sepl-tn002', staff_id: A, staff_name: 'Anitha Kumar', registration_source: 'self' });
            assert.equal(result.status, 201, JSON.stringify(result.data));
            assert.deepEqual(result.data.referred_by, { staff_code: 'SEPL-TN002', full_name: 'Bala Murugan' });
            const row = store.technician_partner_registrations.find((item) => item.id === result.data.id);
            assert.equal(row.registration_source, 'referral');
            assert.equal(row.staff_id, B, 'from the code, not the forged staff_id');
            assert.equal(row.staff_name, 'Bala Murugan');
        });

        await check('form via an inactive / unknown ref: still saved, no staff fields', async () => {
            for (const [mobile, code] of [['9000000012', 'SEPL-TN003'], ['9000000013', 'SEPL-NOPE1']]) {
                const result = await submit({ ...PARTNER, mobile, ref_code: code });
                assert.equal(result.status, 201, JSON.stringify(result.data));
                const row = store.technician_partner_registrations.find((item) => item.id === result.data.id);
                for (const key of ['registration_source', 'staff_id', 'staff_code', 'staff_name']) assert.ok(!(key in row), `${code}: ${key} not written`);
            }
        });

        await check('"Fill form for a mechanic": Staff mode with the session token → staff, no PIN', async () => {
            const verify = await call('POST', '/public/technician/staff/verify', { body: { staff_session: tokenA } });
            assert.deepEqual(verify.data.staff, { staff_code: 'SEPL-TN001', full_name: 'Anitha Kumar', via: 'session' });
            const result = await submit({ ...PARTNER, mobile: '9000000014', registration_source: 'staff', staff_session: tokenA }, { staffMode: true });
            assert.equal(result.status, 201, JSON.stringify(result.data));
            const row = store.technician_partner_registrations.find((item) => item.id === result.data.id);
            assert.equal(row.registration_source, 'staff');
            assert.equal(row.staff_id, A);
            const forged = await submit({ ...PARTNER, mobile: '9000000015', registration_source: 'staff', staff_session: `${tokenA}x` }, { staffMode: true });
            assert.equal(forged.status, 400, 'a broken token falls back to Staff ID + PIN');
        });

        await check('admin report counts referrals toward targets', async () => {
            const report = await call('GET', '/technicians/staff/performance', { token: 'token-reviewer' });
            assert.equal(report.status, 200, JSON.stringify(report.data));
            const bala = report.data.staff.find((row) => row.staff_code === 'SEPL-TN002');
            assert.equal(bala.referrals, 2);
            assert.equal(bala.credited, 2);
            assert.equal(report.data.totals.referral, 3);
        });

        await check('change PIN: wrong current refused; success clears pin_must_change and ends old sessions', async () => {
            const wrong = await call('POST', '/staff-portal/pin', { token: tokenA, body: { current_pin: '0000', new_pin: '2468' } });
            assert.equal(wrong.status, 400);
            assert.ok(wrong.data.fields.current_pin);
            assert.equal((await call('POST', '/staff-portal/pin', { token: tokenA, body: { current_pin: '9012', new_pin: '9012' } })).data.fields.new_pin, 'Choose a PIN different from the current one.');
            const changed = await call('POST', '/staff-portal/pin', { token: tokenA, body: { current_pin: '9012', new_pin: '2468' } });
            assert.equal(changed.status, 200, JSON.stringify(changed.data));
            assert.equal(changed.data.staff.pin_must_change, false);
            assert.equal((await call('GET', '/staff-portal/me', { token: tokenA })).status, 401, 'old session ended');
            assert.equal((await call('GET', '/staff-portal/me', { token: changed.data.token })).status, 200);
            assert.equal((await login('SEPL-TN001', '9012')).status, 401, 'old PIN no longer works');
            assert.equal((await login('SEPL-TN001', '2468')).status, 200);
        });

        await check('deactivating a staff member ends their session at once', async () => {
            store.technician_staff.find((row) => row.id === B).active = false;
            assert.equal((await call('GET', '/staff-portal/summary', { token: tokenB })).status, 401);
        });
    } finally {
        server.close();
    }
    console.log(results.join('\n'));
    console.log(`\nstaff portal smoke: ${results.length} checks passed`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
