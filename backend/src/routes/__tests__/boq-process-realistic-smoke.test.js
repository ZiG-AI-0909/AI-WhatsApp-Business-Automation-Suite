// =============================================================
// Smoke test — /api/boq/process with a REALISTIC document size.
//
// Regression for the silent hang/500 on real user uploads: a mid-size
// BOQ (28 line items, > 1 chunk) must split into bounded chunks, make
// one timed AI call per chunk, and return 201 with every row extracted.
// The AI service is stubbed at the module boundary (aiService._complete),
// so this proves the ROUTE's chunking/orchestration/logging — the AI
// provider call itself is exercised by live-full-verify.js.
//
// Run: node backend/src/routes/__tests__/boq-process-realistic-smoke.test.js
// =============================================================
const assert = require('assert');
const ExcelJS = require('exceljs');
const { EventEmitter } = require('node:events');

// ── Minimal in-memory Supabase mock injected BEFORE modules load ──
const USER_A = '11111111-1111-1111-1111-111111111111';

const state = { rows: { boq_documents: [], app_settings: [] } };

function table(name) {
    return {
        select(_columns) {
            const builder = {
                eq(col, val) { builder._filters.push([col, val]); return builder; },
                order() { return builder; },
                limit() { return builder; },
                range() { return builder; },
                _filters: [],
                async then(resolve) {
                    let rows = state.rows[name] || [];
                    for (const [col, val] of builder._filters) rows = rows.filter((r) => r[col] === val);
                    resolve({ data: rows.map((r) => ({ ...r })), error: null });
                },
            };
            builder.single = async () => {
                let rows = state.rows[name] || [];
                for (const [col, val] of builder._filters) rows = rows.filter((r) => r[col] === val);
                const row = rows[0] || null;
                return { data: row ? { ...row } : null, error: row ? null : { code: 'PGRST116' } };
            };
            return builder;
        },
        insert(row) {
            return {
                select() {
                    return {
                        single: async () => {
                            const stored = { ...row, id: state.rows[name].length + 1 };
                            state.rows[name].push(stored);
                            return { data: stored, error: null };
                        },
                    };
                },
            };
        },
        update(data) {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push([col, val]); return builder; },
                select: async () => {
                    state.rows[name] = state.rows[name].map((r) =>
                        filters.every(([c, v]) => r[c] === v) ? { ...r, ...data } : r);
                    return { data: state.rows[name].filter((r) => filters.every(([c, v]) => r[c] === v)), error: null };
                },
            };
            return builder;
        },
        delete() {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push([col, val]); return builder; },
                then: (resolve) => resolve({ data: null, error: null }),
            };
            return builder;
        },
    };
}

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

process.env.AI_API_KEY = 'env-test-key';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
// Shrink the chunk size (read at module load) so the compact 28-row fixture
// crosses one chunk boundary and the multi-chunk orchestration is exercised.
process.env.BOQ_CHUNK_MAX_CHARS = '1500';
// Shrink the wall-time budget (also read at module load) so the per-chunk
// division math runs in compressed time: 12s budget, 2s floor, 5s ceiling
// → chunk cap = max(8, floor(12000 / 2000)) = 8 (the size-cap fix floors
// the cap at 8 so the real 19-page tender's ~7 chunks never re-reject).
process.env.BOQ_TOTAL_BUDGET_MS = '14000';
process.env.BOQ_AI_MIN_CALL_MS = '2000';
process.env.BOQ_AI_MAX_CALL_MS = '5000';
process.env.BOQ_AI_GLOBAL_CONCURRENCY = '2';
const BOQ_TOTAL_BUDGET_MS = 14000;
const BOQ_AI_MAX_CALL_MS = 5000;
const EXPECTED_MAX_CHUNKS = Math.max(8, Math.floor(BOQ_TOTAL_BUDGET_MS / 2000) * Number(process.env.BOQ_AI_CONCURRENCY || 4));

const boqExtractor = require('../../documents/boqExtractor');
const documentModel = require('../../documents/documentModel');
const boqRoute = require('../../routes/boq');

// ── Stub the AI at the service boundary; record calls + latency ──
const aiCalls = [];
const aiService = require('../../ai/aiService');
function structuredInputRows(prompt) {
    const rowsMatch = String(prompt).match(/SOURCE ROWS[^\n]*:\n([\s\S]*?)\n\nFor each input row/);
    return rowsMatch ? JSON.parse(rowsMatch[1]) : null;
}

