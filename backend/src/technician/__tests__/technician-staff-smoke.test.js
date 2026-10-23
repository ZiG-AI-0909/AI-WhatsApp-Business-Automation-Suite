// =============================================================
// Smoke test — Staff mode of the mechanic / technician partner form:
// staff roster, Staff ID + PIN check, attribution on registrations,
// counts toward targets. Mounts the real routers on a throwaway Express
// app against the in-memory Supabase fake. Never boots server.js.
// =============================================================
process.env.SUPABASE_URL = 'https://tech-staff-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.AUTH_DISABLED = '';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.TECHNICIAN_SUBMIT_LIMIT_PER_HOUR = '100';
process.env.TECHNICIAN_STAFF_SUBMIT_LIMIT_PER_HOUR = '100';
process.env.TECHNICIAN_STAFF_VERIFY_LIMIT_PER_15MIN = '100';

const assert = require('node:assert/strict');
const express = require('express');

const REVIEWER = 'aa11aa11-1111-4111-8111-111111111111';
const USER = 'bb22bb22-2222-4222-8222-222222222222';
const FIELD_USER = 'cc33cc33-3333-4333-8333-333333333333'; // field staff with an app account
const TOKENS = { 'token-reviewer': REVIEWER, 'token-user': USER, 'token-field': FIELD_USER };
const EMAILS = { [FIELD_USER]: 'field.staff@example.com' };

const { createFakeSupabase, installFakeSupabase } = require('../../database/__tests__/fakeSupabase');
const fake = createFakeSupabase({
    rpc: {
        is_kyc_staff: ({ p_user_id: id }) => ({ data: id === REVIEWER, error: null }),
        resolve_data_owner: ({ p_auth_user_id: auth, p_requested_owner_id: owner }) => ({ data: !owner || owner === auth ? auth : null, error: null }),
        technician_staff_link_account: ({ p_staff_id: id, p_email: email }, store) => {
            const uid = Object.keys(EMAILS).find((key) => EMAILS[key] === String(email).trim().toLowerCase()) || null;
            if (uid) store.technician_staff.find((row) => row.id === id).auth_user_id = uid;
            return { data: uid, error: null };
        },
        technician_staff_account_emails: (_, store) => ({
            data: store.technician_staff.filter((row) => row.auth_user_id).map((row) => ({ staff_id: row.id, email: EMAILS[row.auth_user_id] })),
            error: null,
        }),
    },
});
const store = fake.store;
store.technician_staff = [];
store.technician_partner_registrations = [];
const supabase = installFakeSupabase(fake);
supabase.storage = { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }), createSignedUrls: async () => ({ data: [], error: null }) }) };

const auth = require('../../middleware/auth');
auth.supabaseAdmin.auth.getClaims = async (token) => (TOKENS[token]
    ? { data: { claims: { sub: TOKENS[token], email: `${token}@example.com`, role: 'authenticated' } }, error: null }
    : { data: null, error: { message: 'invalid JWT' } });

const staffService = require('../technicianStaff');

const PARTNER = {
    full_name: 'Murugan Selvam',
    district: 'Coimbatore',
    place: 'Pollachi',
    mobile: '9845012345',
    address: '12, Kamaraj Street, Pollachi',
    pincode: '642001',
    state: 'Tamil Nadu',
};

function buildApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/public/technician', require('../../routes/technicianPublic'));
    app.use('/api/technicians', auth.requireAuth, require('../../routes/technicians'));
    return app;
}

