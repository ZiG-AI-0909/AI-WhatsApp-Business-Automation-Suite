// =============================================================
// Smoke test — BOQ -> Quotation, end to end through the real routes.
//
// An in-memory Supabase stand-in (filters, upsert, unique version index,
// and a JS model of the finalize_quotation RPC) is injected before the
// modules load. The SQL function itself is plpgsql in
// supabase-quotation-migration.sql.
//
// Covers: ref_rate is never copied into rate (rate stays NULL), totals with
// partial rates, CGST/SGST vs IGST, rounding, financial-year numbering
// around 31 March / 1 April, finalize blocked by unpriced lines and by
// [placeholders], read-only after finalize, per-user isolation (404),
// integrity flags for a misread quantity, Excel live formulas with the
// internal sheet only on ?internal=1, the PDF (no contract rates, 300 lines),
// single WhatsApp send, and the existing RFQ export still working.
//
// Run: node backend/src/documents/__tests__/quotation-smoke.test.js
// =============================================================
'use strict';

const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { PDFParse } = require('pdf-parse');
const fixture = require('./fixtures/belagavi-boq-items.json');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

// ── In-memory Supabase ────────────────────────────────────────
const tables = { boq_documents: [], app_settings: [], quotations: [], quotation_items: [], quotation_counters: [] };
let nextId = 1;
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const DEFAULTS = {
    quotations: () => ({ status: 'draft', version: 1, quote_number: null, terms: [], company: {}, integrity: {}, subtotal: 0, grand_total: 0, unpriced_lines: 0, sent_at: null, sent_to: null, send_claimed_at: null, finalized_at: null }),
    quotation_items: () => ({ include: false, section: 'B', spec: {}, flags: [], rate: null }),
};

function uniqueViolation(table, row, ignoreId) {
    if (table === 'quotations' && row.boq_document_id !== null && row.boq_document_id !== undefined) {
        const clash = tables.quotations.find((other) => other.id !== ignoreId && other.user_id === row.user_id
            && String(other.boq_document_id) === String(row.boq_document_id) && other.version === row.version);
        if (clash) return { code: '23505', message: 'duplicate key value violates unique constraint "idx_quotations_user_boq_version"' };
    }
    if (table === 'quotation_items') {
        const clash = tables.quotation_items.find((other) => other.id !== ignoreId && other.quotation_id === row.quotation_id && other.line_no === row.line_no);
        if (clash) return { code: '23505', message: 'duplicate quotation line' };
    }
    return null;
}

function orCondition(expression) {
    const conditions = expression.split(',').map((part) => {
        const [column, op, ...rest] = part.split('.');
        return { column, op, value: rest.join('.') };
    });
    return (row) => conditions.some(({ column, op, value }) => {
        const current = row[column];
        if (op === 'is') return value === 'null' ? current === null || current === undefined : String(current) === value;
        if (op === 'lt') return current !== null && current !== undefined && String(current) < value;
        if (op === 'ilike') return String(current ?? '').toLowerCase().includes(value.replace(/%/g, '').toLowerCase());
        return false;
    });
}

function from(table) {
    const state = { op: 'select', filters: [], order: null, range: null, limit: null, payload: null, single: null };
    const rows = () => tables[table];
    const match = (row) => state.filters.every((filter) => filter(row));
    async function run() {
        if (state.op === 'insert') {
            const list = Array.isArray(state.payload) ? state.payload : [state.payload];
            const created = [];
            for (const payload of list) {
                const row = { id: nextId++, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...(DEFAULTS[table]?.() || {}), ...clone(payload) };
                const violation = uniqueViolation(table, row);
                if (violation) return { data: null, error: violation };
                rows().push(row);
                created.push(clone(row));
            }
            return { data: created, error: null };
        }
        if (state.op === 'upsert') {
            for (const payload of state.payload) {
                const index = rows().findIndex((row) => String(row.id) === String(payload.id));
                if (index >= 0) rows()[index] = { ...rows()[index], ...clone(payload) };
                else rows().push({ ...(DEFAULTS[table]?.() || {}), ...clone(payload) });
            }
            return { data: null, error: null };
        }
        if (state.op === 'update') {
            const updated = [];
            for (const row of rows().filter(match)) {
                Object.assign(row, clone(state.payload), { updated_at: new Date().toISOString() });
                updated.push(clone(row));
            }
            return { data: updated, error: null };
        }
        if (state.op === 'delete') {
            const keep = rows().filter((row) => !match(row));
            const removed = rows().length - keep.length;
            tables[table] = keep;
            if (table === 'quotations') tables.quotation_items = tables.quotation_items.filter((item) => tables.quotations.some((q) => q.id === item.quotation_id));
            return { data: null, error: null, count: removed };
        }
        let result = rows().filter(match).map(clone);
        if (state.order) {
            const [column, ascending] = state.order;
            result.sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * (ascending ? 1 : -1));
        }
        const count = result.length;
        if (state.range) result = result.slice(state.range[0], state.range[1] + 1);
        if (state.limit !== null) result = result.slice(0, state.limit);
        return { data: result, error: null, count };
    }
    const api = {
        select() { return api; },
        eq(column, value) { state.filters.push((row) => String(row[column]) === String(value)); return api; },
        in(column, values) { state.filters.push((row) => values.map(String).includes(String(row[column]))); return api; },
        or(expression) { state.filters.push(orCondition(expression)); return api; },
        order(column, { ascending = true } = {}) { state.order = [column, ascending]; return api; },
        range(start, end) { state.range = [start, end]; return api; },
        limit(count) { state.limit = count; return api; },
        insert(payload) { state.op = 'insert'; state.payload = payload; return api; },
        update(payload) { state.op = 'update'; state.payload = payload; return api; },
        upsert(payload) { state.op = 'upsert'; state.payload = payload; return api; },
        delete() { state.op = 'delete'; return api; },
        async maybeSingle() { const { data, error } = await run(); return { data: Array.isArray(data) ? data[0] ?? null : data, error }; },
        async single() {
            const { data, error } = await run();
            if (error) return { data: null, error };
            const row = Array.isArray(data) ? data[0] : data;
            return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        },
        then(resolve, reject) { return run().then(resolve, reject); },
    };
    return api;
}