aiService._complete = async (messages, options = {}) => {
    const start = Date.now();
    const promptText = messages[0].content;
    aiCalls.push({ options, start, promptText });
    // Simulate the provider latency so the logs show realistic timing.
    await new Promise((r) => setTimeout(r, 15));
    const sourceRows = structuredInputRows(promptText);
    if (sourceRows) {
        return JSON.stringify({ items: sourceRows.map((row) => ({
            rowId: row.rowId,
            product: row.product || row.description || row.context?.[0]?.value || null,
            size: row.size || null,
            specification: row.specification || null,
            application: row.application || null,
            remarks: row.notes || null,
            confidence: {},
            warnings: [],
        })) });
    }
    const docSection = promptText.split('DOCUMENT:')[1] || '';
    // Behave like the real model: one JSON item per `N | product | ...` row.
    const rows = [...docSection.matchAll(/^(\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| (\d+) \| (\w+)$/gm)];
    const items = rows.map((m) => ({
        product: m[2].trim().replace(/\s+\d+mm$/, ''),
        size: m[3].trim(),
        specification: m[4].trim(),
        quantity: m[5],
        unit: m[6],
        application: '',
        notes: '',
    }));
    return JSON.stringify({ items });
};

// ── Express plumbing: invoke the route handler directly ──
function makeReqRes(file, jobId) {
    const req = new EventEmitter();
    Object.assign(req, {
        user: { id: USER_A }, file, body: {}, params: {},
        headers: jobId ? { 'x-boq-job-id': jobId } : {},
        get: (name) => jobId && name.toLowerCase() === 'x-boq-job-id' ? jobId : undefined,
    });
    let statusCode = null; let body = null;
    const res = new EventEmitter();
    res.writableEnded = false;
    res.json = (data) => { body = data; res.writableEnded = true; return data; };
    res.status = (code) => { statusCode = code; return res; };
    return { req, res, getStatus: () => statusCode, getBody: () => body };
}

async function runProgressHandler(method, jobId) {
    const layer = boqRoute.router.stack.find((entry) =>
        entry.route?.path === '/progress/:jobId' && entry.route?.methods?.[method]
    );
    assert.ok(layer, `/${method} /progress/:jobId route exists`);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const req = { user: { id: USER_A }, params: { jobId } };
    let statusCode = null;
    let body = null;
    const res = {
        json(data) { body = data; return data; },
        status(code) { statusCode = code; return { json(data) { body = data; return data; } }; },
    };
    await handler(req, res);
    return { statusCode, body };
}

// 28 line items — a realistic mid-size BOQ (the live-verify fixture is 3).
async function buildRealisticBoqXlsx(itemCount = 28) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('BOQ');
    sheet.addRow(['Item', 'Description', 'Size', 'Specification', 'Quantity', 'Unit']);
    const products = ['HDPE Pipe', 'uPVC Pipe', 'Ductile Iron Pipe', 'Compression Fitting', 'GI Pipe', 'CPVC Pipe'];
    const specs = ['IS 4985:2020 PN10', 'PE100 PN10', 'IS 4984:2016 PN10', 'PN16', 'IS 1239', 'Sch 40'];
    const units = ['m', 'nos'];
    for (let i = 1; i <= itemCount; i++) {
        const product = products[i % products.length];
        const size = `${60 + (i % 6) * 25}mm`;
        sheet.addRow([String(i), `${product} ${size}`, size, specs[i % specs.length], String(100 * i), units[i % 2]]);
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function test1_realisticBoqEndToEnd() {
    console.log('▶ Test 1: 28-item structured BOQ processes through row batches');
    aiCalls.length = 0;
    const buffer = await buildRealisticBoqXlsx(28);
    const { req, res, getStatus, getBody } = makeReqRes({
        originalname: 'realistic-boq.xlsx',
        size: buffer.length,
        buffer,
    });

    // fileValidation: the route calls respondIfInvalidUpload first — provide
    // the magic-byte check with a valid xlsx buffer (real file, so it passes).
    const postStart = Date.now();
    await runProcessHandler(req, res);
    const elapsed = Date.now() - postStart;

    assert.strictEqual(getStatus(), 201, `expected 201, got ${getStatus()} — body: ${JSON.stringify(getBody())}`);
    const doc = getBody();
    assert.strictEqual(doc.items.length, 28, `one final requirement row per canonical source row (got ${doc.items.length})`);
    for (let n = 1; n <= 28; n++) {
        assert.ok(doc.items.some((it) => Number(it.quantity) === 100 * n), `row ${n} present in extraction output`);
    }
    assert.ok(aiCalls.length >= 1, 'structured table was sent in one or more AI batches');
    assert.ok(aiCalls.every((call) => structuredInputRows(call.promptText)?.length <= 40), 'no AI request contains more than the row limit');
    // Budget contract: every attempt fits under the per-call ceiling and
    // every chunk works against the SAME wall-clock deadline (the route
    // derives it once from BOQ_TOTAL_BUDGET_MS).
    assert.ok(aiCalls.every((c) => c.options.timeoutMs > 0 && c.options.timeoutMs <= BOQ_AI_MAX_CALL_MS), `per-call timeout within (${BOQ_AI_MAX_CALL_MS}) ceiling, got ${aiCalls.map((c) => c.options.timeoutMs).join(', ')}`);
    const deadlines = aiCalls.map((c) => c.options.deadlineMs);
    assert.ok(deadlines.every((d) => d > 0), 'every chunk call carries a deadline');
    assert.ok(Math.max(...deadlines) - Math.min(...deadlines) < 1000, 'all chunk calls share one wall-clock deadline');
    assert.ok(aiCalls.every((c) => c.options.minAttemptMs > 0), 'per-call floor passed through');
    assert.ok(aiCalls.every((c) => c.options.retries === 0), 'AI client does not add hidden retries to batch retry policy');
    console.log(`   → route wall time ${elapsed}ms, ${aiCalls.length} AI batch call(s), ${doc.items.length} items extracted`);
    console.log('✅ Test 1 passed\n');
}

async function test2_chunkCapSurfaces413() {
    console.log('▶ Test 2: oversized document surfaces a clear 413 (not a hang/500)');
    aiCalls.length = 0; // reset counter shared with test 1
    // Large text document → far more chunks than the concurrency-aware cap
    // (floor(12000/2000) × concurrency) → reject BEFORE calling the
    // AI (it used to accept anything under 60k chars and then die
    // silently in one giant call).
    const lines = ['Item | Description | Size | Specification | Quantity | Unit'];
    for (let i = 1; i <= 700; i++) {
        lines.push(`${i} | HDPE Pipe ${60 + (i % 6) * 25}mm | ${60 + (i % 6) * 25}mm | IS 4984:2016 PE100 PN10 | ${100 * i} | m`);
    }
    const text = lines.join('\n');
    assert.ok(text.length > EXPECTED_MAX_CHUNKS * 1500, `fixture sized to exceed the chunk cap (${text.length} chars > ${EXPECTED_MAX_CHUNKS} × 1500)`);
    // (The old hard 60k reject is gone — the CHUNK cap is now the only size
    // bound, and this fixture is sized to trip it, not any char ceiling.)

    const { req, res, getStatus, getBody } = makeReqRes({
        originalname: 'oversized-boq.txt',
        size: Buffer.byteLength(text),
        buffer: Buffer.from(text, 'utf8'),
    });
    await runProcessHandler(req, res);
    assert.strictEqual(getStatus(), 413, `expected 413, got ${getStatus()} — body: ${JSON.stringify(getBody())}`);
    assert.ok(/Split it into smaller parts/.test(getBody().error), `clear split-it error, got: ${getBody().error}`);
    assert.strictEqual(aiCalls.length, 0, 'no AI call is made for a capped-out document');
    console.log('✅ Test 2 passed\n');
}

async function test3_aiFailureSurfacesClearError() {
    console.log('▶ Test 3: failed structured batch is retained with a review warning');
    const original = aiService._complete;
    let calls = 0;
    aiService._complete = async () => { calls++; throw new Error('AI provider error (HTTP 401): invalid key.'); };
    try {
        const smallBuffer = await buildRealisticBoqXlsx(3);
        const { req, res, getStatus, getBody } = makeReqRes({
            originalname: 'boq-small.xlsx',
            size: smallBuffer.length,
            buffer: smallBuffer,
        });
        await runProcessHandler(req, res);
        assert.strictEqual(getStatus(), 201, `usable source rows should be retained, got ${getStatus()}`);
        assert.strictEqual(getBody().status, 'review');
        assert.strictEqual(getBody().items.length, 3);
        assert.ok(getBody().items.every((item) => item.warnings.some((warning) => /AI batch review required/.test(warning))));
        assert.strictEqual(calls, 2, 'one batch attempt plus exactly one batch retry');
    } finally {
        aiService._complete = original;
    }
    console.log('✅ Test 3 passed\n');
}

async function test4_timeoutSurfaces504WithRetryHint() {
    console.log('▶ Test 4: AI timeout retries the batch, then retains source rows for review');
    const original = aiService._complete;
    // Mimic the shape the REAL _complete throws on ECONNABORTED
    // (aiKind drives the route's 504 mapping).
    aiService._complete = async () => {
        const e = new Error('AI provider timed out after 3s.');
        e.aiKind = 'timeout';
        e.attempts = 2;
        throw e;
    };
    try {
        const smallBuffer = await buildRealisticBoqXlsx(3);
        const { req, res, getStatus, getBody } = makeReqRes({
            originalname: 'boq-timeout.xlsx',
            size: smallBuffer.length,
            buffer: smallBuffer,
        });
        await runProcessHandler(req, res);
        assert.strictEqual(getStatus(), 201, `timed-out batch should retain source rows: ${JSON.stringify(getBody())}`);
        assert.strictEqual(getBody().status, 'review');
        assert.strictEqual(getBody().items.length, 3);
        assert.ok(getBody().warnings.some((warnings) => warnings.some((warning) => /AI batch review required/.test(warning))));
    } finally {
        aiService._complete = original;
    }
    console.log('✅ Test 4 passed\n');
}

async function test5_perChunkBudgetDivision() {
    console.log('▶ Test 5: structured batch concurrency is bounded and deadlines are shared');
    aiCalls.length = 0;
    const original = aiService._complete;
    let active = 0;
    let peakActive = 0;
    aiService._complete = async (messages, options = {}) => {
        aiCalls.push({ options, start: Date.now(), promptText: messages[0].content });
        active++;
        peakActive = Math.max(peakActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        const rows = structuredInputRows(messages[0].content) || [];
        return JSON.stringify({ items: rows.map((row) => ({
            rowId: row.rowId, product: 'HDPE Pipe', size: row.size || '110mm',
            specification: 'PE100', application: '', remarks: '', confidence: {}, warnings: [],
        })) });
    };
    try {
        // ~80 rows ≈ 5k chars → 4 chunks at the 1500-char test chunk size.
        // Concurrency default 4 → ONE wave. Each call's timeout must equal
        // the remaining budget ÷ REMAINING WAVES (ceiling-clamped) — the
        // sequential formula starved real chunks to 7s (production bug).
        const buffer = await buildRealisticBoqXlsx(80);
        const { req, res, getStatus, getBody } = makeReqRes({
            originalname: 'boq-4chunk.xlsx',
            size: buffer.length,
            buffer,
        });
        await runProcessHandler(req, res);
        assert.strictEqual(getStatus(), 201, `expected 201, got ${getStatus()} — body: ${JSON.stringify(getBody())}`);
        assert.ok(aiCalls.length >= 2, `multi-chunk run (got ${aiCalls.length} calls)`);
        assert.ok(aiCalls.every((call) => call.options.retries === 0), 'logical retry policy remains outside the provider client');
        assert.ok(peakActive <= Number(process.env.BOQ_AI_CONCURRENCY || 4), `peak concurrency ${peakActive} stays under the configured limit`);
        const totalChunks = aiCalls.length;
        const CONCURRENCY = Number(process.env.BOQ_AI_CONCURRENCY || 4);
        aiCalls.forEach((call, i) => {
            const chunksLeft = totalChunks - i;
            const wavesLeft = Math.max(1, Math.ceil(chunksLeft / CONCURRENCY));
            const remaining = call.options.deadlineMs - call.start;
            const expected = Math.max(100, Math.min(BOQ_AI_MAX_CALL_MS, Math.floor(remaining / wavesLeft)));
            assert.ok(
                Math.abs(call.options.timeoutMs - expected) <= 100,
                `chunk ${i + 1}/${totalChunks}: timeout ${call.options.timeoutMs}ms ≈ remaining ${Math.round(remaining)}ms ÷ ${wavesLeft} wave(s) = ${expected}ms`
            );
        });
        // Wave semantics: all calls in one wave share (roughly) the same
        // timeout, and each wave's budget is bounded by the ceiling.
        const waveGroups = new Map();
        aiCalls.forEach((call) => {
            const bucket = Math.round(call.options.timeoutMs / 500);
            waveGroups.set(bucket, (waveGroups.get(bucket) || 0) + 1);
        });
        assert.ok(Array.from(waveGroups.values()).every((n) => n >= 1), 'per-call timeouts recorded');
        // CONCURRENCY PROOF: wave siblings run simultaneously, so they all
        // divide the SAME remaining budget by the SAME wavesLeft — their
        // timeouts must be ~identical. (No sum invariant exists under
        // waves: 4 concurrent calls each holding a ceiling timeout still
        // cost only ONE call's wall time — that overlap is the point.)
        const timeouts = aiCalls.map((c) => c.options.timeoutMs);
        assert.ok(Math.max(...timeouts) - Math.min(...timeouts) <= 250,
            `same-wave siblings must get ~equal shares (got ${timeouts.join(', ')})`);
        // And with 4 chunks at concurrency 4 (one wave), each call gets the
        // FULL remaining budget (ceiling-clamped) — the old sequential
        // formula would have given each only remaining/4.
        assert.ok(timeouts.every((t) => t >= BOQ_AI_MAX_CALL_MS - 250),
            `one-wave calls get the whole remaining budget, not a quarter (got ${timeouts.join(', ')})`);
        console.log(`   → ${totalChunks} chunks, per-call budgets: ${aiCalls.map((c) => c.options.timeoutMs).join(', ')}ms`);
    } finally {
        aiService._complete = original;
    }
    console.log('✅ Test 5 passed\n');
}

async function test6_sourceColumnsOverrideAiValues() {
    console.log('▶ Test 6: source quantity/unit survive conflicting AI enrichment');
    aiCalls.length = 0;
    const original = aiService._complete;
    aiService._complete = async (messages, options = {}) => {
        const prompt = messages[0].content;
        aiCalls.push({ options, start: Date.now(), promptText: prompt });
        assert.match(prompt, /SOURCE ROWS/);
        const sourceRows = structuredInputRows(prompt);
        return JSON.stringify({ items: [{
            rowId: sourceRows[0].rowId,
            product: 'Water Pump',
            size: '200 mm',
            specification: 'Class 150',
            quantity: 1,
            unit: 'dia',
            application: null,
            remarks: null,
            confidence: { product: 0.94, size: 0.9 },
            warnings: [],
        }] });
    };
    try {
        const workbook = new ExcelJS.Workbook();
        workbook.addWorksheet('Tender').addRows([
            ['S.No', 'Item Code', 'Description', 'Unit', 'Estimate Quantity'],
            ['72', 'ME-9.1', 'Providing and installing a 200 mm dia water pump', 'm', '22,699.40'],
        ]);
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        const { req, res, getStatus, getBody } = makeReqRes({
            originalname: 'generic-boq.xlsx',
            size: buffer.length,
            buffer,
        });
        await runProcessHandler(req, res);
        assert.equal(getStatus(), 201, JSON.stringify(getBody()));
        const item = getBody().items[0];
        assert.equal(item.quantity, 22699.4);
        assert.equal(item.unit, 'm');
        assert.equal(item.serialNumber, '72');
        assert.equal(item.itemCode, 'ME-9.1');
        assert.equal(item.product, null, 'untrusted AI response is not merged after validation fails');
        assert.equal(item.sourceValues['Estimate Quantity'], '22,699.40');
        assert.equal(item.provenance.columns.unit, 'Unit');
        assert.equal(item.provenance.row, 2);
        assert.ok(item.warnings.some((warning) => /AI batch review required/.test(warning)));
        assert.equal(aiCalls.length, 2, 'the invalid batch is retried exactly once');
        assert.ok(aiCalls.every((call) => !['72', 'ME-9.1', '22,699.40'].some((value) => call.promptText.includes(value))), 'AI prompt omits source S.No, item code, and quantity values');
        assert.equal(getBody().extraction_metadata.strategy, 'structured_tables');
    } finally {
        aiService._complete = original;
    }
    console.log('✅ Test 6 passed\n');
}

async function test7_nativePdfUsesVisualTableReconstruction() {
    console.log('▶ Test 7: route canonical rows preserve visual BOQ columns before AI');
    const originalComplete = aiService._complete;
    const originalParseDocument = boqExtractor.parseDocument;
    const pdfOcr = require('../../documents/pdfOcr');
    const originalVisualOcr = pdfOcr.ocrNativePdfPages;
    const originalConsoleLog = console.log;
    const originalDebugFlag = process.env.BOQ_DEBUG_SOURCE_ROWS;
    const debugLogs = [];
    let renderedPages = [];
    process.env.BOQ_DEBUG_SOURCE_ROWS = '1';
    console.log = (...args) => { debugLogs.push(args.join(' ')); };
    aiService._complete = async (messages) => {
        const prompt = messages[0].content;
        assert.match(prompt, /SOURCE ROWS/);
        const debug = debugLogs.join('\n');
        assert.match(debug, /SOURCE ROW 97/);
        assert.match(debug, /Quantity: 53847\.5/);
        assert.match(debug, /Unit: m²/);
        assert.match(debug, /Rate: 4807\.66/);
        assert.match(debug, /Bounding boxes:/);
        const inputRows = structuredInputRows(prompt);
        assert.ok(inputRows.every((row) => !['quantity', 'unit', 'rate', 'amount', 'serialNumber', 'itemCode'].some((field) => Object.hasOwn(row, field))),
            'AI receives descriptive context only; source values stay backend-controlled');
        for (const protectedValue of ['97', '53847.5', 'm²', '4807.66', '259000000.00']) {
            assert.ok(!JSON.stringify(inputRows).includes(protectedValue), `${protectedValue} stays out of the AI row payload`);
        }
        return JSON.stringify({ items: inputRows.map((row) => ({
            rowId: row.rowId,
            product: null,
            size: null,
            specification: null,
            application: null,
            remarks: null,
            confidence: {},
            warnings: [],
        })) });
    };
    boqExtractor.parseDocument = async (_buffer, ext, filename) => ({
        metadata: { filename, fileExt: ext },
        rawText: 'S.No Description Quantity Unit Rate Amount\n97 Prime Coat 53847.5 m² 4807.66 259000000.00',
        pages: [{ page: 1, text: 'S.No Description Quantity Unit Rate Amount\n97 Prime Coat 53847.5 m² 4807.66 259000000.00' }],
        sheets: [],
        tables: [],
    });
    pdfOcr.ocrNativePdfPages = async (_buffer, _userId, pages) => {
        renderedPages = pages;
        const box = (text, left, top, right) => ({
            text,
            boundingBox: { points: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: top + 8 }, { x: left, y: top + 8 }] },
            confidence: 0.99,
        });
        const row = (serial, description, quantity, unit, rate, amount, y) => [
            ...(serial ? [box(serial, 20, y, 55)] : []),
            ...(description ? [box(description, 100, y, 540)] : []),
            ...(quantity ? [box(quantity, 600, y, 665)] : []),
            ...(unit ? [box(unit, 700, y, 730)] : []),
            ...(rate ? [box(rate, 780, y, 820)] : []),
            ...(amount ? [box(amount, 870, y, 930)] : []),
        ];
        return {
            pageCount: 1,
            failedPages: [],
            pages: [{
                page: 1,
                width: 1000,
                height: 1200,
                rows: [
                    [box('S.No', 20, 100, 55), box('Description', 100, 100, 225), box('Quantity', 600, 100, 665), box('Unit', 700, 100, 730), box('Rate', 780, 100, 820), box('Amount', 870, 100, 930)],
                    row('97', 'Prime Coat including preparation of surface', '', '', '', '', 130),
                    row('', 'and spraying a uniform coat', '53847.5', 'm²', '4807.66', '259000000.00', 141),
                    row('98', 'HDPE pipe 200mm PE80 PN6', '125', 'm', '121.25', '15156.25', 170),
                    row('99', 'HDPE pipe 600mm SN8 DWC', '48', 'm³', '300.00', '14400.00', 190),
                    row('100', 'HDPE pipe 250mm SN8 DWC', '300', 'No.', '4807.66', '100.00', 210),
                    row('101', 'HDPE pipe 300mm SN8 DWC', '75', 'Each', '437.32', '32799.00', 230),
                ],
            }],
        };
    };
    try {
        const { req, res, getStatus, getBody } = makeReqRes({
            originalname: 'visual-source-regression.pdf',
            size: 20,
            buffer: Buffer.from('%PDF-1.7 visual fixture'),
        });
        await runProcessHandler(req, res);
        assert.equal(getStatus(), 201, JSON.stringify(getBody()));
        assert.deepEqual(renderedPages, [1]);
        const items = getBody().items;
        assert.equal(items.length, 5, 'canonical rows are correct before AI and remain one per visible BOQ item');
        const primer = items.find((item) => item.serialNumber === '97');
        assert.match(primer.description, /Prime Coat including preparation of surface and spraying a uniform coat/);
        assert.equal(primer.quantity, 53847.5);
        assert.equal(primer.unit, 'm²');
        assert.equal(primer.sourceValues.Rate, '4807.66');
        assert.equal(primer.sourceValues.Amount, '259000000.00');
        const hdpe = items.filter((item) => /HDPE pipe/.test(item.description));
        assert.deepEqual(hdpe.map((item) => item.description.match(/\d+mm[^ ]*(?: [^ ]+)*/)?.[0]), [
            '200mm PE80 PN6', '600mm SN8 DWC', '250mm SN8 DWC', '300mm SN8 DWC',
        ]);
        assert.deepEqual(hdpe.map((item) => [item.quantity, item.unit]), [[125, 'm'], [48, 'm³'], [300, 'No.'], [75, 'Each']]);
        assert.ok(primer.provenance.cellBounds.some((cell) => cell.column === 5 && cell.boundingBox.points.length > 0));
        assert.equal(getBody().extraction_metadata.strategy, 'pdf_visual_tables');
        assert.ok(getBody().extraction_metadata.pages[0].rows.length > 0);
    } finally {
        aiService._complete = originalComplete;
        boqExtractor.parseDocument = originalParseDocument;
        pdfOcr.ocrNativePdfPages = originalVisualOcr;
        console.log = originalConsoleLog;
        if (originalDebugFlag === undefined) delete process.env.BOQ_DEBUG_SOURCE_ROWS;
        else process.env.BOQ_DEBUG_SOURCE_ROWS = originalDebugFlag;
    }
    console.log('✅ Test 7 passed\n');
}

async function test8_largeBoqBatchSixMalformedThenReviewFallback() {
    console.log('▶ Test 8: 500 source rows survive a twice-malformed batch 6');
    aiCalls.length = 0;
    const original = aiService._complete;
    const batchNumbers = new Map();
    const batchAttempts = new Map();
    const batchRows = new Map();
    let active = 0;
    let peakActive = 0;
    aiService._complete = async (messages, options = {}) => {
        const promptText = messages[0].content;
        const inputRows = structuredInputRows(promptText);
        assert.ok(inputRows?.length, 'every AI call has at least one row and uses structured input');
        assert.ok(inputRows.length <= 40, 'request does not exceed the configured row cap');
        const batchId = inputRows[0].rowId;
        if (!batchNumbers.has(batchId)) {
            batchNumbers.set(batchId, batchNumbers.size + 1);
            batchRows.set(batchId, inputRows.map((row) => row.rowId));
        }
        const batchNumber = batchNumbers.get(batchId);
        batchAttempts.set(batchId, (batchAttempts.get(batchId) || 0) + 1);
        aiCalls.push({ options, start: Date.now(), promptText, batchId, batchNumber });
        active++;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        if (batchNumber === 6) return '{"items": [';
        return { items: inputRows.map((row) => ({
            rowId: row.rowId,
            product: 'Pump assembly',
            size: row.size,
            specification: row.specification,
            application: null,
            remarks: row.notes,
            confidence: { product: 0.9 },
            warnings: [],
        })) };
    };
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Large BOQ');
        sheet.addRow(['S.No', 'Item Code', 'Description', 'Size', 'Quantity', 'Unit', 'Remarks']);
        for (let index = 1; index <= 500; index++) {
            sheet.addRow([
                String(index),
                `CODE-${String(index).padStart(4, '0')}`,
                'Providing and installing pump assembly\nincluding inspection and commissioning',
                'DN100',
                '5',
                'm',
                'Repeat specification',
            ]);
        }
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        const { req, res, getStatus, getBody } = makeReqRes({
            originalname: '500-row-boq.xlsx',
            size: buffer.length,
            buffer,
        });
        await runProcessHandler(req, res);

        assert.equal(getStatus(), 201, `partial AI failure must still save usable source rows: ${JSON.stringify(getBody()).slice(0, 500)}`);
        const doc = getBody();
        assert.equal(doc.status, 'review');
        assert.equal(doc.items.length, 500, 'no canonical source rows are dropped');
        assert.equal(new Set(doc.items.map((item) => item.lineItemId)).size, 500, 'stable row IDs remain unique despite duplicate-looking content');
        assert.equal(batchNumbers.size, aiCalls.length - 1, '500 rows fan out into 10+ AI batches plus one retry call');
        assert.ok(batchNumbers.size >= 10, `expected 10+ batches, got ${batchNumbers.size}`);
        assert.equal(batchAttempts.size, batchNumbers.size);
        for (const [batchId, batchNumber] of batchNumbers) {
            assert.equal(batchAttempts.get(batchId), batchNumber === 6 ? 2 : 1,
                `only batch 6 retries (batch ${batchNumber} attempts=${batchAttempts.get(batchId)})`);
        }
        assert.ok(peakActive <= Number(process.env.BOQ_AI_GLOBAL_CONCURRENCY || 8), `peak active calls ${peakActive} stay process-wide bounded`);
        const failedIds = new Set([...batchNumbers].find(([, batchNumber]) => batchNumber === 6)
            ? batchRows.get([...batchNumbers].find(([, batchNumber]) => batchNumber === 6)[0])
            : []);
        assert.ok(failedIds.size > 0, 'batch 6 has stable source IDs');
        for (const item of doc.items) {
            assert.equal(item.quantity, 5, `source quantity remains authoritative for row ${item.provenance.row}`);
            assert.equal(item.unit, 'm', `source unit remains authoritative for row ${item.provenance.row}`);
            assert.match(item.description, /including inspection and commissioning/, 'wrapped description remains complete');
            assert.ok(!item.lineItemId.includes('CODE-'), 'row ID does not expose or depend on item code');
            const needsReview = item.warnings.some((warning) => /AI batch review required/.test(warning));
            assert.equal(needsReview, failedIds.has(item.lineItemId), 'review warnings map only to failed batch 6 rows');
            if (!failedIds.has(item.lineItemId)) assert.equal(item.product, 'Pump assembly', 'successful batch enrichment is retained');
        }
        const failedItems = doc.items.filter((item) => failedIds.has(item.lineItemId));
        assert.ok(failedItems.every((item) => item.product === null), 'malformed batch enrichment is not partially merged');
        assert.ok(aiCalls.every((call) => {
            const inputRows = structuredInputRows(call.promptText);
            return inputRows.every((row) => !Object.hasOwn(row, 'quantity') && !Object.hasOwn(row, 'unit')
                && !Object.hasOwn(row, 'serialNumber') && !Object.hasOwn(row, 'itemCode'));
        }), 'AI receives none of the protected source values');
        const rfq = boqRoute.rfqRows(doc);
        assert.equal(rfq.length, 500, 'the final requirement sheet keeps all rows available to RFQ generation');
        assert.ok(rfq.every((row) => row.Quantity === 5 && row.Unit === 'm'), 'RFQ rows use backend source quantity and unit');
        console.log(`   → ${doc.items.length} source rows; ${batchNumbers.size} batches; batch 6 retried once; ${failedItems.length} rows marked for review`);
    } finally {
        aiService._complete = original;
    }
    console.log('✅ Test 8 passed\n');
}

