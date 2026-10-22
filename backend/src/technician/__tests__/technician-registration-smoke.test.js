// =============================================================
// Smoke test — mechanic / technician partner registration (public form +
// staff review). Mounts the real routers on a throwaway Express app
// against the in-memory Supabase fake plus a fake Storage bucket.
// Never boots server.js.
// =============================================================
process.env.SUPABASE_URL = 'https://tech-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.AUTH_DISABLED = '';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.TECHNICIAN_SUBMIT_LIMIT_PER_HOUR = '50';

const assert = require('node:assert/strict');
const express = require('express');

const STAFF = 'aa11aa11-1111-4111-8111-111111111111';
const USER = 'bb22bb22-2222-4222-8222-222222222222';
const TOKENS = { 'token-staff': STAFF, 'token-user': USER };

const { createFakeSupabase, installFakeSupabase } = require('../../database/__tests__/fakeSupabase');
const fake = createFakeSupabase({
    rpc: {
        is_kyc_staff: ({ p_user_id: id }) => ({ data: id === STAFF, error: null }),
        resolve_data_owner: ({ p_auth_user_id: auth, p_requested_owner_id: owner }) => ({ data: !owner || owner === auth ? auth : null, error: null }),
    },
});
const store = fake.store;
const supabase = installFakeSupabase(fake);

const objects = new Map();
let failUploads = false;
supabase.storage = {
    from(bucket) {
        assert.equal(bucket, 'kyc-documents');
        return {
            async upload(path, buffer, options) {
                if (failUploads) return { data: null, error: { message: 'boom' } };
                objects.set(path, { buffer: Buffer.from(buffer), contentType: options.contentType });
                return { data: { path }, error: null };
            },
            async remove(paths) { paths.forEach((path) => objects.delete(path)); return { data: [], error: null }; },
            async createSignedUrls(paths, seconds) {
                return { data: paths.map((path) => ({ path, signedUrl: `https://signed.example/${path}?ttl=${seconds}`, error: null })), error: null };
            },
        };
    },
};

const auth = require('../../middleware/auth');
auth.supabaseAdmin.auth.getClaims = async (token) => (TOKENS[token]
    ? { data: { claims: { sub: TOKENS[token], email: `${token}@example.com`, role: 'authenticated' } }, error: null }
    : { data: null, error: { message: 'invalid JWT' } });

const schema = require('../technicianSchema');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'kyc', 'assets', 'sudarshan-logo.png'));
const NOW = new Date('2026-10-22T06:00:00Z');

