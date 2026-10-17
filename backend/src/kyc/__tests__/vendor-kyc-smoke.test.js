// =============================================================
// Smoke test — vendor KYC (public form + staff review/exports).
//
// Mounts the real routers, middleware and services on a throwaway
// Express app against the in-memory Supabase fake plus a fake Storage
// bucket. Never boots server.js.
//
//   STAFF     listed in private.kyc_staff
//   USER      signed in, not staff (any SaaS customer)
//   SHARED    not staff, but STAFF shared their workspace with them
// =============================================================
process.env.SUPABASE_URL = 'https://kyc-test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
process.env.AUTH_DISABLED = '';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.KYC_SUBMIT_LIMIT_PER_HOUR = '6';

const assert = require('node:assert/strict');
const express = require('express');

const STAFF = 'aa11aa11-1111-4111-8111-111111111111';
const USER = 'bb22bb22-2222-4222-8222-222222222222';
const SHARED = 'cc33cc33-3333-4333-8333-333333333333';
const TOKENS = { 'token-staff': STAFF, 'token-user': USER, 'token-shared': SHARED };

const { createFakeSupabase, installFakeSupabase } = require('../../database/__tests__/fakeSupabase');
const fake = createFakeSupabase({
    rpc: {
        is_kyc_staff: ({ p_user_id: id }) => ({ data: id === STAFF, error: null }),
        resolve_data_owner: ({ p_auth_user_id: auth, p_requested_owner_id: owner }) => ({
            data: !owner || owner === auth ? auth : (auth === SHARED && owner === STAFF ? owner : null),
            error: null,
        }),
    },
});
const store = fake.store;
const supabase = installFakeSupabase(fake);

// ── Fake Storage ──────────────────────────────────────────────
const objects = new Map();
let failUploadsFor = null;
supabase.storage = {
    from(bucket) {
        assert.equal(bucket, 'kyc-documents');
        return {
            async upload(path, buffer, options) {
                if (failUploadsFor && path.endsWith(failUploadsFor)) return { data: null, error: { message: 'boom' } };
                if (objects.has(path)) return { data: null, error: { message: 'The resource already exists' } };
                objects.set(path, { buffer: Buffer.from(buffer), contentType: options.contentType });
                return { data: { path }, error: null };
            },
            async remove(paths) { paths.forEach((path) => objects.delete(path)); return { data: [], error: null }; },
            async createSignedUrls(paths, seconds) {
                return { data: paths.map((path) => ({ path, signedUrl: `https://signed.example/${path}?ttl=${seconds}`, error: null })), error: null };
            },
            async download(path) { return { data: objects.get(path)?.buffer || null, error: objects.has(path) ? null : { message: 'not found' } }; },
        };
    },
};

const auth = require('../../middleware/auth');
const fakeGetClaims = async (token) => (TOKENS[token]
    ? { data: { claims: { sub: TOKENS[token], email: `${token}@example.com`, role: 'authenticated' } }, error: null }
    : { data: null, error: { message: 'invalid JWT' } });
auth.supabaseAdmin.auth.getClaims = fakeGetClaims;

const schema = require('../kycSchema');
const { clearStaffCache } = require('../kycService');

// ── Fixtures ──────────────────────────────────────────────────
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = require('fs').readFileSync(require('path').join(__dirname, '..', 'assets', 'sudarshan-logo.png'));

