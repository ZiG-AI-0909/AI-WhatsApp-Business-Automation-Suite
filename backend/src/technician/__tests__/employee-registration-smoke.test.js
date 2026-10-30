// =============================================================
// Smoke test — employee self-registration: public form → Employee ID
// SEPL-{STATE}{NNN} + initial PIN, duplicate / retry handling, the
// management list, export and edits never exposing PINs. Mounts the real
// routers on a throwaway Express app against the in-memory Supabase fake,
// whose register_employee() mirrors the SQL function in
// supabase-employee-registration-migration.sql. Never boots server.js.
// =============================================================
process.env.SUPABASE_URL = 'https://employee-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.AUTH_DISABLED = '';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.EMPLOYEE_REGISTER_LIMIT_PER_HOUR = '200';
process.env.TECHNICIAN_STAFF_VERIFY_LIMIT_PER_15MIN = '100';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const REVIEWER = 'aa11aa11-1111-4111-8111-111111111111';
const USER = 'bb22bb22-2222-4222-8222-222222222222';
const TOKENS = { 'token-reviewer': REVIEWER, 'token-user': USER };

// Same rules as public.register_employee(): per-state counters that only go
// up, skip taken codes, one roster row per mobile, client id = same submission.
function registerEmployeeRpc(params, store) {
    const { p_full_name: name, p_phone: phone, p_email: email, p_state: state, p_state_code: code, p_pin_hash: pinHash, p_client_id: clientId } = params;
    if (!/^[A-Z]{2}$/.test(code) || !/^[6-9][0-9]{9}$/.test(phone)) return { data: null, error: { code: '23514', message: 'Invalid employee registration.' } };
    const pick = (outcome, row) => ({ data: [{ outcome, id: row?.id ?? null, staff_code: row?.staff_code ?? null, phone: row?.phone ?? null, created_at: row?.created_at ?? null }], error: null });
    const repeat = clientId && store.technician_staff.find((row) => row.client_submission_id === clientId);
    if (repeat) return pick('repeat', repeat);
    if (store.technician_staff.some((row) => row.phone === phone)) return pick('duplicate');
    let staffCode;
    do {
        store.sequences[code] = (store.sequences[code] || 0) + 1;
        staffCode = `SEPL-${code}${String(store.sequences[code]).padStart(3, '0')}`;
    } while (store.technician_staff.some((row) => row.staff_code === staffCode));
    const row = {
        id: crypto.randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        staff_code: staffCode, full_name: name, phone, email: email || null, state, state_code: code,
        pin_hash: pinHash, pin_must_change: true, pin_failed_count: 0, pin_locked_until: null,
        active: true, registration_source: 'self', client_submission_id: clientId, target_count: null, target_period: 'month', auth_user_id: null,
    };
    store.technician_staff.push(row);
    return pick('created', row);
}

const { createFakeSupabase, installFakeSupabase } = require('../../database/__tests__/fakeSupabase');
const fake = createFakeSupabase({
    rpc: {
        is_kyc_staff: ({ p_user_id: id }) => ({ data: id === REVIEWER, error: null }),
        resolve_data_owner: ({ p_auth_user_id: auth, p_requested_owner_id: owner }) => ({ data: !owner || owner === auth ? auth : null, error: null }),
        technician_staff_account_emails: () => ({ data: [], error: null }),
        register_employee: registerEmployeeRpc,
        // Same rules as public.delete_technician_staff().
        delete_technician_staff: ({ p_staff_id: id }, store) => {
            const row = store.technician_staff.find((item) => item.id === id);
            if (!row) return { data: 'not_found', error: null };
            if (store.technician_partner_registrations.some((item) => item.staff_id === id)) return { data: 'has_registrations', error: null };
            const match = /^SEPL-([A-Z]{2})([0-9]+)$/.exec(row.staff_code);
            if (match) store.sequences[match[1]] = Math.max(store.sequences[match[1]] || 0, Number(match[2]));
            store.technician_staff.splice(store.technician_staff.indexOf(row), 1);
            return { data: 'deleted', error: null };
        },
    },
});
const store = fake.store;
store.technician_staff = [];
store.technician_partner_registrations = [];
store.sequences = {};
installFakeSupabase(fake);