async function test9_globalConcurrencyAcrossUploads() {
    console.log('▶ Test 9: simultaneous BOQ uploads share the process-wide AI cap');
    const original = aiService._complete;
    let active = 0;
    let peakActive = 0;
    aiService._complete = async (messages) => {
        const rows = structuredInputRows(messages[0].content) || [];
        active++;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return { items: rows.map((row) => ({
            rowId: row.rowId, product: 'Pipe', size: row.size || null,
            specification: null, application: null, remarks: null,
            confidence: {}, warnings: [],
        })) };
    };
    try {
        const buffers = await Promise.all([buildRealisticBoqXlsx(80), buildRealisticBoqXlsx(80)]);
        const requests = buffers.map((buffer, index) => {
            const pair = makeReqRes({ originalname: `concurrent-${index}.xlsx`, size: buffer.length, buffer });
            return { pair, run: runProcessHandler(pair.req, pair.res) };
        });
        await Promise.all(requests.map(({ run }) => run));
        assert.ok(requests.every(({ pair }) => pair.getStatus() === 201), 'both uploads complete successfully');
        assert.ok(requests.every(({ pair }) => pair.getBody().items.length === 80), 'both requirement sheets retain all source rows');
        assert.ok(peakActive > 1, 'the two requests overlap in processing');
        assert.ok(peakActive <= 2, `aggregate AI concurrency ${peakActive} does not exceed the process cap of 2`);
    } finally {
        aiService._complete = original;
    }
    console.log('✅ Test 9 passed\n');
}