let domainForRpc = null;
async function rpc(name, args) {
    if (name !== 'finalize_quotation') return { data: null, error: { message: `unknown rpc ${name}` } };
    const quotation = tables.quotations.find((row) => String(row.id) === String(args.p_quotation_id) && row.user_id === args.p_user_id);
    if (!quotation) return { data: null, error: { message: 'quotation_not_found' } };
    if (quotation.status !== 'draft') return { data: null, error: { message: 'quotation_not_draft' } };
    const lines = tables.quotation_items.filter((item) => item.quotation_id === quotation.id && item.include);
    if (!lines.length) return { data: null, error: { message: 'quotation_no_lines' } };
    if (lines.some((item) => item.rate === null || Number(item.rate) <= 0 || !(Number(item.qty) > 0))) return { data: null, error: { message: 'quotation_unpriced_lines' } };
    const fiscalYear = domainForRpc.fiscalYearFor(quotation.quote_date);
    let counter = tables.quotation_counters.find((row) => row.user_id === args.p_user_id && row.fiscal_year === fiscalYear);
    if (!counter) tables.quotation_counters.push(counter = { user_id: args.p_user_id, fiscal_year: fiscalYear, last_number: 0 });
    counter.last_number++;
    Object.assign(quotation, { quote_number: domainForRpc.formatQuoteNumber(counter.last_number, fiscalYear), status: 'final', finalized_at: new Date().toISOString() });
    return { data: clone(quotation), error: null };
}

const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
        supabase: { from, rpc },
        isAvailable: () => true,
        transaction: async (ops) => { for (const op of ops) await op(); },
        normalizeRow: (row) => row,
        parseJsonFields: (row) => row,
    },
};

// Pass-through rate limiter and a recording WhatsApp session.
const limiterPath = require.resolve('../../middleware/rateLimiterMiddleware');
const pass = (_req, _res, next) => next();
require.cache[limiterPath] = { id: limiterPath, filename: limiterPath, loaded: true, exports: { webhookLimiter: pass, sendLimiter: pass, aiExtractLimiter: pass, aiQueryLimiter: pass, mutationLimiter: pass } };
const sent = [];
let whatsappStatus = 'connected';
const sessionPath = require.resolve('../../whatsapp/sessionManager');
require.cache[sessionPath] = {
    id: sessionPath,
    filename: sessionPath,
    loaded: true,
    exports: {
        getStatus: () => whatsappStatus,
        sendMessage: async (...args) => { sent.push(args); return { key: { id: 'msg-1' } }; },
    },
};
const countryCodes = require('../../utils/countryCodes');
countryCodes.resolveCountryCode = async () => '91';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const domain = require('../quotationDomain');
domainForRpc = domain;
const exporter = require('../quotationExport');
const quotationsRouter = require('../../routes/quotations');
const boqRoute = require('../../routes/boq');

// ── Route driver ──────────────────────────────────────────────
async function call(router, method, path, { user = USER_A, body = {}, query = {} } = {}) {
    const layer = router.stack.find((entry) => entry.route?.methods[method.toLowerCase()] && entry.match(path));
    assert.ok(layer, `route ${method} ${path} exists`);
    const req = { method, params: layer.params, body, query, user: { id: user }, headers: {}, get: () => undefined, on: () => {} };
    const response = { statusCode: 200, headers: {}, body: undefined };
    const res = {
        status(code) { response.statusCode = code; return res; },
        json(payload) { response.body = payload; return res; },
        send(payload) { response.body = payload; return res; },
        type(value) { response.headers['content-type'] = value; return res; },
        setHeader(key, value) { response.headers[key.toLowerCase()] = value; },
        set(key, value) { response.headers[String(key).toLowerCase()] = value; return res; },
        on() {},
    };
    for (const step of layer.route.stack) {
        let advanced = false;
        await step.handle(req, res, () => { advanced = true; });
        if (!advanced) break;
    }
    return response;
}
const api = (method, path, options) => call(quotationsRouter, method, path, options);