const auth = require('../../middleware/auth');
auth.supabaseAdmin.auth.getClaims = async (token) => (TOKENS[token]
    ? { data: { claims: { sub: TOKENS[token], email: `${token}@example.com`, role: 'authenticated' } }, error: null }
    : { data: null, error: { message: 'invalid JWT' } });

const employees = require('../employeeRegistration');
const staffService = require('../technicianStaff');

function buildApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/public/employee-registration', require('../../routes/employeePublic'));
    app.use('/api/public/technician', require('../../routes/technicianPublic'));
    app.use('/api/technicians', auth.requireAuth, require('../../routes/technicians'));
    return app;
}

async function main() {
    const results = [];
    const check = async (label, fn) => {
        try { await fn(); results.push(`ok   ${label}`); } catch (error) { results.push(`FAIL ${label}`); console.log(results.join('\n')); throw error; }
    };

    await check('28 states, unique two-letter codes; ID format pads to 3 digits, never truncates', async () => {
        assert.equal(employees.STATES.length, 28);
        const codes = Object.values(employees.STATE_CODES);
        assert.equal(new Set(codes).size, 28);
        assert.ok(codes.every((code) => /^[A-Z]{2}$/.test(code)));
        assert.equal(employees.STATE_CODES['Tamil Nadu'], 'TN');
        assert.equal(employees.STATE_CODES.Telangana, 'TS');
        assert.equal(employees.STATE_CODES.Odisha, 'OD');
        assert.equal(employees.formatEmployeeId('TN', 1), 'SEPL-TN001');
        assert.equal(employees.formatEmployeeId('KA', 10), 'SEPL-KA010');
        assert.equal(employees.formatEmployeeId('MH', 999), 'SEPL-MH999');
        assert.equal(employees.formatEmployeeId('MH', 1000), 'SEPL-MH1000');
        assert.match(employees.formatEmployeeId('MH', 1000), /^[A-Z0-9][A-Z0-9-]{1,19}$/, 'still a valid Staff ID');
    });

    await check('PIN = last 4 digits of the normalised mobile (+91, 0, spaces)', async () => {
        for (const input of ['9876543210', '+91 98765 43210', '919876543210', '098765-43210']) assert.equal(employees.pinFromMobile(input), '3210', input);
        assert.equal(employees.maskMobile('+91 9876543210'), '+91 ••••••3210');
    });

    await check('validation: required fields, bad mobile / state / email', async () => {
        const empty = employees.validateEmployee({});
        assert.deepEqual(Object.keys(empty.errors).sort(), ['email', 'full_name', 'mobile', 'state'], 'email is required');
        const bad = employees.validateEmployee({ full_name: 'Ravi', mobile: '12345', state: 'Delhi', email: 'nope' });
        assert.deepEqual(Object.keys(bad.errors).sort(), ['email', 'mobile', 'state']);
        assert.ok(employees.validateEmployee({ full_name: 'Ravi', mobile: '5876543210', state: 'Goa', email: 'r@x.in' }).errors.mobile, 'Indian mobiles start 6–9');
        assert.equal(employees.validateEmployee({ full_name: 'Ravi', mobile: '9876543210', state: 'Goa' }).errors.email, 'Enter your email address.');
        assert.deepEqual(employees.validateEmployee({ full_name: '  Ravi   Kumar ', mobile: '9876543210', state: 'Goa', email: 'ravi@example.com' }).errors, {});
    });

    await check('frontend mirrors the backend: states, codes, validation, filter', async () => {
        const { pathToFileURL } = require('node:url');
        const file = require('path').join(__dirname, '..', '..', '..', '..', 'frontend', 'src', 'technician', 'employeeForm.js');
        const form = await import(pathToFileURL(file).href);
        assert.deepEqual(form.STATE_CODES, employees.STATE_CODES);
        for (const body of [{}, { full_name: 'R', mobile: '12', state: 'X', email: 'y' }, { full_name: 'Ravi', mobile: '+91 98765 43210', state: 'Kerala', email: 'r@x.in' }]) {
            const values = { full_name: '', mobile: '', state: '', email: '', ...body };
            assert.deepEqual(form.validateEmployeeForm(values), employees.validateEmployee(body).errors, JSON.stringify(body));
        }
        const rows = [{ staff_code: 'SEPL-TN001', full_name: 'Anu', phone: '9876543210', state: 'Tamil Nadu' }, { staff_code: 'SEPL-KA001', full_name: 'Babu', phone: '9000000000', state: 'Karnataka' }];
        for (const filters of [{ q: 'tn0' }, { q: '43210' }, { state: 'Karnataka' }, { q: 'babu', state: 'Tamil Nadu' }]) {
            assert.deepEqual(form.filterEmployees(rows, filters), employees.filterEmployees(rows, filters), JSON.stringify(filters));
        }
        const slip = form.registrationDetailsText({ employee: { full_name: 'Anu', employee_id: 'SEPL-TN001', state: 'Tamil Nadu', mobile_masked: '+91 ••••••3210', registered_at: '2026-10-24T05:00:00Z' }, pin: '3210' });
        assert.match(slip, /Employee ID\s+: SEPL-TN001/);
        assert.match(slip, /Initial PIN\s+: 3210/);
    });

    const server = buildApp().listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (method, path, { token, body } = {}) => {
        const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.40' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, headers: response.headers, data: await response.json().catch(() => null) };
    };
    // Email is required; each test employee gets one unless the test sets it.
    const register = (body) => call('POST', '/public/employee-registration', { body: { email: `emp${String(body.mobile).replace(/\D/g, '').slice(-4)}@example.com`, ...body } });
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => { logged.push(args.join(' ')); };

    let tn1;
    try {
        await check('first Tamil Nadu employee → SEPL-TN001, PIN from the mobile, no sign-in needed', async () => {
            const result = await register({ full_name: 'Anitha Kumar', mobile: '+91 98765 43210', state: 'Tamil Nadu', email: 'Anitha@Example.com' });
            assert.equal(result.status, 201, JSON.stringify(result.data));
            assert.equal(result.data.employee.employee_id, 'SEPL-TN001');
            assert.equal(result.data.pin, '3210');
            assert.equal(result.data.employee.mobile_masked, '+91 ••••••3210');
            assert.equal(result.data.employee.state, 'Tamil Nadu');
            assert.equal(result.headers.get('cache-control'), 'no-store');
            tn1 = store.technician_staff.find((row) => row.staff_code === 'SEPL-TN001');
            assert.equal(tn1.phone, '9876543210');
            assert.equal(tn1.email, 'anitha@example.com');
            assert.match(tn1.pin_hash, /^scrypt\$/);
            assert.ok(!tn1.pin_hash.includes('3210'));
            assert.ok(staffService.pinMatches('3210', tn1.pin_hash), 'stored as a salted hash of the PIN');
            assert.equal(tn1.registration_source, 'self');
            assert.equal(tn1.active, true);
        });

        await check('second Tamil Nadu → SEPL-TN002; Karnataka and Maharashtra start at 001', async () => {
            assert.equal((await register({ full_name: 'Bala', mobile: '9123456780', state: 'Tamil Nadu' })).data.employee.employee_id, 'SEPL-TN002');
            assert.equal((await register({ full_name: 'Chandra', mobile: '9123456781', state: 'Karnataka' })).data.employee.employee_id, 'SEPL-KA001');
            assert.equal((await register({ full_name: 'Deepa', mobile: '9123456782', state: 'Karnataka' })).data.employee.employee_id, 'SEPL-KA002');
            assert.equal((await register({ full_name: 'Esha', mobile: '9123456783', state: 'Maharashtra' })).data.employee.employee_id, 'SEPL-MH001');
            assert.equal((await register({ full_name: 'Farhan', mobile: '9123456784', state: 'Tamil Nadu' })).data.employee.employee_id, 'SEPL-TN003');
        });

        await check('simultaneous registrations never share an ID', async () => {
            const burst = await Promise.all(Array.from({ length: 12 }, (_, index) => register({ full_name: `Field Exec ${index}`, mobile: `80000000${String(index).padStart(2, '0')}`, state: 'Kerala' })));
            assert.ok(burst.every((result) => result.status === 201));
            const ids = burst.map((result) => result.data.employee.employee_id);
            assert.equal(new Set(ids).size, 12);
            assert.deepEqual([...ids].sort(), Array.from({ length: 12 }, (_, index) => `SEPL-KL${String(index + 1).padStart(3, '0')}`));
            const codes = store.technician_staff.map((row) => row.staff_code);
            assert.equal(new Set(codes).size, codes.length, 'unique Employee IDs on the roster');
        });

        await check('invalid submissions → 400 with field messages, nothing saved', async () => {
            const before = store.technician_staff.length;
            const result = await register({ full_name: '', mobile: '12345', state: 'Narnia', email: 'x@' });
            assert.equal(result.status, 400);
            assert.deepEqual(Object.keys(result.data.fields).sort(), ['email', 'full_name', 'mobile', 'state']);
            assert.match(result.data.fields.mobile, /10-digit/);
            assert.equal(store.technician_staff.length, before);
        });

        await check('duplicates: same mobile → 409 without revealing the ID; retry of the same submission → same ID', async () => {
            const before = store.technician_staff.length;
            const again = await register({ full_name: 'Anitha K', mobile: '9876543210', state: 'Karnataka' });
            assert.equal(again.status, 409);
            assert.match(again.data.error, /already registered/);
            assert.ok(!JSON.stringify(again.data).includes('SEPL-'), 'the existing Employee ID is not disclosed');
            assert.ok(!again.data.pin);
            const clientId = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
            const first = await register({ full_name: 'Gita', mobile: '9555512345', state: 'Goa', client_submission_id: clientId });
            const retry = await register({ full_name: 'Gita', mobile: '9555512345', state: 'Goa', client_submission_id: clientId });
            assert.equal(first.status, 201);
            assert.equal(retry.status, 200);
            assert.equal(retry.data.duplicate, true);
            assert.equal(retry.data.employee.employee_id, first.data.employee.employee_id);
            assert.equal(retry.data.pin, '2345');
            const hijack = await register({ full_name: 'Other', mobile: '9555599999', state: 'Goa', client_submission_id: clientId });
            assert.equal(hijack.status, 409, 'a reused client id with another mobile is not the same submission');
            assert.equal(store.technician_staff.length, before + 1);
        });

        await check('the new Employee ID + PIN works in the partner form Staff mode', async () => {
            const ok = await call('POST', '/public/technician/staff/verify', { body: { staff_code: 'sepl-tn001', staff_pin: '3210' } });
            assert.equal(ok.status, 200, JSON.stringify(ok.data));
            assert.deepEqual(ok.data.staff, { staff_code: 'SEPL-TN001', full_name: 'Anitha Kumar', via: 'pin' });
        });

        await check('management list: reviewers only; state, email, source shown; never a PIN or hash', async () => {
            assert.equal((await call('GET', '/technicians/staff')).status, 401);
            assert.equal((await call('GET', '/technicians/staff', { token: 'token-user' })).status, 403);
            const list = await call('GET', '/technicians/staff', { token: 'token-reviewer' });
            assert.equal(list.status, 200, JSON.stringify(list.data));
            const row = list.data.staff.find((item) => item.staff_code === 'SEPL-TN001');
            assert.equal(row.state, 'Tamil Nadu');
            assert.equal(row.email, 'anitha@example.com');
            assert.equal(row.registration_source, 'self');
            const text = JSON.stringify(list.data);
            for (const secret of ['pin_hash', 'scrypt$', 'pin_failed_count', 'client_submission_id', '"pin"']) assert.ok(!text.includes(secret), secret);
        });

        await check('edits: state change keeps the Employee ID; deactivate / activate', async () => {
            const moved = await call('PUT', `/technicians/staff/${tn1.id}`, { token: 'token-reviewer', body: { state: 'Kerala' } });
            assert.equal(moved.status, 200, JSON.stringify(moved.data));
            assert.equal(moved.data.staff.staff_code, 'SEPL-TN001');
            assert.equal(moved.data.staff.state, 'Kerala');
            assert.equal(tn1.state_code, 'KL');
            assert.equal((await call('PUT', `/technicians/staff/${tn1.id}`, { token: 'token-reviewer', body: { state: 'Atlantis' } })).status, 400);
            const off = await call('PUT', `/technicians/staff/${tn1.id}`, { token: 'token-reviewer', body: { active: false } });
            assert.equal(off.data.staff.active, false);
            assert.equal((await call('POST', '/public/technician/staff/verify', { body: { staff_code: 'SEPL-TN001', staff_pin: '3210' } })).data.fields.staff_code, 'staff_inactive');
            assert.equal((await call('PUT', `/technicians/staff/${tn1.id}`, { token: 'token-reviewer', body: { active: true } })).data.staff.active, true);
            // Deactivated or not, the next Tamil Nadu ID is new.
            assert.equal((await register({ full_name: 'Hari', mobile: '9123456785', state: 'Tamil Nadu' })).data.employee.employee_id, 'SEPL-TN004');
        });

        await check('Excel export: reviewers only, filtered, no PIN column', async () => {
            assert.equal((await call('GET', '/technicians/staff/export/excel', { token: 'token-user' })).status, 403);
            const response = await fetch(`${base}/technicians/staff/export/excel?state=${encodeURIComponent('Karnataka')}`, { headers: { Authorization: 'Bearer token-reviewer' } });
            assert.equal(response.status, 200);
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
            const sheet = workbook.getWorksheet('Employees');
            const header = sheet.getRow(1).values.filter(Boolean);
            assert.deepEqual(header, ['Employee ID', 'Name', 'Mobile', 'State of Operation', 'Email', 'Status', 'Registered', 'Registration Date (IST)']);
            assert.equal(sheet.rowCount, 1 + 2, 'header + the 2 Karnataka employees');
            assert.equal(sheet.getRow(2).getCell(3).value, '9123456781', 'mobile kept as text');
            assert.match(String(workbook.getWorksheet('Export info').getRow(2).getCell(2).value), /state=Karnataka/);
        });

        await check('delete: reviewers only; members with partner registrations kept; a deleted ID is never reissued', async () => {
            const hari = store.technician_staff.find((row) => row.staff_code === 'SEPL-TN004');
            assert.equal((await call('DELETE', `/technicians/staff/${hari.id}`)).status, 401);
            assert.equal((await call('DELETE', `/technicians/staff/${hari.id}`, { token: 'token-user' })).status, 403);
            const removed = await call('DELETE', `/technicians/staff/${hari.id}`, { token: 'token-reviewer' });
            assert.equal(removed.status, 200, JSON.stringify(removed.data));
            assert.deepEqual(removed.data.deleted, { id: hari.id, staff_code: 'SEPL-TN004', full_name: 'Hari' });
            assert.ok(!store.technician_staff.some((row) => row.id === hari.id));
            assert.equal((await call('DELETE', `/technicians/staff/${hari.id}`, { token: 'token-reviewer' })).status, 404);
            assert.equal((await register({ full_name: 'Indu', mobile: '9123456786', state: 'Tamil Nadu' })).data.employee.employee_id, 'SEPL-TN005', 'TN004 is not reissued');
            // A member who registered a partner is kept.
            store.technician_partner_registrations.push({ id: crypto.randomUUID(), mobile: '9999999999', staff_id: tn1.id, registration_source: 'staff' });
            const refused = await call('DELETE', `/technicians/staff/${tn1.id}`, { token: 'token-reviewer' });
            assert.equal(refused.status, 409);
            assert.match(refused.data.error, /Deactivate them instead/);
            assert.ok(store.technician_staff.some((row) => row.id === tn1.id));
            assert.equal((await call('DELETE', '/technicians/staff/not-a-uuid', { token: 'token-reviewer' })).status, 404);
        });

        await check('logs never contain a PIN or a full mobile number', async () => {
            const text = logged.join('\n');
            assert.ok(text.includes('SEPL-TN001'), 'registrations are logged by Employee ID');
            for (const secret of ['9876543210', '9555512345', 'pin']) assert.ok(!text.toLowerCase().includes(secret), secret);
        });
    } finally {
        console.log = originalLog;
        server.close();
    }
    console.log(results.join('\n'));
    console.log(`\nemployee registration smoke: ${results.length} checks passed`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