async function test10_progressSnapshotsForSuccessAndBatchFailure() {
    console.log('▶ Test 10: progress reaches 100% and reports failed rows');
    const original = aiService._complete;
    aiService._complete = async (messages) => {
        const rows = structuredInputRows(messages[0].content) || [];
        await new Promise((resolve) => setTimeout(resolve, 12));
        return { items: rows.map((row) => ({
            rowId: row.rowId, product: 'Progress test item', size: row.size || null,
            specification: null, application: null, remarks: null,
            confidence: {}, warnings: [],
        })) };
    };
    try {
        const buffer = await buildRealisticBoqXlsx(500);
        const jobId = 'progress-success-500';
        const pair = makeReqRes({ originalname: 'progress-500.xlsx', size: buffer.length, buffer }, jobId);
        let completed = false;
        const processing = runProcessHandler(pair.req, pair.res).finally(() => { completed = true; });
        let sawBatchProgress = false;
        while (!completed) {
            const snapshot = await runProgressHandler('get', jobId);
            assert.equal(snapshot.statusCode, null);
            sawBatchProgress ||= snapshot.body.completedBatches > 0;
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        await processing;
        const success = (await runProgressHandler('get', jobId)).body;
        assert.equal(pair.getStatus(), 201);
        assert.ok(success.totalBatches > 1, `expected multiple batches, got ${success.totalBatches}`);
        assert.equal(success.completedBatches, success.totalBatches);
        assert.equal(success.totalSourceRows, 500);
        assert.equal(success.handledRows, 500);
        assert.equal(success.percent, 100);
        assert.ok(sawBatchProgress, 'polling observed intermediate batch progress');

        let attempts = 0;
        aiService._complete = async () => { attempts++; return '{"items": ['; };
        const smallBuffer = await buildRealisticBoqXlsx(3);
        const failedJobId = 'progress-failed-3';
        const failedPair = makeReqRes({ originalname: 'progress-failed.xlsx', size: smallBuffer.length, buffer: smallBuffer }, failedJobId);
        await runProcessHandler(failedPair.req, failedPair.res);
        const failed = (await runProgressHandler('get', failedJobId)).body;
        assert.equal(failedPair.getStatus(), 201);
        assert.equal(attempts, 2, 'one malformed batch is retried once');
        assert.equal(failed.completedBatches, 1);
        assert.equal(failed.totalBatches, 1);
        assert.equal(failed.handledRows, 3);
        assert.equal(failed.reviewCount, 3, 'failed batch rows increment the review count');
        assert.equal(failed.percent, 100, 'settled failed batches still count toward operational completion');
    } finally {
        aiService._complete = original;
    }
    console.log('✅ Test 10 passed\n');
}

async function test11_cancellationStopsQueuePreservesRowsAndReleasesSlot() {
    console.log('▶ Test 11: cancellation stops future batches and preserves completed work');
    const original = aiService._complete;
    const jobId = 'cancel-large-500';
    const callGroups = new Map();
    const successfulRowIds = new Set();
    let activeCalls = 0;
    let peakActive = 0;
    aiService._complete = async (messages, options = {}) => {
        const rows = structuredInputRows(messages[0].content) || [];
        const firstId = rows[0].rowId;
        if (!callGroups.has(firstId)) callGroups.set(firstId, callGroups.size + 1);
        const batchNumber = callGroups.get(firstId);
        activeCalls++;
        peakActive = Math.max(peakActive, activeCalls);
        if (batchNumber === 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            activeCalls--;
            rows.forEach((row) => successfulRowIds.add(row.rowId));
            return { items: rows.map((row) => ({
                rowId: row.rowId, product: 'Completed before cancellation', size: row.size || null,
                specification: null, application: null, remarks: null,
                confidence: {}, warnings: [],
            })) };
        }
        return new Promise((resolve, reject) => {
            const signal = options.signal;
            const onAbort = () => {
                activeCalls--;
                reject(Object.assign(new Error('provider request aborted'), { name: 'AbortError', code: 'ERR_CANCELED' }));
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        });
    };
    try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Cancel BOQ');
        sheet.addRow(['S.No', 'Item Code', 'Description', 'Size', 'Quantity', 'Unit']);
        for (let index = 1; index <= 500; index++) {
            sheet.addRow([String(index), `C-${index}`, 'Identical valve assembly description', 'DN80', '4', 'nos']);
        }
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        const pair = makeReqRes({ originalname: 'cancel-500.xlsx', size: buffer.length, buffer }, jobId);
        const processing = runProcessHandler(pair.req, pair.res);
        let snapshot;
        for (let attempt = 0; attempt < 200; attempt++) {
            snapshot = (await runProgressHandler('get', jobId)).body;
            if (snapshot.completedBatches > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        assert.ok(snapshot.completedBatches > 0, 'a batch completes before cancellation');
        await runProgressHandler('delete', jobId);
        await processing;

        assert.equal(pair.getStatus(), 201, 'partial cancelled sheet is saved as review, not as completed');
        const doc = pair.getBody();
        assert.equal(doc.status, 'review');
        assert.equal(doc.extraction_metadata.processingStatus, 'cancelled');
        assert.equal(doc.items.length, 500, 'all canonical rows remain present');
        assert.ok(doc.items.filter((item) => successfulRowIds.has(item.lineItemId)).every((item) => item.product === 'Completed before cancellation'),
            'completed batch enrichment is preserved');
        assert.ok(doc.items.filter((item) => !successfulRowIds.has(item.lineItemId)).every((item) => item.warnings.some((warning) => /cancel/i.test(warning))),
            'uncompleted source rows are marked for review');
        assert.ok(callGroups.size <= Number(process.env.BOQ_AI_CONCURRENCY || 4),
            `no later wave starts after cancellation (${callGroups.size} batch calls began)`);
        assert.ok(peakActive <= Number(process.env.BOQ_AI_GLOBAL_CONCURRENCY || 8));
        assert.equal(activeCalls, 0, 'aborted provider calls release active semaphore slots');
        const finalProgress = (await runProgressHandler('get', jobId)).body;
        assert.equal(finalProgress.status, 'cancelled');
        assert.equal(finalProgress.documentId, doc.id);

        aiService._complete = original;
        const followupBuffer = await buildRealisticBoqXlsx(3);
        const followup = makeReqRes({ originalname: 'after-cancel.xlsx', size: followupBuffer.length, buffer: followupBuffer }, 'after-cancel-job');
        await runProcessHandler(followup.req, followup.res);
        assert.equal(followup.getStatus(), 201, 'a later job can acquire the released AI semaphore slot');
    } finally {
        aiService._complete = original;
    }
    console.log('✅ Test 11 passed\n');
}

// The route module exports the router; pull the /process handler out of
// the stack (mirrors how phase2-smoke.test.js drives route layers).
const processLayer = boqRoute.router.stack.find(
    (l) => l.route?.path === '/process' && l.route?.methods?.post
);
assert.ok(processLayer, 'POST /process route exists');

// Multer's upload.single('file') is the first layer; the async handler is
// the last. Call it with the mocked req/res.
async function runProcessHandler(req, res) {
    const handler = processLayer.route.stack[processLayer.route.stack.length - 1].handle;
    await handler(req, res);
}

async function main() {
    try {
        await test1_realisticBoqEndToEnd();
        await test2_chunkCapSurfaces413();
        await test3_aiFailureSurfacesClearError();
        await test4_timeoutSurfaces504WithRetryHint();
        await test5_perChunkBudgetDivision();
        await test6_sourceColumnsOverrideAiValues();
        await test7_nativePdfUsesVisualTableReconstruction();
        await test8_largeBoqBatchSixMalformedThenReviewFallback();
        await test9_globalConcurrencyAcrossUploads();
        await test10_progressSnapshotsForSuccessAndBatchFailure();
        await test11_cancellationStopsQueuePreservesRowsAndReleasesSlot();
        console.log('🎉 ALL BOQ REALISTIC-SIZE SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
