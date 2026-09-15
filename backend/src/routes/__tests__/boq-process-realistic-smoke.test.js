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

const boqExtractor = require('../../documents/boqExtractor');
const boqRoute = require('../../routes/boq');

// ── Stub the AI at the service boundary; record calls + latency ──
const aiCalls = [];
const aiService = require('../../ai/aiService');
aiService._complete = async (messages, options = {}) => {
    const start = Date.now();
    aiCalls.push({ options, start });
    // Simulate the provider latency so the logs show realistic timing.
    await new Promise((r) => setTimeout(r, 15));
    const promptText = messages[0].content;
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
function makeReqRes(file) {
    const req = { user: { id: USER_A }, file, body: {}, params: {} };
    let statusCode = null; let body = null;
    const res = {
        json: (data) => { body = data; return data; },
        status(code) { statusCode = code; return { json: (d) => { body = d; } }; },
    };
    return { req, res, getStatus: () => statusCode, getBody: () => body };
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
    console.log('▶ Test 1: 28-item BOQ processes end-to-end via chunked extraction');
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
    // The chunk-boundary overlap repeats ONE line by design (header
    // continuity), so the stub model emits it twice — ≥ 28 with every
    // item number covered. Real duplicates surface as review warnings.
    assert.ok(doc.items.length >= 28, `all rows extracted (got ${doc.items.length})`);
    for (let n = 1; n <= 28; n++) {
        assert.ok(doc.items.some((it) => Number(it.quantity) === 100 * n), `row ${n} present in extraction output`);
    }
    assert.strictEqual(aiCalls.length, boqExtractor.splitIntoChunks(
        await boqExtractor.extractText(buffer, '.xlsx')
    ).length, 'one AI call per chunk');
    assert.ok(aiCalls.every((c) => c.options.timeoutMs === Number(process.env.BOQ_AI_TIMEOUT_MS || 25000)), 'per-chunk AI timeout applied');
    assert.ok(aiCalls.every((c) => c.options.retries === 1), 'no retry stacking (fail fast per chunk)');
    console.log(`   → route wall time ${elapsed}ms, ${aiCalls.length} AI chunk call(s), ${doc.items.length} items extracted`);
    console.log('✅ Test 1 passed\n');
}

async function test2_chunkCapSurfaces413() {
    console.log('▶ Test 2: oversized document surfaces a clear 413 (not a hang/500)');
    aiCalls.length = 0; // reset counter shared with test 1
    // ~52k chars of pipe rows → far more chunks than the cap of 4 →
    // the route must reject BEFORE calling the AI (it used to accept
    // anything under 60k chars and then die silently in one giant call).
    const lines = ['Item | Description | Size | Specification | Quantity | Unit'];
    for (let i = 1; i <= 450; i++) {
        lines.push(`${i} | HDPE Pipe ${60 + (i % 6) * 25}mm | ${60 + (i % 6) * 25}mm | IS 4984:2016 PE100 PN10 | ${100 * i} | m`);
    }
    const text = lines.join('\n');
    assert.ok(text.length > 4 * 1500, `fixture sized to exceed the chunk cap (${text.length} chars)`);
    assert.ok(text.length <= 60000, 'fixture stays under the hard 60k reject so the CHUNK cap is what trips');

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
    console.log('▶ Test 3: chunk AI failure → clear attributed error, HTTP 502');
    const original = aiService._complete;
    aiService._complete = async () => { throw new Error('AI provider timed out after 25s.'); };
    try {
        const smallBuffer = await buildRealisticBoqXlsx(3);
        const { req, res, getStatus, getBody } = makeReqRes({
            originalname: 'boq-small.xlsx',
            size: smallBuffer.length,
            buffer: smallBuffer,
        });
        await runProcessHandler(req, res);
        assert.strictEqual(getStatus(), 502, `expected 502, got ${getStatus()}`);
        assert.ok(/Section 1 of 1.*could not be extracted/.test(getBody().error), `attributed error, got: ${getBody().error}`);
    } finally {
        aiService._complete = original;
    }
    console.log('✅ Test 3 passed\n');
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
        console.log('🎉 ALL BOQ REALISTIC-SIZE SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