async function main() {
    const results = [];
    const check = async (label, fn) => {
        try { await fn(); results.push(`ok   ${label}`); } catch (error) { results.push(`FAIL ${label}`); console.log(results.join('\n')); throw error; }
    };

    await check('PIN hash: scrypt, salted, verifiable; never the PIN itself', async () => {
        const hash = staffService.hashPin('4821');
        assert.match(hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
        assert.notEqual(hash, staffService.hashPin('4821'), 'a fresh salt each time');
        assert.ok(staffService.pinMatches('4821', hash));
        assert.ok(!staffService.pinMatches('4822', hash));
        assert.ok(!hash.includes('4821'));
    });

    await check('target periods in India time: day, week (from Monday), month', async () => {
        // Thursday 23 Oct 2026, 01:00 IST (still 22 Oct in UTC).
        const now = new Date('2026-10-22T19:30:00Z');
        assert.deepEqual(staffService.periodWindow('day', now), { period: 'day', start: '2026-10-22T18:30:00.000Z', end: '2026-10-23T18:30:00.000Z' });
        assert.deepEqual(staffService.periodWindow('week', now), { period: 'week', start: '2026-10-18T18:30:00.000Z', end: '2026-10-25T18:30:00.000Z' });
        assert.deepEqual(staffService.periodWindow('month', now), { period: 'month', start: '2026-09-30T18:30:00.000Z', end: '2026-10-31T18:30:00.000Z' });
    });

    await check('credit rule: first non-rejected registration per mobile; self never credited', async () => {
        const rows = [
            { id: 'a', mobile: '1', status: 'pending', registration_source: 'self', staff_id: null },
            { id: 'b', mobile: '1', status: 'pending', registration_source: 'staff', staff_id: 's1' }, // already registered
            { id: 'c', mobile: '2', status: 'rejected', registration_source: 'staff', staff_id: 's1' },
            { id: 'd', mobile: '2', status: 'approved', registration_source: 'staff', staff_id: 's2' }, // first valid one
            { id: 'e', mobile: '3', status: 'pending', registration_source: 'staff', staff_id: 's1' },
        ];
        assert.deepEqual([...staffService.creditedIds(rows)].sort(), ['d', 'e']);
    });

    await check('frontend: staff codes translated (English + Tamil), same Staff ID / PIN rules', async () => {
        const { pathToFileURL } = require('node:url');
        const dir = require('path').join(__dirname, '..', '..', '..', '..', 'frontend', 'src', 'technician');
        const form = await import(pathToFileURL(require('path').join(dir, 'technicianForm.js')).href);
        const i18n = await import(pathToFileURL(require('path').join(dir, 'i18n.js')).href);
        for (const code of ['staff_required', 'staff_pin_required', 'staff_invalid', 'staff_locked', 'staff_inactive', 'staff_check_failed']) {
            assert.ok(i18n.TRANSLATIONS.en.errors[code] && i18n.TRANSLATIONS.ta.errors[code], `translation for ${code}`);
        }
        for (const key of ['modeSelf', 'modeStaff', 'staff_code', 'staff_pin', 'staffVerified', 'successStaff']) {
            assert.ok(i18n.TRANSLATIONS.en[key] && i18n.TRANSLATIONS.ta[key], `text for ${key}`);
        }
        assert.deepEqual(form.validateStaffLogin({ staff_code: '', staff_pin: '' }), { staff_code: 'staff_required', staff_pin: 'staff_pin_required' });
        assert.deepEqual(form.validateStaffLogin({ staff_code: ' se-014 ', staff_pin: '4821' }), {});
        assert.equal(form.validateStaffLogin({ staff_code: 'SE-014', staff_pin: '12' }).staff_pin, 'staff_invalid');
        assert.equal(form.normalizeStaffCode(' se 014 '), staffService.normalizeStaffCode(' se 014 '));
    });

    const server = buildApp().listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (method, path, { token, body } = {}) => {
        const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.20' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, data: await response.json().catch(() => null) };
    };
    let stamp = 0;
    const submit = async (fields, { staffMode = false, token } = {}) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        const headers = { 'X-Forwarded-For': '203.0.113.21' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`${base}/public/technician${staffMode ? '?staff=1' : ''}`, { method: 'POST', body: form, headers });
        // The fake has no column defaults: stamp the ones Postgres would set.
        for (const row of store.technician_partner_registrations) {
            row.submitted_at ||= new Date(Date.now() + (stamp++) * 1000).toISOString();
            row.status ||= 'pending';
        }
        return { status: response.status, data: await response.json().catch(() => null) };
    };
    const rows = () => store.technician_partner_registrations;
    const rowById = (id) => rows().find((row) => row.id === id);
    const viaStaff = (fields, code, pin) => submit({ ...PARTNER, ...fields, registration_source: 'staff', staff_code: code, staff_pin: pin }, { staffMode: true });

    let anitha;
    let ravi;
    try {
        await check('roster: reviewers only (401 / 403); validation; duplicate Staff ID refused', async () => {
            assert.equal((await call('GET', '/technicians/staff')).status, 401);
            assert.equal((await call('GET', '/technicians/staff', { token: 'token-user' })).status, 403);
            assert.equal((await call('POST', '/technicians/staff', { token: 'token-user', body: { staff_code: 'X1', full_name: 'X', pin: '1234' } })).status, 403);
            assert.equal((await call('GET', '/technicians/staff/performance', { token: 'token-user' })).status, 403);
            const bad = await call('POST', '/technicians/staff', { token: 'token-reviewer', body: { staff_code: 'a', full_name: 'A', pin: '12', target_count: '0' } });
            assert.equal(bad.status, 400);
            assert.deepEqual(Object.keys(bad.data.fields).sort(), ['full_name', 'pin', 'staff_code', 'target_count']);
            const created = await call('POST', '/technicians/staff', { token: 'token-reviewer', body: { staff_code: ' se-014 ', full_name: '  Anitha  Kumar ', pin: '4821', target_count: '3', target_period: 'month' } });
            assert.equal(created.status, 201, JSON.stringify(created.data));
            anitha = created.data.staff;
            assert.equal(anitha.staff_code, 'SE-014');
            assert.equal(anitha.full_name, 'Anitha Kumar');
            assert.equal(anitha.created_by_email, 'token-reviewer@example.com');
            assert.ok(!('pin_hash' in anitha), 'the PIN hash never leaves the server');
            assert.match(store.technician_staff[0].pin_hash, /^scrypt\$/);
            const again = await call('POST', '/technicians/staff', { token: 'token-reviewer', body: { staff_code: 'SE-014', full_name: 'Someone', pin: '1111' } });
            assert.equal(again.status, 400);
            assert.match(again.data.fields.staff_code, /already used/);
            ravi = (await call('POST', '/technicians/staff', { token: 'token-reviewer', body: { staff_code: 'SE-020', full_name: 'Ravi', pin: '9999', account_email: 'Field.Staff@example.com' } })).data.staff;
            assert.equal(ravi.account_email, 'field.staff@example.com', 'linked to the app account');
            const list = await call('GET', '/technicians/staff', { token: 'token-reviewer' });
            assert.deepEqual(list.data.staff.map((row) => row.staff_code), ['SE-014', 'SE-020']);
            assert.ok(list.data.staff.every((row) => !('pin_hash' in row)));
        });

        await check('verify: wrong PIN / unknown ID look the same; right PIN → name', async () => {
            const wrong = await call('POST', '/public/technician/staff/verify', { body: { staff_code: 'SE-014', staff_pin: '0000' } });
            const unknown = await call('POST', '/public/technician/staff/verify', { body: { staff_code: 'NOPE-1', staff_pin: '0000' } });
            assert.equal(wrong.status, 400);
            assert.deepEqual(wrong.data.fields, { staff_pin: 'staff_invalid' });
            assert.deepEqual(unknown.data.fields, wrong.data.fields, 'does not reveal which IDs exist');
            const ok = await call('POST', '/public/technician/staff/verify', { body: { staff_code: 'se-014', staff_pin: '4821' } });
            assert.equal(ok.status, 200, JSON.stringify(ok.data));
            assert.deepEqual(ok.data.staff, { staff_code: 'SE-014', full_name: 'Anitha Kumar', via: 'pin' });
            assert.equal(store.technician_staff.find((row) => row.id === anitha.id).pin_failed_count, 0, 'a right PIN resets the failures');
            assert.deepEqual((await call('POST', '/public/technician/staff/verify', { body: {} })).data, { staff: null }, 'nothing entered, not signed in');
        });

        await check('signed-in, linked account is recognised without a PIN; others are not', async () => {
            const linked = await call('POST', '/public/technician/staff/verify', { token: 'token-field', body: {} });
            assert.deepEqual(linked.data.staff, { staff_code: 'SE-020', full_name: 'Ravi', via: 'account' });
            assert.deepEqual((await call('POST', '/public/technician/staff/verify', { token: 'token-user', body: {} })).data, { staff: null });
            assert.deepEqual((await call('POST', '/public/technician/staff/verify', { token: 'bogus', body: {} })).data, { staff: null });
        });

        await check('5 wrong PINs lock the Staff ID (even the right PIN); a new PIN unlocks it', async () => {
            for (let attempt = 1; attempt <= 5; attempt++) {
                const result = await call('POST', '/public/technician/staff/verify', { body: { staff_code: 'SE-014', staff_pin: '1111' } });
                assert.equal(result.data.fields.staff_pin, attempt < 5 ? 'staff_invalid' : 'staff_locked', `attempt ${attempt}`);
            }
            assert.equal((await call('POST', '/public/technician/staff/verify', { body: { staff_code: 'SE-014', staff_pin: '4821' } })).data.fields.staff_pin, 'staff_locked');
            const before = rows().length;
            assert.equal((await viaStaff({}, 'SE-014', '4821')).status, 400, 'locked → cannot register');
            assert.equal(rows().length, before);
            const reset = await call('PUT', `/technicians/staff/${anitha.id}`, { token: 'token-reviewer', body: { pin: '5555' } });
            assert.equal(reset.status, 200, JSON.stringify(reset.data));
            assert.equal((await call('POST', '/public/technician/staff/verify', { body: { staff_code: 'SE-014', staff_pin: '4821' } })).data.fields.staff_pin, 'staff_invalid', 'old PIN no longer works');
            assert.equal((await call('POST', '/public/technician/staff/verify', { body: { staff_code: 'SE-014', staff_pin: '5555' } })).status, 200);
        });

        await check('self mode: source left to the default (self), staff fields ignored even if sent', async () => {
            const result = await submit({ ...PARTNER, mobile: '9000000001', staff_code: 'SE-014', staff_pin: '5555', staff_id: anitha.id, staff_name: 'Anitha Kumar' });
            assert.equal(result.status, 201, JSON.stringify(result.data));
            assert.ok(!result.data.registered_by);
            const row = rowById(result.data.id);
            for (const key of ['registration_source', 'staff_id', 'staff_code', 'staff_name']) assert.ok(!(key in row), `${key} not written`);
        });

        await check('staff mode: missing / wrong staff → 400 field codes, nothing saved', async () => {
            const before = rows().length;
            const missing = await viaStaff({ mobile: '9000000002' }, '', '');
            assert.equal(missing.status, 400);
            assert.deepEqual(missing.data.fields, { staff_code: 'staff_required', staff_pin: 'staff_pin_required' });
            assert.equal((await viaStaff({ mobile: '9000000002' }, 'SE-014', '0000')).data.fields.staff_pin, 'staff_invalid');
            const mixed = await viaStaff({ mobile: '12' }, 'SE-014', '5555');
            assert.deepEqual(mixed.data.fields, { mobile: 'invalid_mobile' }, 'other field errors still block the save');
            const modeLost = await submit({ ...PARTNER, mobile: '9000000002' }, { staffMode: true });
            assert.equal(modeLost.status, 400, 'staff bucket used without Staff mode');
            assert.equal(rows().length, before, 'failed submissions add nothing (so count nothing)');
            await call('POST', '/public/technician/staff/verify', { body: { staff_code: 'SE-014', staff_pin: '5555' } }); // reset failures
        });

        let staffRegistration;
        await check('staff mode: attribution saved once; retry with the same id adds nothing', async () => {
            const clientId = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
            const first = await viaStaff({ mobile: '9000000003', client_submission_id: clientId }, 'SE-014', '5555');
            assert.equal(first.status, 201, JSON.stringify(first.data));
            assert.deepEqual(first.data.registered_by, { staff_code: 'SE-014', full_name: 'Anitha Kumar' });
            staffRegistration = rowById(clientId);
            assert.equal(staffRegistration.registration_source, 'staff');
            assert.equal(staffRegistration.staff_id, anitha.id);
            assert.equal(staffRegistration.staff_code, 'SE-014');
            assert.equal(staffRegistration.staff_name, 'Anitha Kumar');
            const before = rows().length;
            const retry = await viaStaff({ mobile: '9000000003', client_submission_id: clientId }, 'SE-014', '5555');
            assert.equal(retry.status, 200);
            assert.equal(retry.data.duplicate, true);
            assert.deepEqual(retry.data.registered_by, first.data.registered_by);
            assert.equal(rows().length, before);
        });

        await check('staff mode via a linked, signed-in account (no PIN)', async () => {
            const result = await submit({ ...PARTNER, mobile: '9000000004', registration_source: 'staff' }, { staffMode: true, token: 'token-field' });
            assert.equal(result.status, 201, JSON.stringify(result.data));
            assert.equal(rowById(result.data.id).staff_id, ravi.id);
        });

        await check('performance: counted once per mobile, self never counted, rejected not counted', async () => {
            // Anitha re-registers the self-registered partner (not counted), then a new one (counted).
            assert.equal((await viaStaff({ mobile: '9000000001' }, 'SE-014', '5555')).status, 201);
            assert.equal((await viaStaff({ mobile: '9000000005' }, 'SE-014', '5555')).status, 201);
            const report = await call('GET', '/technicians/staff/performance', { token: 'token-reviewer' });
            assert.equal(report.status, 200, JSON.stringify(report.data));
            const byCode = Object.fromEntries(report.data.staff.map((row) => [row.staff_code, row]));
            assert.equal(byCode['SE-014'].submitted, 3);
            assert.equal(byCode['SE-014'].credited, 2);
            assert.equal(byCode['SE-014'].duplicates, 1);
            assert.equal(byCode['SE-020'].credited, 1);
            assert.deepEqual(report.data.totals, { all: rows().length, self: 1, staff: 4, credited: 3 });
            assert.equal(byCode['SE-014'].target.target, 3);
            assert.equal(byCode['SE-014'].target.credited, 2);
            assert.equal(byCode['SE-014'].target.met, false);
            assert.equal(byCode['SE-020'].target, null, 'no target set');
            assert.equal(report.data.staff[0].staff_code, 'SE-014', 'highest count first');

            // Rejecting a counted registration removes it from the count; a review never moves attribution.
            const review = await call('PUT', `/technicians/${staffRegistration.id}/review`, { token: 'token-reviewer', body: { status: 'rejected', staff_id: ravi.id, registration_source: 'self' } });
            assert.equal(review.status, 200);
            assert.equal(rowById(staffRegistration.id).staff_id, anitha.id, 'attribution unchanged by a review');
            assert.equal(rowById(staffRegistration.id).registration_source, 'staff');
            const after = (await call('GET', '/technicians/staff/performance', { token: 'token-reviewer' })).data.staff.find((row) => row.staff_code === 'SE-014');
            assert.equal(after.credited, 1);
            assert.equal(after.rejected, 1);
            assert.equal(after.submitted, 3, 'editing does not add registrations');
        });

        await check('performance: date filter (India days)', async () => {
            rows().find((row) => row.mobile === '9000000005').submitted_at = '2026-09-10T06:00:00Z';
            const september = await call('GET', '/technicians/staff/performance?from=2026-09-01&to=2026-09-30', { token: 'token-reviewer' });
            const anithaSeptember = september.data.staff.find((row) => row.staff_code === 'SE-014');
            assert.equal(anithaSeptember.submitted, 1);
            assert.equal(anithaSeptember.credited, 1);
            assert.deepEqual(september.data.totals, { all: 1, self: 0, staff: 1, credited: 1 });
            assert.equal(september.data.range.from, '2026-08-31T18:30:00.000Z');
        });

        await check('inactive staff cannot register; history and counts stay', async () => {
            assert.equal((await call('PUT', `/technicians/staff/${anitha.id}`, { token: 'token-reviewer', body: { active: false } })).status, 200);
            const refused = await viaStaff({ mobile: '9000000006' }, 'SE-014', '5555');
            assert.deepEqual(refused.data.fields, { staff_code: 'staff_inactive' });
            assert.equal((await viaStaff({ mobile: '9000000006' }, 'SE-014', '0000')).data.fields.staff_pin, 'staff_invalid', 'a wrong PIN does not reveal the status');
            const report = (await call('GET', '/technicians/staff/performance', { token: 'token-reviewer' })).data.staff.find((row) => row.staff_code === 'SE-014');
            assert.equal(report.active, false);
            assert.equal(report.submitted, 3);
        });

        await check('list + export: Registered by column and filters', async () => {
            const self = await call('GET', '/technicians?source=self', { token: 'token-reviewer' });
            assert.ok(self.data.registrations.every((row) => row.registration_source !== 'staff'));
            const anithas = await call('GET', `/technicians?staff=${anitha.id}`, { token: 'token-reviewer' });
            assert.equal(anithas.data.registrations.length, 3);
            assert.ok(anithas.data.registrations.every((row) => row.staff_name === 'Anitha Kumar'));
            assert.equal((await call('GET', '/technicians?q=anitha', { token: 'token-reviewer' })).data.registrations.length, 3, 'search finds the staff name');
            const response = await fetch(`${base}/technicians/export/excel?source=staff`, { headers: { Authorization: 'Bearer token-reviewer' } });
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
            const sheet = workbook.getWorksheet('Partner registrations');
            const header = sheet.getRow(1).values.filter(Boolean);
            assert.deepEqual(header.slice(3, 6), ['Registered By', 'Staff ID', 'Staff Name']);
            assert.equal(sheet.rowCount, 1 + 4, "header + the 4 staff registrations");
            assert.equal(sheet.getRow(2).getCell(4).value, 'Staff-registered');
            assert.match(String(workbook.getWorksheet('Export info').getRow(2).getCell(2).value), /registered by=staff/);
        });
    } finally {
        server.close();
    }
    console.log(results.join('\n'));
    console.log(`\ntechnician staff mode smoke: ${results.length} checks passed`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