const VALID = {
    legal_name: 'Shree Ganesh Polymers Private Limited',
    business_type: 'Private Limited',
    trade_name: '',
    pan: 'aagcb 7383 j',
    gstin: '29AAGCB7383J1Z4',
    udyam_number: 'udyam-ka-03-0012345',
    registered_address: 'Plot 42, KIADB\r\nBelagavi',
    registered_pin: '590010',
    factory_address: '',
    state: 'Karnataka',
    website: 'ganeshpolymers.in',
    years_in_business: '14',
    contact_name: 'Ravi Kulkarni',
    contact_designation: 'Sales Manager',
    contact_mobile: '+91 98765 43210',
    contact_email: 'Ravi@GaneshPolymers.in',
    alternate_contact: '',
    landline: '0831-2400123',
    // What the public form's picker sends (JSON in a multipart field).
    category_selections: JSON.stringify([
        { category: 'Packaging', items: ['Packing Bags / Sacks'], other_text: '' },
        { category: 'Raw Materials', items: ['Titanium Dioxide', 'PVC Resin', 'PVC Resin'], other_text: '  carbon   black masterbatch ' },
        { category: 'Other', items: [], other_text: 'Pallet repair' },
    ]),
    products_offered: '',
    bank_account_holder: 'Shree Ganesh Polymers Pvt Ltd',
    bank_name: 'State Bank of India',
    bank_account_number: '30214567891',
    bank_account_number_confirm: '30214567891',
    bank_ifsc: 'sbin0001234',
    bank_branch: 'Belagavi Main',
    bank_account_type: 'Current',
    currency: '',
    authorized_person_name: 'Anil Deshpande',
    authorized_person_designation: 'Director',
    declaration_accepted: 'true',
};
const FILES = {
    pan_proof: ['pan.pdf', PDF],
    gst_certificate: ['gst.pdf', PDF],
    bank_proof: ['cheque.png', PNG],
    udyam_certificate: ['udyam.pdf', PDF],
    signed_declaration: ['declaration.PNG', PNG],
};
const multerFile = ([name, buffer]) => ({ originalname: name, buffer, size: buffer.length });
const multerFiles = (files = FILES) => Object.fromEntries(Object.entries(files).map(([key, value]) => [key, multerFile(value)]));

function buildApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/public/kyc', require('../../routes/kycPublic'));
    app.use('/api/kyc', auth.requireAuth, require('../../routes/kyc'));
    return app;
}