const VALID = {
    full_name: '  Murugan   Selvam ',
    district: 'Coimbatore',
    place: 'Pollachi',
    mobile: '+91 98450 12345',
    address: '12, Kamaraj Street\r\nPollachi',
    pincode: '642001',
    state: 'Karnataka', // any of the three; the district stays a Tamil Nadu one
    date_of_birth: '1990-05-14',
    date_of_marriage: '',
    shop_name: '  Murugan  Motor Works ',
    shop_maps_url: '',
};
const AADHAAR_NAME = '1234-5678-9012 aadhaar.png';
const multerFile = ([name, buffer]) => ({ originalname: name, buffer, size: buffer.length });

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

    await check('lists: 38 unique Tamil Nadu districts; exactly the 3 states', async () => {
        assert.equal(schema.DISTRICTS.length, 38);
        assert.equal(new Set(schema.DISTRICTS).size, 38);
        assert.deepEqual(schema.STATES, ['Tamil Nadu', 'Karnataka', 'Andhra Pradesh']);
    });

    await check('valid registration (no Aadhaar) normalizes fields', async () => {
        const { values, documents, errors } = schema.validateRegistration(VALID, {}, { now: NOW });
        assert.deepEqual(errors, {});
        assert.equal(values.full_name, 'Murugan Selvam');
        assert.equal(values.mobile, '9845012345');
        assert.equal(values.address, '12, Kamaraj Street\nPollachi');
        assert.equal(values.date_of_marriage, null);
        assert.equal(values.shop_name, 'Murugan Motor Works');
        assert.equal(values.shop_maps_url, null);
        assert.deepEqual(documents, []);
    });

    await check('optional: shop name, DOB, marriage date (alone too), location, Aadhaar', async () => {
        const { values, errors } = schema.validateRegistration({ ...VALID, shop_name: '', date_of_birth: '', date_of_marriage: '2015-02-01' }, {}, { now: NOW });
        assert.deepEqual(errors, {}, 'marriage date without a DOB is fine');
        assert.equal(values.shop_name, null);
        assert.equal(values.date_of_birth, null);
        assert.equal(values.date_of_marriage, '2015-02-01');
    });

    await check('shop location: device coordinates → generated link; pasted link checked', async () => {
        const location = (body) => schema.validateRegistration({ ...VALID, ...body }, {}, { now: NOW });
        const device = location({ shop_latitude: '10.65823456', shop_longitude: '77.00812349', shop_location_accuracy: '18.4', shop_maps_url: 'ignored' });
        assert.deepEqual(device.errors, {});
        assert.equal(device.values.shop_latitude, 10.658235);
        assert.equal(device.values.shop_maps_url, 'https://www.google.com/maps?q=10.658235,77.008123');
        assert.equal(device.values.shop_location_accuracy_m, 18);
        assert.equal(device.values.shop_location_source, 'device');
        assert.equal(location({ shop_latitude: '95', shop_longitude: '77' }).errors.shop_location, 'invalid_location');
        assert.equal(location({ shop_latitude: '10.6' }).errors.shop_location, 'invalid_location', 'both coordinates needed');
        const pasted = location({ shop_maps_url: 'maps.app.goo.gl/AbC123xyz' });
        assert.deepEqual(pasted.errors, {});
        assert.equal(pasted.values.shop_maps_url, 'https://maps.app.goo.gl/AbC123xyz');
        assert.equal(pasted.values.shop_location_source, 'link');
        assert.equal(pasted.values.shop_latitude, null);
        const withCoords = location({ shop_maps_url: 'https://www.google.com/maps/place/Shop/@10.6582,77.0081,17z' }).values;
        assert.deepEqual([withCoords.shop_latitude, withCoords.shop_longitude], [10.6582, 77.0081]);
        for (const good of ['https://www.google.co.in/maps?q=10.6,77.0', 'https://maps.google.com/?q=Pollachi', 'https://goo.gl/maps/xyz']) {
            assert.deepEqual(location({ shop_maps_url: good }).errors, {}, good);
        }
        for (const bad of ['https://evil.example/maps', 'javascript:alert(1)', 'https://www.google.com/search?q=shop', 'https://google.com.evil.io/maps', 'not a link']) {
            assert.equal(location({ shop_maps_url: bad }).errors.shop_location, 'invalid_maps_url', bad);
        }
    });

    await check('errors are codes: required, formats, dates, file', async () => {
        const errors = (body, files = {}) => schema.validateRegistration({ ...VALID, ...body }, files, { now: NOW }).errors;
        const empty = schema.validateRegistration({}, {}, { now: NOW }).errors;
        assert.deepEqual(Object.keys(empty).sort(), ['address', 'district', 'full_name', 'mobile', 'pincode', 'place', 'state'], 'only the 7 required fields');
        assert.ok(Object.values(empty).every((code) => code === 'required'));
        assert.equal(errors({ shop_name: 'x'.repeat(121) }).shop_name, 'too_long');
        assert.equal(errors({ district: 'Bengaluru Urban' }).district, 'invalid_option', 'only Tamil Nadu districts');
        assert.equal(errors({ state: 'Kerala' }).state, 'invalid_option');
        assert.equal(errors({ mobile: '12345' }).mobile, 'invalid_mobile');
        assert.equal(errors({ pincode: '01234' }).pincode, 'invalid_pincode');
        assert.equal(errors({ date_of_birth: '2026-10-23' }).date_of_birth, 'future_date');
        assert.equal(errors({ date_of_birth: '14-05-1990' }).date_of_birth, 'invalid_date');
        assert.equal(errors({ date_of_marriage: '2027-01-01' }).date_of_marriage, 'future_date');
        assert.equal(errors({ date_of_marriage: '1989-01-01' }).date_of_marriage, 'marriage_before_birth');
        assert.deepEqual(errors({ date_of_marriage: '2015-02-01' }), {});
        assert.equal(errors({}, { aadhaar: multerFile(['a.exe', PDF]) }).aadhaar, 'invalid_file');
        assert.equal(errors({}, { aadhaar: multerFile(['a.pdf', PNG]) }).aadhaar, 'invalid_file', 'content must match extension');
        assert.equal(errors({}, { aadhaar: multerFile(['a.pdf', Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)])]) }).aadhaar, 'file_too_large');
    });

    await check('frontend form: same lists, same codes, every code translated in English and Tamil', async () => {
        const { pathToFileURL } = require('node:url');
        const dir = require('path').join(__dirname, '..', '..', '..', '..', 'frontend', 'src', 'technician');
        const form = await import(pathToFileURL(require('path').join(dir, 'technicianForm.js')).href);
        const i18n = await import(pathToFileURL(require('path').join(dir, 'i18n.js')).href);
        assert.deepEqual(form.DISTRICTS, schema.DISTRICTS);
        assert.deepEqual(form.STATES, schema.STATES);
        assert.deepEqual(Object.keys(form.STATUS_META), schema.STATUSES);
        assert.deepEqual(form.FIELD_ORDER, ['full_name', 'district', 'place', 'shop_name', 'mobile', 'address', 'pincode', 'state', 'date_of_birth', 'date_of_marriage', 'shop_location', 'aadhaar']);
        assert.deepEqual(form.REQUIRED, ['full_name', 'district', 'place', 'mobile', 'address', 'pincode', 'state']);
        assert.deepEqual(form.validateForm({ ...form.INITIAL_VALUES, ...VALID }, {}), {});
        assert.deepEqual(form.validateForm({ ...form.INITIAL_VALUES, ...VALID, date_of_birth: '', shop_name: '', date_of_marriage: '2015-02-01' }, {}), {});
        assert.equal(form.validateForm({ ...form.INITIAL_VALUES, ...VALID, date_of_marriage: '1980-01-01' }, {}).date_of_marriage, 'marriage_before_birth');
        assert.equal(form.validateForm({ ...form.INITIAL_VALUES, ...VALID, shop_maps_url: 'https://evil.example/maps' }, {}).shop_location, 'invalid_maps_url');
        assert.deepEqual(form.validateForm({ ...form.INITIAL_VALUES, ...VALID, shop_maps_url: 'bad' }, {}, { hasDeviceLocation: true }), {}, 'pasted link ignored when the phone location is used');
        for (const url of ['https://maps.app.goo.gl/AbC', 'https://www.google.com/maps/place/x', 'https://evil.example/maps', 'https://www.google.com/search?q=x']) {
            assert.equal(form.isGoogleMapsUrl(url), schema.isGoogleMapsUrl(url), `same Maps-link rule for ${url}`);
        }
        assert.equal(form.mapsLink(10.5, 77.25), 'https://www.google.com/maps?q=10.5,77.25');
        assert.equal(i18n.DEFAULT_LANGUAGE, 'ta', 'Tamil opens first');
        assert.equal(i18n.LANGUAGES[0].code, 'ta');
        const { en, ta } = i18n.TRANSLATIONS;
        assert.ok(!JSON.stringify(ta).includes('கூட்டாளர்'), 'Partner is பார்ட்னர், never கூட்டாளர்');
        assert.match(ta.heading, /பார்ட்னர்/);
        assert.equal(ta.heading, 'எங்கள் மெக்கானிக் / டெக்னீஷியன் பார்ட்னர் பதிவு படிவம்');
        assert.equal(ta.submit, 'பதிவைப் பூர்த்தி செய்யவும்');
        assert.equal(ta.shareLocation, 'கடை இருக்கும் இடத்தைப் பகிரவும்');
        assert.equal(ta.companyName, 'Sudarshan Extrusions Pvt. Ltd.', 'brand name not translated');
        assert.equal(en.heading, 'Our Mechanic/Technician Partner Registration Form');
        const keys = (dict) => Object.keys(dict).filter((key) => typeof dict[key] === 'string').sort();
        assert.deepEqual(keys(ta), keys(en), 'Tamil has every English string');
        assert.deepEqual(Object.keys(ta.errors).sort(), Object.keys(en.errors).sort());
        for (const code of ['required', 'invalid_name', 'invalid_option', 'too_long', 'invalid_mobile', 'invalid_pincode', 'invalid_date', 'future_date', 'marriage_before_birth', 'invalid_maps_url', 'invalid_location', 'invalid_file', 'file_too_large', 'file_empty']) {
            assert.ok(en.errors[code] && ta.errors[code], `translation for ${code}`);
        }
        assert.deepEqual(Object.keys(ta.districts).sort(), [...schema.DISTRICTS].sort(), 'every district has a Tamil name');
        assert.deepEqual(Object.keys(ta.states).sort(), [...schema.STATES].sort());
        assert.equal(i18n.translator('ta').error('required', 'district'), 'மாவட்டம் அவசியம்.');
        assert.equal(i18n.translator('en').error('required', 'district'), 'District is required.');
    });

    const server = buildApp().listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const submit = async (fields = VALID, aadhaar = null) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.append(key, value);
        if (aadhaar) form.append('aadhaar', new Blob([aadhaar[1]]), aadhaar[0]);
        const response = await fetch(`${base}/public/technician`, { method: 'POST', body: form, headers: { 'X-Forwarded-For': '203.0.113.9' } });
        return { status: response.status, data: await response.json().catch(() => null) };
    };
    const call = async (method, path, { token, body } = {}) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, data: await response.json().catch(() => null) };
    };

    let id;
    try {
        await check('public submit without Aadhaar → 201, nothing stored in the bucket', async () => {
            const { status, data } = await submit();
            assert.equal(status, 201, JSON.stringify(data));
            assert.match(data.reference, /^TEC-[0-9A-F]{8}$/);
            const row = store.technician_partner_registrations.find((r) => r.id === data.id);
            assert.deepEqual(row.documents, {});
            assert.equal(objects.size, 0);
        });

        await check('public submit with Aadhaar → private path only; original file name not kept', async () => {
            const { status, data } = await submit({ ...VALID, status: 'approved', review_remarks: 'x' }, [AADHAAR_NAME, PNG]);
            assert.equal(status, 201, JSON.stringify(data));
            id = data.id;
            const row = store.technician_partner_registrations.find((r) => r.id === id);
            assert.deepEqual(row.documents.aadhaar, { path: `technicians/${id}/aadhaar.png`, file_name: 'aadhaar.png', mime_type: 'image/png', size: PNG.length });
            assert.ok(!JSON.stringify(row).includes('1234-5678-9012'), 'Aadhaar number from the file name is not stored');
            assert.ok(!('status' in row) && !('review_remarks' in row), 'review fields cannot be injected');
        });

        await check('retry with the same client id (slow connection) → same registration, no duplicate', async () => {
            const clientId = '5f0c2a8e-7b1d-4c3e-9a2f-1d2e3f4a5b6c';
            const body = { ...VALID, client_submission_id: clientId, shop_latitude: '10.658235', shop_longitude: '77.008123', shop_location_accuracy: '12' };
            const first = await submit(body);
            assert.equal(first.status, 201, JSON.stringify(first.data));
            assert.equal(first.data.id, clientId);
            const rows = store.technician_partner_registrations.length;
            const again = await submit(body);
            assert.equal(again.status, 200);
            assert.equal(again.data.reference, first.data.reference);
            assert.equal(store.technician_partner_registrations.length, rows, 'no second row');
            const row = store.technician_partner_registrations.find((r) => r.id === clientId);
            assert.equal(row.shop_maps_url, 'https://www.google.com/maps?q=10.658235,77.008123');
            assert.equal(row.shop_location_source, 'device');
            assert.equal((await submit({ ...VALID, client_submission_id: 'not-a-uuid' })).status, 201, 'a bad id just gets a fresh one');
        });

        await check('public submit: 400 with field codes; failed upload stores nothing', async () => {
            const bad = await submit({ ...VALID, mobile: '1', district: 'Mysuru' });
            assert.equal(bad.status, 400);
            assert.deepEqual(bad.data.fields, { mobile: 'invalid_mobile', district: 'invalid_option' });
            const rows = store.technician_partner_registrations.length;
            failUploads = true;
            assert.equal((await submit(VALID, ['a.pdf', PDF])).status, 502);
            failUploads = false;
            assert.equal(store.technician_partner_registrations.length, rows);
        });

        await check('staff only: 401 / 403 / 200; search + status filter', async () => {
            assert.equal((await call('GET', '/technicians')).status, 401);
            assert.equal((await call('GET', '/technicians', { token: 'token-user' })).status, 403);
            assert.equal((await call('GET', `/technicians/${id}`, { token: 'token-user' })).status, 403);
            store.technician_partner_registrations.forEach((row) => { row.status ||= 'pending'; row.submitted_at ||= '2026-10-22T06:00:00Z'; });
            const list = await call('GET', '/technicians?q=coimbatore&status=pending', { token: 'token-staff' });
            assert.equal(list.status, 200);
            assert.equal(list.data.registrations.length, 4, 'every Coimbatore registration so far');
            assert.deepEqual(Object.keys(list.data.registrations[0]).sort(), ['district', 'full_name', 'id', 'mobile', 'place', 'reference', 'shop_maps_url', 'shop_name', 'state', 'status', 'submitted_at']);
            assert.equal((await call('GET', '/technicians?q=nobody', { token: 'token-staff' })).data.registrations.length, 0);
        });

        await check('detail with a 10-minute signed Aadhaar link; review saves status + reviewer', async () => {
            const detail = await call('GET', `/technicians/${id}`, { token: 'token-staff' });
            assert.equal(detail.status, 200);
            assert.equal(detail.data.documentLinks.aadhaar, `https://signed.example/technicians/${id}/aadhaar.png?ttl=600`);
            assert.equal((await call('PUT', `/technicians/${id}/review`, { token: 'token-staff', body: { status: 'hired' } })).status, 400);
            const saved = await call('PUT', `/technicians/${id}/review`, { token: 'token-staff', body: { status: 'approved', review_remarks: ' Called on 22 Oct ' } });
            assert.equal(saved.status, 200, JSON.stringify(saved.data));
            const row = store.technician_partner_registrations.find((r) => r.id === id);
            assert.equal(row.status, 'approved');
            assert.equal(row.review_remarks, 'Called on 22 Oct');
            assert.equal(row.reviewed_by, STAFF);
            assert.equal((await call('PUT', `/technicians/${id}/review`, { token: 'token-user', body: { status: 'approved' } })).status, 403);
        });
    } finally {
        server.close();
    }
    console.log(results.join('\n'));
    console.log(`\ntechnician partner registration smoke: ${results.length} checks passed`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