async function loadWorkbook(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return workbook;
}

async function pdfInfo(buffer) {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy?.();
    return { text: result.text, pages: result.pages.length };
}

async function run() {
    // ── Pure domain rules ────────────────────────────────────
    assert.equal(domain.round2(1.005), 1.01, 'decimal-correct rounding');
    assert.equal(domain.round2(2.675), 2.68);
    assert.equal(domain.round2(-1.005), -1.01);
    assert.equal(domain.parseAmount('2,13,37,436.00'), 21337436);
    assert.equal(domain.parseAmount('Rs. 470'), 470);
    assert.equal(domain.parseAmount('n/a'), null);

    assert.equal(domain.fiscalYearFor('2027-03-31'), '2026-27');
    assert.equal(domain.fiscalYearFor('2027-04-01'), '2027-28');
    assert.equal(domain.fiscalYearFor('2026-04-01'), '2026-27');
    assert.equal(domain.fiscalYearFor(new Date('2027-03-31T18:29:59Z')), '2026-27', '31 Mar 23:59 IST is still FY 2026-27');
    assert.equal(domain.fiscalYearFor(new Date('2027-03-31T18:30:00Z')), '2027-28', '1 Apr 00:00 IST starts FY 2027-28 (UTC still says 31 Mar)');
    assert.equal(domain.formatQuoteNumber(1, '2026-27'), 'SP/2026-27/0001');
    assert.equal(domain.formatQuoteNumber(12345, '2026-27'), 'SP/2026-27/12345', 'numbers past 9999 are not truncated');
    assert.throws(() => domain.fiscalYearFor('2027-02-30'), /valid/);

    const partial = domain.calculateTotals({ supply_type: 'intra', gst_percent: 18, discount_percent: 0, freight: 0 }, [
        { line_no: 1, include: true, qty: 3, rate: 0.335 },
        { line_no: 2, include: true, qty: 10, rate: null },
        { line_no: 3, include: false, qty: 5, rate: 1000 },
    ]);
    assert.equal(partial.subtotal, 1.01, 'qty x rate rounded to paise (3 x 0.335 = 1.005 -> 1.01)');
    assert.equal(partial.unpriced_lines, 1, 'empty rate counts as unpriced and as 0 in the totals');
    assert.equal(partial.included_lines, 2, 'excluded lines never reach the totals');
    const intra = domain.calculateTotals({ supply_type: 'intra', gst_percent: 18, discount_percent: 10, freight: 500 }, [{ line_no: 1, include: true, qty: 100, rate: 123.45 }]);
    assert.deepEqual([intra.subtotal, intra.discount_amount, intra.taxable_value, intra.cgst, intra.sgst, intra.igst, intra.grand_total], [12345, 1234.5, 11610.5, 1044.95, 1044.95, 0, 13700.4]);
    const inter = domain.calculateTotals({ supply_type: 'inter', gst_percent: 18, discount_percent: 10, freight: 500 }, [{ line_no: 1, include: true, qty: 100, rate: 123.45 }]);
    assert.deepEqual([inter.cgst, inter.sgst, inter.igst, inter.grand_total], [0, 0, 2089.89, 13700.39]);
    assert.equal(inter.amount_in_words, 'Rupees Thirteen Thousand Seven Hundred and Thirty-Nine Paise Only');

    assert.throws(() => domain.normalizeItemPatch({ id: 1, rate: -1 }), /rate must be at least 0/);
    assert.throws(() => domain.normalizeItemPatch({ id: 1, rate: 'abc' }), /rate must be a number/);
    assert.throws(() => domain.normalizeItemPatch({ id: 1, qty: 0 }), /qty must be greater than 0/);
    assert.equal(domain.normalizeItemPatch({ id: 1, rate: '1,234.567' }).patch.rate, 1234.57, 'rates are rounded to 2 decimals');
    assert.equal(domain.normalizeItemPatch({ id: 1, rate: '' }).patch.rate, null, 'clearing a rate stores NULL');

    // Integrity: 5171.94 misread as 3171.94 is flagged; nothing is corrected.
    const corrupted = clone(fixture.items);
    const excavation = corrupted.find((item) => item.serialNumber === '4');
    assert.equal(excavation.quantity, 5171.94);
    excavation.quantity = 3171.94;
    const corruptedDraft = domain.buildDraftItems(corrupted, fixture.document_text);
    const flagged = corruptedDraft.rows.find((row) => row.boq_item_no === '4');
    assert.equal(flagged.flags[0].code, 'boq_amount_mismatch');
    assert.match(flagged.flags[0].message, /qty or rate may be misread: verify against the scan/);
    assert.equal(flagged.qty, 3171.94, 'the misread quantity is kept as read (never auto-corrected)');
    assert.deepEqual(corruptedDraft.integrity.mismatched_lines, [2]);
    const cleanDraft = domain.buildDraftItems(fixture.items, fixture.document_text);
    assert.equal(cleanDraft.integrity.total_ok, true, 'fixture amounts add up to the printed total');
    assert.equal(cleanDraft.rows.filter((row) => row.flags.length).length, 0);
    const corruptedAmount = clone(fixture.items);
    corruptedAmount[0].sourceValues['Amount (Rs.)'] = '60,16,568.48';
    const amountCheck = domain.checkBoqIntegrity(corruptedAmount, fixture.document_text);
    assert.equal(amountCheck.summary.total_ok, false, 'sum of amounts vs printed total catches a misread amount');
    assert.equal(amountCheck.summary.difference, -1000000);

    // ── Routes: create from a confirmed BOQ ──────────────────
    tables.boq_documents.push(
        { id: 501, user_id: USER_A, filename: 'belagavi.pdf', status: 'confirmed', items: JSON.stringify(fixture.items), warnings: '[]', document_text: fixture.document_text, extraction_metadata: {} },
        { id: 502, user_id: USER_A, filename: 'unconfirmed.pdf', status: 'review', items: JSON.stringify(fixture.items), warnings: '[]', document_text: '' },
        { id: 503, user_id: USER_B, filename: 'other.pdf', status: 'confirmed', items: JSON.stringify(fixture.items.slice(0, 3)), warnings: '[]', document_text: '' },
    );
    for (const [key, value] of Object.entries({
        BUSINESS_NAME: 'Sudarshan Pipes',
        COMPANY_ADDRESS: 'Plot 12, Industrial Area, Belagavi, Karnataka',
        COMPANY_STATE: 'Karnataka',
        COMPANY_GSTIN: '29ABCDE1234F1Z5',
        COMPANY_PHONE: '+91 98450 00000',
        COMPANY_EMAIL: 'sales@example.com',
        COMPANY_BANK_DETAILS: 'Example Bank, Sudarshan Pipes, A/c 1234567890, IFSC EXAM0001234',
    })) tables.app_settings.push({ user_id: USER_A, key, value });

    assert.equal((await api('POST', '/boq/502/quotation')).statusCode, 409, 'a BOQ must be confirmed first');
    assert.equal((await api('POST', '/boq/501/quotation', { user: USER_B })).statusCode, 404, 'another user cannot quote my BOQ');

    const createdResponse = await api('POST', '/boq/501/quotation');
    assert.equal(createdResponse.statusCode, 201, JSON.stringify(createdResponse.body));
    let quote = createdResponse.body;
    assert.equal(quote.created, true);
    assert.equal(quote.status, 'draft');
    assert.equal(quote.quote_number, null, 'no number until finalize');
    assert.equal(quote.items.length, 25, 'every BOQ line is stored');
    const included = quote.items.filter((item) => item.include);
    assert.deepEqual(included.map((item) => item.boq_item_no), ['11', '12', '13', '14', '15', '72', '73', '74', '75', '76']);
    assert.deepEqual(included.filter((item) => item.section === 'A').map((item) => item.boq_item_no), ['11', '72', '73', '74', '75', '76']);
    assert.ok(quote.items.every((item) => item.rate === null), 'rate stays NULL after creation');
    const line72 = quote.items.find((item) => item.boq_item_no === '72');
    assert.equal(line72.ref_rate, 470, 'BOQ contract rate kept as reference');
    assert.equal(line72.ref_amount, 21337436);
    assert.equal(line72.rate, null, 'ref_rate is never copied into rate');
    assert.equal(line72.hsn, '3917');
    assert.equal(line72.qty, 45398.8);
    assert.equal(line72.description, 'HDPE pipe, grade PE80, PN 6.0, conforming to IS 4984:2016, 110 mm, in coil.');
    assert.ok(line72.boq_description.includes('electrofusion'), 'full BOQ text kept for the tooltip');
    assert.deepEqual(line72.spec.source, { page: 13, sheet: null, table: null, row: 72 });
    assert.match(quote.customer_name, /^Sri\. Veerabhadragouda Patil \(Prime Contractor\)/, 'customer from "Issued to"');
    assert.match(quote.project_name, /^Package-02 Comprehensive development.*Belagavi city corporation limits/, 'project from "Name of the work"');
    assert.match(quote.reference_text, /Agreement No\. 1740586\/DMA\/TECH\/MGNV\/12\/2025-26\/AGR-/);
    assert.equal(quote.totals.grand_total, 0);
    assert.equal(quote.unpriced_lines, 10);
    assert.equal(quote.integrity.total_ok, true);
    assert.equal(quote.terms[0].text.startsWith('Scope: SUPPLY ONLY of pipes.'), true);
    assert.match(quote.terms.find((term) => term.key === 'bank').text, /IFSC EXAM0001234/, 'bank details come from Settings');
    assert.equal(quote.finalize.ready, false);

    const again = await api('POST', '/boq/501/quotation');
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.id, quote.id, 'creation is idempotent per BOQ');
    assert.equal(tables.quotations.length, 1);

    // ── Isolation ────────────────────────────────────────────
    for (const [method, path] of [['GET', `/quotations/${quote.id}`], ['PUT', `/quotations/${quote.id}`], ['PUT', `/quotations/${quote.id}/items`], ['DELETE', `/quotations/${quote.id}`], ['POST', `/quotations/${quote.id}/finalize`], ['POST', `/quotations/${quote.id}/duplicate`], ['GET', `/quotations/${quote.id}/export/excel`], ['GET', `/quotations/${quote.id}/export/pdf`], ['POST', `/quotations/${quote.id}/send-whatsapp`]]) {
        const response = await api(method, path, { user: USER_B, body: { items: [{ id: line72.id, rate: 1 }], phone: '9876543210' } });
        assert.equal(response.statusCode, 404, `${method} ${path} is 404 for another user`);
    }
    assert.equal((await api('GET', '/quotations', { user: USER_B })).body.total, 0, 'list is per user');
    assert.equal((await api('GET', '/quotations/abc')).statusCode, 404);

    // ── Bulk edit validation ─────────────────────────────────
    const byNo = (no) => quote.items.find((item) => item.boq_item_no === no);
    assert.equal((await api('PUT', `/quotations/${quote.id}/items`, { body: { items: [{ id: byNo('72').id, rate: -5 }] } })).statusCode, 400);
    assert.equal((await api('PUT', `/quotations/${quote.id}/items`, { body: { items: [{ id: byNo('72').id, qty: 0 }] } })).statusCode, 400);
    assert.equal((await api('PUT', `/quotations/${quote.id}/items`, { body: { items: [{ id: 999999, rate: 10 }] } })).statusCode, 400, 'foreign line ids are rejected');
    assert.equal((await api('PUT', `/quotations/${quote.id}/items`, { body: { items: [{ id: byNo('72').id, include: 'yes' }] } })).statusCode, 400);
    assert.equal((await api('PUT', `/quotations/${quote.id}/items`, { body: { items: [{ id: byNo('72').id, section: 'C' }] } })).statusCode, 400);
    assert.ok(tables.quotation_items.every((item) => item.rate === null), 'rejected edits change nothing');

    // ── Partial rates, server totals, above-contract warning ─
    let response = await api('PUT', `/quotations/${quote.id}/items`, { body: { items: [
        { id: byNo('72').id, rate: 300 },
        { id: byNo('73').id, rate: '1600' },
        { id: byNo('1').id, include: true, section: 'B' },
        { id: byNo('4').id, remarks: 'not quoted' },
    ] } });
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    quote = response.body;
    assert.equal(quote.totals.subtotal, 49938680, '45398.8 x 300 + 22699.4 x 1600');
    assert.equal(quote.totals.cgst, 4494481.2);
    assert.equal(quote.totals.sgst, 4494481.2);
    assert.equal(quote.totals.igst, 0);
    assert.equal(quote.totals.grand_total, 58927642.4);
    assert.equal(quote.unpriced_lines, 9, 'refilling line was included without a rate');
    assert.ok(byNo('73') && quote.items.find((item) => item.boq_item_no === '73').warnings.some((warning) => warning.code === 'above_contract_rate'), 'rate above the BOQ contract rate warns');
    assert.ok(!quote.items.find((item) => item.boq_item_no === '72').warnings.some((warning) => warning.code === 'above_contract_rate'));
    assert.equal(tables.quotations[0].grand_total, 58927642.4, 'list snapshot uses the server total');

    response = await api('PUT', `/quotations/${quote.id}`, { body: { supply_type: 'inter', grand_total: 1 } });
    quote = response.body;
    assert.equal(quote.totals.igst, 8988962.4);
    assert.equal(quote.totals.cgst, 0);
    assert.equal(quote.totals.grand_total, 58927642.4, 'browser-sent totals are ignored');
    assert.equal((await api('PUT', `/quotations/${quote.id}`, { body: { supply_type: 'both' } })).statusCode, 400);
    assert.equal((await api('PUT', `/quotations/${quote.id}`, { body: { gst_percent: 120 } })).statusCode, 400);

    // ── Finalize gates ───────────────────────────────────────
    response = await api('POST', `/quotations/${quote.id}/finalize`);
    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.body.unpriced_lines.map((line) => line.line_no).sort((a, b) => a - b), [1, 3, 4, 5, 6, 7, 17, 18, 19]);
    assert.ok(response.body.placeholders.length > 0, 'terms placeholders block finalize too');
    assert.equal(tables.quotations[0].quote_number, null);

    await api('PUT', `/quotations/${quote.id}/items`, { body: { items: [{ id: byNo('1').id, include: false }] } });
    const prices = { 11: 95, 12: 210, 13: 210, 14: 380, 15: 760, 74: 5100, 75: 980, 76: 1350 };
    response = await api('PUT', `/quotations/${quote.id}/items`, { body: { items: Object.entries(prices).map(([no, rate]) => ({ id: byNo(no).id, rate })) } });
    assert.equal(response.body.unpriced_lines, 0);
    response = await api('POST', `/quotations/${quote.id}/finalize`);
    assert.equal(response.statusCode, 422, 'placeholders still block');
    assert.equal(response.body.unpriced_lines.length, 0);
    assert.ok(response.body.placeholders.some((entry) => entry.field === 'reference_text'), 'illegible [..] text from the BOQ must be verified');
    assert.ok(response.body.placeholders.some((entry) => entry.label === 'Term 4' && entry.placeholder === '[to fill]'));

    const terms = quote.terms.map((term) => ({ ...term, text: term.text.replace('[ex-works / delivered to site]', 'delivered to site').replace('[to fill]', term.key === 'payment' ? '30 days from invoice' : '4') }));
    response = await api('PUT', `/quotations/${quote.id}`, { body: {
        terms,
        reference_text: 'Directorate of Municipal Administration (DMA), Agreement No. 1740586/DMA/TECH/MGNV/12/2025-26/AGR-07. Quantities as per BOQ.',
        quote_date: '2027-03-31',
        supply_type: 'intra',
    } });
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(response.body.finalize.ready, true, JSON.stringify(response.body.finalize));
    response = await api('POST', `/quotations/${quote.id}/finalize`);
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    quote = response.body;
    assert.equal(quote.status, 'final');
    assert.equal(quote.quote_number, 'SP/2026-27/0001', 'quotation dated 31 March 2027 belongs to FY 2026-27');
    assert.equal(quote.company.gstin, '29ABCDE1234F1Z5', 'company header snapshot stored at finalize');

    // Read-only after finalize
    assert.equal((await api('PUT', `/quotations/${quote.id}`, { body: { customer_name: 'x' } })).statusCode, 409);
    assert.equal((await api('PUT', `/quotations/${quote.id}/items`, { body: { items: [{ id: byNo('72').id, rate: 1 }] } })).statusCode, 409);
    assert.equal((await api('DELETE', `/quotations/${quote.id}`)).statusCode, 409);
    assert.equal((await api('POST', `/quotations/${quote.id}/finalize`)).statusCode, 409);

    // ── Excel ────────────────────────────────────────────────
    response = await api('GET', `/quotations/${quote.id}/export/excel`);
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-disposition'], /SP-2026-27-0001\.xlsx/);
    let workbook = await loadWorkbook(response.body);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Quotation'], 'customer export has no internal sheet');
    const sheet = workbook.getWorksheet('Quotation');
    assert.equal(sheet.getCell('A3').value, 'QUOTATION');
    assert.equal(sheet.getCell('C5').value, 'SP/2026-27/0001');
    assert.equal(sheet.getCell('A10').value, 'S.No');
    assert.equal(sheet.getCell('K10').value, 'Remarks / check before sending');
    assert.match(String(sheet.getCell('A11').value), /^A\. Plastic pipes/);
    assert.equal(sheet.getCell('B12').value, '11');
    assert.equal(sheet.getCell('H12').value, 95);
    assert.equal(sheet.getCell('H12').fill.fgColor.argb, 'FFFFF2CC', 'rate cells are yellow inputs');
    assert.equal(sheet.getCell('H12').font.color.argb, 'FF0000FF', 'with blue text');
    assert.equal(sheet.getCell('I12').formula, 'IF(H12="","",ROUND(G12*H12,2))', 'amount is a live formula');
    assert.match(String(sheet.getCell('A18').value), /^B\. Other pipe items/);
    const formulas = [];
    sheet.eachRow((row) => row.eachCell((cell) => { if (cell.formula) formulas.push(cell.formula); }));
    assert.ok(formulas.includes('SUM(I11:I22)'), `subtotal formula (got ${formulas.slice(-9).join(' | ')})`);
    assert.ok(formulas.some((formula) => formula.startsWith('IF($J$7="Intra-state (Karnataka)",ROUND(')), 'CGST/SGST follow the supply type cell');
    assert.ok(formulas.some((formula) => formula.startsWith('IF($J$7="Inter-state",ROUND(')), 'IGST follows the supply type cell');
    const contractValues = new Set([470, 1500, 6406, 1244, 1655, 263, 407, 640, 971, 21337436]);
    sheet.eachRow((row) => row.eachCell((cell) => assert.ok(!contractValues.has(cell.value), `contract rate ${cell.value} leaked into ${cell.address}`)));
    let words = null;
    sheet.eachRow((row) => { if (row.getCell(1).value === 'Amount in words:') words = row.getCell(3).value; });
    assert.equal(words, quote.totals.amount_in_words);

    response = await api('GET', `/quotations/${quote.id}/export/excel`, { query: { internal: '1' } });
    workbook = await loadWorkbook(response.body);
    assert.deepEqual(workbook.worksheets.map((ws) => ws.name), ['Quotation', 'Internal - do not send']);
    const internal = workbook.getWorksheet('Internal - do not send');
    assert.match(String(internal.getCell('A1').value), /NEVER use as our rate/);
    const internalRow = [...Array(20).keys()].map((offset) => internal.getRow(4 + offset)).find((row) => row.getCell(1).value === '72');
    assert.equal(internalRow.getCell(5).value, 470);
    assert.equal(internalRow.getCell(6).value, 21337436);
    assert.match(internalRow.getCell(7).formula, /^IF\(OR\(D\d+="",E\d+=""\),"",ROUND\(D\d+\*E\d+,2\)\)$/);
    assert.match(internalRow.getCell(9).formula, /^IF\(Quotation!H\d+="","",Quotation!H\d+\)$/);
    assert.match(internalRow.getCell(10).formula, /ABOVE contract rate: check/);

    // ── PDF: customer-facing, no contract rates ──────────────
    response = await api('GET', `/quotations/${quote.id}/export/pdf`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.subarray(0, 5).toString(), '%PDF-');
    const pdf = await pdfInfo(response.body);
    assert.match(pdf.text, /SP\/2026-27\/0001/);
    assert.match(pdf.text, /HDPE pipe, grade PE80, PN 6\.0/);
    assert.match(pdf.text, /Page 1 of/);
    assert.doesNotMatch(pdf.text, /6,406\.00|2,13,37,436\.00|Internal|contract rate/i, 'PDF never shows BOQ contract rates');

    // ── WhatsApp: single send of the PDF ─────────────────────
    whatsappStatus = 'disconnected';
    assert.equal((await api('POST', `/quotations/${quote.id}/send-whatsapp`, { body: { phone: '98765 43210' } })).statusCode, 409, 'respects the connection check');
    whatsappStatus = 'connected';
    assert.equal((await api('POST', `/quotations/${quote.id}/send-whatsapp`, { body: { phone: '12' } })).statusCode, 400);
    response = await api('POST', `/quotations/${quote.id}/send-whatsapp`, { body: { phone: '98765 43210' } });
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(sent.length, 1, 'exactly one message');
    const [sentUser, sentPhone, caption, jid, media] = sent[0];
    assert.equal(sentUser, USER_A);
    assert.equal(sentPhone, '919876543210');
    assert.equal(jid, null);
    assert.match(caption, /^Quotation SP\/2026-27\/0001 from Sudarshan Pipes/);
    assert.equal(media.type, 'document');
    assert.ok(Buffer.isBuffer(media.buffer));
    assert.equal(media.mimetype, 'application/pdf');
    assert.equal(response.body.status, 'sent');
    assert.ok(response.body.sent_at);
    assert.equal(tables.quotations[0].sent_to, '919876543210');
    assert.equal(tables.quotations[0].send_claimed_at, null);

    // ── Duplicate -> new draft, next financial year ──────────
    response = await api('POST', `/quotations/${quote.id}/duplicate`);
    assert.equal(response.statusCode, 201);
    let copy = response.body;
    assert.equal(copy.status, 'draft');
    assert.equal(copy.quote_number, null);
    assert.equal(copy.version, 2);
    assert.equal(copy.items.find((item) => item.boq_item_no === '72').rate, 300, 'typed rates are copied');
    assert.equal((await api('POST', `/quotations/${copy.id}/send-whatsapp`, { body: { phone: '9876543210' } })).statusCode, 409, 'drafts cannot be sent');
    response = await api('PUT', `/quotations/${copy.id}`, { body: { quote_date: '2027-04-01' } });
    response = await api('POST', `/quotations/${copy.id}/finalize`);
    assert.equal(response.body.quote_number, 'SP/2027-28/0001', '1 April 2027 starts a new series');

    // New version on request starts empty again; drafts can be deleted.
    response = await api('POST', '/boq/501/quotation', { body: { new_version: true } });
    assert.equal(response.statusCode, 201);
    assert.equal(response.body.version, 3);
    assert.ok(response.body.items.every((item) => item.rate === null));
    const draftId = response.body.id;

    // Draft Excel with empty rates stays editable
    response = await api('GET', `/quotations/${draftId}/export/excel`);
    workbook = await loadWorkbook(response.body);
    const draftSheet = workbook.getWorksheet('Quotation');
    assert.equal(draftSheet.getCell('A3').value, 'QUOTATION (DRAFT)');
    assert.match(String(draftSheet.getCell('C5').value), /^SP\/\d{4}-\d{2}\/____/);
    assert.equal(draftSheet.getCell('H12').value, null, 'rate cell left empty');
    assert.equal(draftSheet.getCell('I12').formula, 'IF(H12="","",ROUND(G12*H12,2))');
    let draftWords = null;
    draftSheet.eachRow((row) => { if (row.getCell(1).value === 'Amount in words:') draftWords = row.getCell(3).value; });
    assert.equal(draftWords, exporter.AMOUNT_IN_WORDS_PLACEHOLDER);

    response = await api('GET', '/quotations', { query: { status: 'final' } });
    assert.deepEqual(response.body.data.map((row) => row.quote_number), ['SP/2027-28/0001']);
    response = await api('GET', '/quotations', { query: { search: 'SP/2026-27' } });
    assert.deepEqual(response.body.data.map((row) => row.quote_number), ['SP/2026-27/0001']);
    assert.equal((await api('GET', '/quotations', { query: { status: 'won' } })).statusCode, 400);
    assert.equal((await api('DELETE', `/quotations/${draftId}`)).statusCode, 200);
    assert.equal(tables.quotation_items.filter((item) => item.quotation_id === draftId).length, 0);

    // ── PDF with 300 long lines ──────────────────────────────
    const longText = 'Providing, laying and jointing HDPE pipes PE100 PN 10 conforming to IS 4984:2016 including all lead and lift, testing and commissioning. '.repeat(4);
    const bigItems = Array.from({ length: 300 }, (_value, index) => ({
        id: index + 1, line_no: index + 1, section: index % 3 ? 'A' : 'B', include: true,
        boq_item_no: String(index + 1), boq_item_code: `9.1.${index}`, description: index % 50 === 0 ? longText.repeat(6) : `HDPE pipe PE100 PN 10, ${90 + index} mm`,
        size_mm: 90 + index, unit: 'm', qty: 100 + index, rate: index % 7 ? 150 + index : null, hsn: '3917', remarks: index % 9 ? '' : 'Confirm availability and supply length before dispatch.',
        ref_rate: 999, ref_amount: 1, spec: {}, flags: [],
    }));
    const bigQuote = { id: 1, status: 'draft', quote_date: '2026-10-15', validity_days: 30, supply_type: 'intra', gst_percent: 18, discount_percent: 0, freight: 0, customer_name: 'Test', project_name: 'Large project', reference_text: '', terms: domain.defaultTerms({}) };
    const bigTotals = domain.calculateTotals(bigQuote, bigItems);
    const bigPdf = await exporter.renderQuotationPdf({ quotation: bigQuote, items: bigItems, totals: bigTotals, company: { name: 'Test Company' } });
    const bigInfo = await pdfInfo(bigPdf);
    assert.ok(bigInfo.pages >= 8, `300-line PDF spans many pages (${bigInfo.pages})`);
    assert.match(bigInfo.text, new RegExp(`Page ${bigInfo.pages} of ${bigInfo.pages}`));
    const headerRepeats = (bigInfo.text.match(/BOQ\s+Item\s+No\./g) || []).length;
    assert.ok(headerRepeats >= bigInfo.pages - 1, `table header repeats on every table page (${headerRepeats} of ${bigInfo.pages})`);
    const bigWorkbook = await loadWorkbook(await exporter.buildQuotationWorkbook({ quotation: bigQuote, items: bigItems, totals: bigTotals, company: {} }));
    assert.equal(bigWorkbook.getWorksheet('Quotation').getCell('A2').value, '[Registered office address]  |  GSTIN: [to fill]  |  Phone: [to fill]  |  Email: [to fill]');

    // ── Existing RFQ export keeps working ────────────────────
    response = await call(boqRoute.router, 'GET', '/501/export/excel');
    assert.equal(response.statusCode, 200);
    workbook = await loadWorkbook(response.body);
    assert.equal(workbook.getWorksheet('RFQ').getCell('A3').value, 'S.No');
    response = await call(boqRoute.router, 'GET', '/502/export/pdf');
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error, 'Confirm the requirement sheet before exporting an RFQ.');

    // ── Migration guard ──────────────────────────────────────
    const { createQuotationMigrationGuard, PENDING_MESSAGE } = require('../../database/quotationMigrationGuard');
    assert.equal(PENDING_MESSAGE, 'Database migration pending: run supabase-quotation-migration.sql in the Supabase SQL Editor');
    const logged = [];
    const checked = [];
    const guard = createQuotationMigrationGuard({
        client: {
            from(table) {
                checked.push(table);
                return { select() { return this; }, limit: async () => ({ error: table === 'quotation_items' ? { code: '42703' } : null }) };
            },
            rpc: async () => ({ data: true, error: null }),
        },
        databaseAvailable: () => true,
        logger: { error: (message) => logged.push(message), info: () => {} },
        now: () => 0,
    });
    assert.equal((await guard.check()).ok, false, 'a missing column means the migration is pending');
    assert.deepEqual(logged, [PENDING_MESSAGE], 'logs the pending message instead of crashing');
    assert.deepEqual(checked, ['quotations', 'quotation_items']);

    console.log('quotation-smoke.test.js passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