async function main() {
    const results = [];
    const check = async (label, fn) => {
        try { await fn(); results.push(`ok   ${label}`); } catch (error) { results.push(`FAIL ${label}`); console.log(results.join('\n')); throw error; }
    };

    // ── Validation rules (pure) ─────────────────────────────────
    await check('valid submission normalizes PAN/GSTIN/IFSC/Udyam/mobile/email/website/currency', async () => {
        const { values, documents, errors } = schema.validateSubmission(VALID, multerFiles(), { now: new Date('2026-10-17T20:00:00Z') });
        assert.deepEqual(errors, {});
        assert.equal(values.pan, 'AAGCB7383J');
        assert.equal(values.bank_ifsc, 'SBIN0001234');
        assert.equal(values.udyam_number, 'UDYAM-KA-03-0012345');
        assert.equal(values.contact_mobile, '9876543210');
        assert.equal(values.contact_email, 'ravi@ganeshpolymers.in');
        assert.equal(values.website, 'https://ganeshpolymers.in');
        assert.equal(values.currency, 'INR');
        assert.equal(values.years_in_business, 14);
        assert.equal(values.registered_address, 'Plot 42, KIADB\nBelagavi');
        assert.equal(values.trade_name, null, 'empty optional → NULL');
        assert.equal(values.products_offered, null, 'products_offered is optional now');
        assert.deepEqual(values.category_selections, [
            { category: 'Raw Materials', items: ['PVC Resin', 'Titanium Dioxide'], other_text: 'carbon black masterbatch' },
            { category: 'Packaging', items: ['Packing Bags / Sacks'], other_text: '' },
            { category: 'Other', items: [], other_text: 'Pallet repair' },
        ], 'form order, list order, de-duplicated, trimmed');
        assert.equal(values.declaration_date, '2026-10-18', 'declaration date is the India date');
        assert.deepEqual(documents.map((d) => `${d.type}${d.ext}`), ['pan_proof.pdf', 'gst_certificate.pdf', 'bank_proof.png', 'udyam_certificate.pdf', 'signed_declaration.png']);
    });

    await check('format, cross-field and consent errors', async () => {
        const { errors } = schema.validateSubmission({
            ...VALID,
            pan: 'ABCDE12345',
            gstin: '29AAGCB7383J1Z5',          // bad check character
            contact_mobile: '12345',
            contact_email: 'not-an-email',
            registered_pin: '012345',
            bank_ifsc: 'SBIN1001234',
            bank_account_number_confirm: '30214567890',
            category_selections: '[]',
            declaration_accepted: '',
        }, multerFiles());
        for (const key of ['pan', 'gstin', 'contact_mobile', 'contact_email', 'registered_pin', 'bank_ifsc', 'bank_account_number_confirm', 'categories', 'declaration_accepted']) {
            assert.ok(errors[key], `expected an error for ${key}`);
        }
        const mismatch = schema.validateSubmission({ ...VALID, pan: 'AAPFU0939F' }, multerFiles()).errors;
        assert.match(mismatch.gstin, /must match the PAN/);
        const pick = (selections) => schema.validateSubmission({ ...VALID, category_selections: JSON.stringify(selections) }, multerFiles()).errors;
        assert.match(pick([{ category: 'Packaging', items: [], other_text: '' }]).category_packaging, /Pick at least one packaging item/);
        assert.match(pick([{ category: 'Other', items: [], other_text: ' ' }]).category_other, /Describe what you supply/);
        assert.deepEqual(pick([{ category: 'Packaging', items: [], other_text: 'Stretch film' }]), {}, 'Other text alone is enough');
        assert.ok(pick([{ category: 'Raw Materials', items: ['Uranium'], other_text: '' }]).categories, 'items must come from the list');
        assert.ok(pick([{ category: 'Raw Materials & Chemicals', items: ['PVC Resin'] }]).categories, 'only the short category names');
        assert.ok(pick([{ category: 'Other', items: ['x'], other_text: 'y' }]).categories, 'Other category has no items');
        assert.ok(pick([{ category: 'Packaging', items: ['Packing Bags / Sacks'] }, { category: 'Packaging', items: ['Printing Ink & Make-up'] }]).categories, 'no duplicate categories');
        assert.ok(pick([{ category: 'Packaging', items: [], other_text: 'x'.repeat(201) }]).category_packaging);
        assert.ok(schema.validateSubmission({ ...VALID, category_selections: '{not json' }, multerFiles()).errors.categories);
        assert.ok(schema.validateSubmission({ ...VALID, category_selections: undefined }, multerFiles()).errors.categories);
    });

    await check('all 5 mandatory documents enforced; content must match extension', async () => {
        const { errors } = schema.validateSubmission(VALID, multerFiles({ pan_proof: FILES.pan_proof }));
        assert.deepEqual(Object.keys(errors).sort(), ['bank_proof', 'gst_certificate', 'signed_declaration', 'udyam_certificate']);
        const spoofed = schema.validateSubmission(VALID, multerFiles({ ...FILES, gst_certificate: ['gst.pdf', PNG], pan_proof: ['pan.exe', PDF] })).errors;
        assert.match(spoofed.gst_certificate, /does not match/);
        assert.match(spoofed.pan_proof, /PDF, JPG or PNG/);
    });

    await check('review: status derivation and approval rules', async () => {
        const allVerified = Object.fromEntries(schema.DOCUMENTS.map((d) => [d.key, 'yes']));
        const checks = Object.fromEntries(schema.INTERNAL_CHECKS.map((c) => [`check_${c.key}`, 'verified']));
        assert.equal(schema.validateReview({}).values.status, 'pending');
        assert.equal(schema.validateReview({ ...checks, check_risk: 'na', documents_verified: allVerified }).values.status, 'verified');
        assert.equal(schema.validateReview({ ...checks, documents_verified: {} }).values.status, 'pending');
        const approveBare = schema.validateReview({ final_decision: 'approved' }).errors;
        assert.ok(approveBare.vendor_code && approveBare.final_approver && approveBare.final_approved_on);
        const approved = schema.validateReview({ final_decision: 'approved', vendor_code: 'sepl-v 0142', final_approver: 'MD', final_approved_on: '2026-10-20' });
        assert.deepEqual(approved.errors, {});
        assert.equal(approved.values.vendor_code, 'SEPL-V0142');
        assert.equal(approved.values.status, 'approved');
        assert.ok(schema.validateReview({ final_decision: 'info_required' }).errors.decision_remarks);
        assert.ok(schema.validateReview({ final_decision: 'maybe', check_bank: 'done', final_approved_on: '20-10-2026' }).errors.final_decision);
    });

    // ── HTTP ────────────────────────────────────────────────────
    const server = buildApp().listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api`;
    let ipCounter = 1;
    const submit = async (fields = VALID, files = FILES, ip = `203.0.113.${ipCounter++}`) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
            if (Array.isArray(value)) value.forEach((item) => form.append(key, item));
            else form.append(key, value);
        }
        for (const [key, [name, buffer]] of Object.entries(files)) form.append(key, new Blob([buffer]), name);
        const response = await fetch(`${base}/public/kyc`, { method: 'POST', body: form, headers: { 'X-Forwarded-For': ip } });
        return { status: response.status, data: await response.json().catch(() => null) };
    };
    const call = async (method, path, { token, owner, body } = {}) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (owner) headers['X-Data-Owner'] = owner;
        const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const type = response.headers.get('content-type') || '';
        const data = type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
        return { status: response.status, data, headers: response.headers };
    };

    let submissionId;
    try {
        await check('public submit (no auth) → 201, files stored as <id>/<type>.<ext>, row inserted', async () => {
            const { status, data } = await submit();
            assert.equal(status, 201, JSON.stringify(data));
            assert.match(data.reference, /^KYC-[0-9A-F]{8}$/);
            submissionId = data.id;
            const row = store.kyc_submissions.find((r) => r.id === submissionId);
            assert.equal(row.pan, 'AAGCB7383J');
            assert.equal(row.category_selections.length, 3);
            assert.deepEqual(row.category_selections[0], { category: 'Raw Materials', items: ['PVC Resin', 'Titanium Dioxide'], other_text: 'carbon black masterbatch' });
            assert.ok(!('categories' in row) && !('category_other' in row));
            assert.equal(row.documents.signed_declaration.path, `${submissionId}/signed_declaration.png`);
            assert.equal(row.documents.signed_declaration.mime_type, 'image/png');
            assert.equal(row.submitter_ip, '203.0.113.1', 'client IP from X-Forwarded-For');
            assert.equal(objects.size, 5);
            for (const key of ['status', 'vendor_code', 'final_decision', 'check_bank', 'reviewed_by', 'documents_verified']) {
                assert.ok(!(key in row), `public form must not set §7 field ${key}`);
            }
        });

        await check('public submit ignores injected §7/status fields', async () => {
            const { status, data } = await submit({ ...VALID, status: 'approved', vendor_code: 'HACK', final_decision: 'approved', check_bank: 'verified' });
            assert.equal(status, 201);
            const row = store.kyc_submissions.find((r) => r.id === data.id);
            assert.ok(!('vendor_code' in row) && !('status' in row) && !('check_bank' in row));
        });

        await check('public submit: validation errors → 400 with per-field messages, nothing stored', async () => {
            const before = objects.size;
            const { status, data } = await submit({ ...VALID, pan: 'bad' }, { pan_proof: FILES.pan_proof });
            assert.equal(status, 400);
            assert.ok(data.fields.pan && data.fields.gst_certificate && data.fields.signed_declaration);
            assert.equal(objects.size, before);
        });

        await check('public submit: oversize file → 400 on that field', async () => {
            const { status, data } = await submit(VALID, { ...FILES, bank_proof: ['big.pdf', Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)])] });
            assert.equal(status, 400);
            assert.match(data.fields.bank_proof, /5 MB/);
        });

        await check('public submit: a failed upload removes the files already stored and inserts no row', async () => {
            const rowsBefore = store.kyc_submissions.length;
            const objectsBefore = objects.size;
            failUploadsFor = 'udyam_certificate.pdf';
            const { status } = await submit();
            failUploadsFor = null;
            assert.equal(status, 502);
            assert.equal(store.kyc_submissions.length, rowsBefore);
            assert.equal(objects.size, objectsBefore);
        });

        await check('public submit: rate limited per client IP (X-Forwarded-For, 1 trusted hop)', async () => {
            const ip = '198.51.100.7';
            const statuses = [];
            for (let i = 0; i < 7; i++) statuses.push((await submit({ ...VALID, pan: 'bad' }, {}, ip)).status);
            assert.deepEqual(statuses, [400, 400, 400, 400, 400, 400, 429]);
            assert.equal((await submit({ ...VALID, pan: 'bad' }, {}, '198.51.100.8')).status, 400, 'another IP is unaffected');
        });

        // ── Staff ───────────────────────────────────────────────
        await check('staff routes: 401 without a token; non-staff 403; /access reports staff', async () => {
            assert.equal((await call('GET', '/kyc')).status, 401);
            assert.equal((await call('GET', '/kyc', { token: 'token-user' })).status, 403);
            assert.equal((await call('GET', `/kyc/${submissionId}`, { token: 'token-user' })).status, 403);
            assert.equal((await call('GET', '/kyc/export/excel', { token: 'token-user' })).status, 403);
            assert.deepEqual((await call('GET', '/kyc/access', { token: 'token-user' })).data, { staff: false });
            assert.deepEqual((await call('GET', '/kyc/access', { token: 'token-staff' })).data, { staff: true });
        });

        await check('a shared workspace does not pass on reviewer access', async () => {
            const shared = await call('GET', '/kyc', { token: 'token-shared', owner: STAFF });
            assert.equal(shared.status, 403);
        });

        await check('list: key fields only (no PAN/bank data), filters by status and search', async () => {
            const { status, data } = await call('GET', '/kyc?status=pending&q=ganesh', { token: 'token-staff' });
            assert.equal(status, 200);
            assert.equal(data.submissions.length, 0, 'rows inserted by the fake have no status default → filtered out');
            store.kyc_submissions.forEach((row) => { row.status ||= 'pending'; row.submitted_at ||= '2026-10-17T06:30:00Z'; });
            const list = (await call('GET', '/kyc?status=pending&q=ganesh&from=2026-10-17&to=2026-10-17', { token: 'token-staff' })).data;
            assert.equal(list.submissions.length, 2);
            assert.ok(!('bank_account_number' in list.submissions[0]) && !('pan' in list.submissions[0]));
            assert.equal((await call('GET', '/kyc?q=nobody', { token: 'token-staff' })).data.submissions.length, 0);
            assert.equal((await call('GET', '/kyc?from=2026-10-18', { token: 'token-staff' })).data.submissions.length, 0);
        });

        await check('detail: full row + signed URLs for each uploaded document', async () => {
            const { status, data } = await call('GET', `/kyc/${submissionId}`, { token: 'token-staff' });
            assert.equal(status, 200);
            assert.equal(data.submission.bank_account_number, '30214567891');
            assert.equal(data.documentLinks.pan_proof, `https://signed.example/${submissionId}/pan_proof.pdf?ttl=600`);
            assert.equal(data.documentLinks.business_registration, undefined);
            assert.equal((await call('GET', '/kyc/not-a-uuid', { token: 'token-staff' })).status, 404);
        });

        await check('review: invalid → 400; approve → saved with status, reviewer and vendor code', async () => {
            const bad = await call('PUT', `/kyc/${submissionId}/review`, { token: 'token-staff', body: { final_decision: 'approved' } });
            assert.equal(bad.status, 400);
            assert.ok(bad.data.fields.vendor_code);
            const ok = await call('PUT', `/kyc/${submissionId}/review`, {
                token: 'token-staff',
                body: { final_decision: 'approved', vendor_code: 'SEPL-V-0142', final_approver: 'MD', final_approved_on: '2026-10-20', check_bank: 'verified', documents_verified: { pan_proof: 'yes' } },
            });
            assert.equal(ok.status, 200, JSON.stringify(ok.data));
            const row = store.kyc_submissions.find((r) => r.id === submissionId);
            assert.equal(row.status, 'approved');
            assert.equal(row.vendor_code, 'SEPL-V-0142');
            assert.equal(row.reviewed_by, STAFF);
            assert.equal(row.documents_verified.pan_proof, 'yes');
            assert.equal(row.documents_verified.gst_certificate, 'pending');
            assert.equal((await call('PUT', `/kyc/${submissionId}/review`, { token: 'token-user', body: {} })).status, 403);
        });

        await check('exports: PDF (categories + items, declaration note) and Excel (Yes/No + items per category)', async () => {
            const note = await call('GET', `/kyc/${submissionId}/export/pdf`, { token: 'token-staff' });
            assert.equal(note.status, 200);
            assert.equal(note.data.subarray(0, 5).toString(), '%PDF-');
            assert.match(note.headers.get('content-disposition'), /KYC_Shree_Ganesh_Polymers_Private_Limited_KYC-/);
            const { PDFParse } = require('pdf-parse');
            const text = (await new PDFParse({ data: note.data }).getText()).text.replace(/\s+/g, ' '); // extraction wraps lines
            assert.match(text, /Items Selected/);
            assert.match(text, /Raw Materials: PVC Resin, Titanium Dioxide, Other: carbon black masterbatch/);
            assert.match(text, /Other: Pallet repair/);
            assert.match(text, /See the uploaded "Signed & Sealed Declaration Page"/);
            const excel = await call('GET', '/kyc/export/excel?status=approved', { token: 'token-staff' });
            assert.equal(excel.status, 200);
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(excel.data);
            const sheet = workbook.getWorksheet('KYC submissions');
            assert.equal(sheet.rowCount, 2, 'header + the one approved submission');
            const header = sheet.getRow(1).values.filter(Boolean);
            const row = sheet.getRow(2).values;
            const col = (name) => row[header.indexOf(name) + 1];
            assert.equal(col('Account Number'), '30214567891', 'kept as text');
            assert.equal(col('Category: Raw Materials'), 'Yes');
            assert.equal(col('Raw Materials: Items'), 'PVC Resin, Titanium Dioxide, Other: carbon black masterbatch');
            assert.equal(col('Category: Packaging'), 'Yes');
            assert.equal(col('Packaging: Items'), 'Packing Bags / Sacks');
            assert.equal(col('Category: Machinery & Spares'), 'No');
            assert.equal(col('Machinery & Spares: Items'), '');
            assert.equal(col('Other: Items'), 'Pallet repair');
            assert.equal(col('Signed & Sealed Declaration Page: Attached'), 'Yes');
            assert.equal(col('Final Decision'), 'Approved');
        });

        await check('migration not run → clear 503 for staff, /access says setupRequired', async () => {
            clearStaffCache();
            const original = supabase.rpc;
            supabase.rpc = async (name, params) => (name === 'is_kyc_staff' ? { data: null, error: { code: 'PGRST202', message: 'missing' } } : original(name, params));
            const access = await call('GET', '/kyc/access', { token: 'token-staff' });
            assert.deepEqual(access.data, { staff: false, setupRequired: true });
            const list = await call('GET', '/kyc', { token: 'token-staff' });
            assert.equal(list.status, 503);
            assert.match(list.data.error, /supabase-vendor-kyc-migration\.sql/);
            supabase.rpc = original;
            clearStaffCache();
        });
    } finally {
        server.close();
    }
    console.log(results.join('\n'));
    console.log(`\nvendor KYC smoke: ${results.length} checks passed`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
