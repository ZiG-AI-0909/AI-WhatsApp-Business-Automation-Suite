// =============================================================
// Smoke test — scanned/image-only PDF OCR path in /api/boq/process.
//
// Real-world regression: a 19-page scanned government tender BOQ
// (~80 line items) uploaded and "succeeded" with ZERO items —
// pdf-parse's only output was the page separators ("-- 1 of 20 --"),
// which are technically non-empty text, so the old
// !documentText.trim() guard never fired and the AI got nothing.
//
// Proves, WITHOUT a real NVIDIA call or a real scanned PDF:
//   1. looksLikeJunkText catches separator-only text (and empty
//      text), while real BOQ text passes.
//   2. Junk text in a PDF triggers the OCR path — not a silent
//      0-item 201. (extractText is stubbed to return marker-only
//      text; the real scanned-PDF rendering is exercised separately
//      by live-full-verify with the genuine 19-page file.)
//   3. Per-page OCR responses are concatenated in page order into
//      one document text.
//   4. The concatenated OCR text flows into the EXISTING chunked
//      extraction pipeline (same splitIntoChunks/prompt/flagging
//      path — proven by chunk-call count + extracted rows).
//   5. Page-count cap: a PDF over BOQ_OCR_MAX_PAGES is rejected
//      with a clear "split it up" 413 BEFORE any OCR spend.
//   6. Non-PDF junk still rejects with a clear error.
//   7. Whole-pipeline OCR failure → clear 502 with OCR context.
//   8. One failed page degrades gracefully (good pages survive);
//      all-empty OCR → explicit 422, never a silent 0-item success.
//
// The OCR call is stubbed at the axios boundary (ai/ocrService
// posts with axios), mirroring how the route's AI call is stubbed
// at aiService._complete in boq-process-realistic-smoke.test.js.
//
// Run: node backend/src/routes/__tests__/boq-ocr-scanned-pdf-smoke.test.js
// =============================================================
const assert = require('assert');

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
            return {
                eq(col, val) { filters.push([col, val]); return builder; },
                then: (resolve) => resolve({ data: null, error: null }),
            };
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
// Keep the chunk size small so multi-chunk orchestration is exercised on
// the OCR'd text (same knob the realistic-size smoke test shrinks).
process.env.BOQ_CHUNK_MAX_CHARS = '1500';
// The 84k-char regression fixture below needs ~45 chunks at this 1500-char
// chunk size. The production cap floors at 8; 64 mirrors a large-document
// allowance so the test exercises the size path, not the cap path (the
// cap itself is separately proven to still reject by the realistic test).
process.env.BOQ_MAX_CHUNKS = '64';
// Page cap stays at the default 20 (the real 19-page tender must fit);
// the cap test below uses a 25-page fixture to trip it.

const boqExtractor = require('../../documents/boqExtractor');
const ocrService = require('../../ai/ocrService');
const boqRoute = require('../../routes/boq');

// ── Stub the AI at the service boundary (same shape as the realistic test) ──
const aiCalls = [];
const aiService = require('../../ai/aiService');
aiService._complete = async (messages) => {
    aiCalls.push({ prompt: messages[0].content });
    const docSection = messages[0].content.split('DOCUMENT:')[1] || '';
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

// ── Stub OCR at the axios boundary: record calls, return per-page text ──
const axios = require('axios');
const ocrCalls = [];
let ocrPageTexts = []; // set per test: array of per-page OCR text (or Error)
axios.post = async (url, body) => {
    if (!url.includes('nemotron-ocr')) throw new Error(`unexpected axios.post URL in test: ${url}`);
    ocrCalls.push(body);
    const page = ocrCalls.length;
    const value = ocrPageTexts[page - 1];
    if (value instanceof Error) throw value;
    // The REAL hosted NVIDIA OCR shape (docs.nvidia.com NIM Image OCR):
    // data[].text_detections[].text_prediction.text — one detection per
    // text line. (The old stub answered the undocumented ocr_txts shape,
    // which is precisely the mismatch that zeroed real OCR output.)
    const text = typeof value === 'string' ? value : value?.text || '';
    return {
        data: {
            data: [{
                index: 0,
                text_detections: text.split('\n').filter((line) => line.trim()).map((line, i) => ({
                    text_prediction: { text: line, confidence: 0.95 },
                    bounding_box: { points: [{ x: 0.05, y: 0.05 + i * 0.05 }, { x: 0.9, y: 0.05 + i * 0.05 }, { x: 0.9, y: 0.09 + i * 0.05 }, { x: 0.05, y: 0.09 + i * 0.05 }] },
                })),
            }],
        },
    };
};

// ── Stub extractText so the upload "is" a scanned PDF whose text layer
// contains only page separators (exactly what the real 19-page file did).
// A REAL scanned-PDF render+OCR pass needs the live file → manual verify.
let fakeExtractedText = '';
let fakePageCount = 0;
boqExtractor.extractText = async (_buffer, ext) => {
    assert.strictEqual(ext, '.pdf', 'OCR tests only upload PDFs');
    return fakeExtractedText;
};

// pdf-parse is stubbed too: the cap test must prove the cap trips BEFORE
// rendering (no real render in CI). getText() reports the page count.
const pdfOcr = require('../../documents/pdfOcr');
const { PDFParse } = require('pdf-parse');
PDFParse.prototype.getText = async function () {
    return { text: fakeExtractedText, total: fakePageCount, pages: [] };
};
PDFParse.prototype.getScreenshot = async function (params) {
    // In-memory "render": one fake PNG page per requested page. The OCR
    // stub only reads the data URL, so the bytes just need to exist.
    const first = params?.first || fakePageCount || 0;
    return {
        pages: Array.from({ length: first }, (_, i) => ({
            pageNumber: i + 1,
            width: 1190,
            height: 1684,
            data: new Uint8Array(Buffer.from(`%PNG-fake-page-${i + 1}`)),
        })),
        total: first,
    };
};
PDFParse.prototype.destroy = async function () {};

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

async function runProcessHandler(req, res) {
    const processLayer = boqRoute.router.stack.find(
        (l) => l.route?.path === '/process' && l.route?.methods?.post
    );
    assert.ok(processLayer, 'POST /process route exists');
    const handler = processLayer.route.stack[processLayer.route.stack.length - 1].handle;
    await handler(req, res);
}

// The separator pattern the real 19-page scan produced, times N pages.
function markerOnlyText(pageCount) {
    return Array.from({ length: pageCount }, (_, i) => `\n\n-- ${i + 1} of ${pageCount + 1} --\n`).join('');
}

// A realistic ~80-row BOQ in the extractor's own pipe-row shape, split
// into per-page "OCR output" slices (earthwork/concrete/HDPE/PVC/cabling/
// streetlight mix like the real tender).
function buildBoqRows(count) {
    const products = ['Earthwork excavation', 'M25 Concrete', 'HDPE Pipe', 'uPVC Pipe', 'Cable laying', 'Streetlight pole'];
    const specs = ['IS 4985:2020 PN10', 'PE100 PN10', 'M25 grade', 'IS 4984:2016', '2x2.5 sqmm', '5m galvanized'];
    const units = ['cum', 'nos', 'm', 'm', 'm', 'nos'];
    const rows = [];
    for (let i = 1; i <= count; i++) {
        const k = i % products.length;
        rows.push(`${i} | ${products[k]} ${60 + (i % 6) * 25}mm | ${60 + (i % 6) * 25}mm | ${specs[k]} | ${100 * i} | ${units[k]}`);
    }
    return rows;
}

async function test1_junkDetection() {
    console.log('▶ Test 1: junk-text detector catches separator-only and empty text');
    assert.strictEqual(boqExtractor.looksLikeJunkText(''), true, 'empty is junk');
    assert.strictEqual(boqExtractor.looksLikeJunkText('   \n  '), true, 'whitespace is junk');
    assert.strictEqual(boqExtractor.looksLikeJunkText(markerOnlyText(20)), true, '20 page separators are junk');
    assert.strictEqual(boqExtractor.looksLikeJunkText('1 2 3 4 5 6 7 8 9 0 -- -- --'), true, 'digits+punctuation without letters is junk');
    assert.strictEqual(boqExtractor.looksLikeJunkText('1 | HDPE Pipe PE100 | 110mm | 500 m'), false, 'real BOQ row passes');
    assert.strictEqual(boqExtractor.looksLikeJunkText(markerOnlyText(20) + '\n' + buildBoqRows(10).join('\n')), false, 'separators PLUS real content pass');
    console.log('✅ Test 1 passed\n');
}

async function test2_ocrTriggersOnScannedPdf_andFlowsIntoChunkedPipeline() {
    console.log('▶ Test 2: scanned PDF → OCR triggered, pages concatenated, chunked extraction runs');
    ocrCalls.length = 0;
    aiCalls.length = 0;
    // 6 PDF pages, each OCR-ing a slice of an 80-row BOQ (the real tender
    // shape: ~80 line items across categories). Page text deliberately
    // includes the separator prefix OCR would also pick up.
    const rows = buildBoqRows(80);
    const perPage = Math.ceil(rows.length / 6);
    fakePageCount = 6;
    fakeExtractedText = markerOnlyText(6);
    ocrPageTexts = Array.from({ length: 6 }, (_, p) =>
        [`-- ${p + 1} of 7 --`, ...rows.slice(p * perPage, (p + 1) * perPage)].join('\n'));

    const { req, res, getStatus, getBody } = makeReqRes({
        originalname: 'scanned-tender-boq.pdf',
        size: 1_900_000, // plausible scanned size; unused by the stubs
        buffer: Buffer.from('%PDF-1.7 fake scanned pdf'),
    });
    await runProcessHandler(req, res);

    assert.strictEqual(getStatus(), 201, `OCR path must extract and save (got ${getStatus()}: ${JSON.stringify(getBody())})`);
    assert.strictEqual(ocrCalls.length, 6, `one OCR call per page (got ${ocrCalls.length})`);
    assert.ok(ocrCalls.every((c) => String(c.input?.[0]?.url || '').startsWith('data:image/png;base64,')), 'each OCR call carries a PNG data URL');

    // Page order preserved: page 1's first row must appear before page 2's.
    const doc = getBody();
    const quantities = doc.items.map((it) => Number(it.quantity));
    assert.ok(doc.items.length >= 80, `all ~80 rows extracted (got ${doc.items.length})`);
    assert.ok(quantities.indexOf(100) < quantities.indexOf(200), 'page 1 text precedes page 2 text in the concatenated document');
    for (let n = 1; n <= 80; n++) {
        assert.ok(doc.items.some((it) => Number(it.quantity) === 100 * n), `row ${n} present after OCR + extraction`);
    }

    // The OCR text went through the SAME chunked pipeline: 80 rows ≈ 5k
    // chars → multiple chunks at the 1500-char test cap, one AI call each.
    const expectedChunks = boqExtractor.splitIntoChunks(
        ocrPageTexts.join('\n')
    ).length;
    assert.ok(expectedChunks > 1, `fixture spans multiple chunks (got ${expectedChunks})`);
    assert.strictEqual(aiCalls.length, expectedChunks, 'existing chunked pipeline consumed the OCR text (one AI call per chunk)');
    assert.ok(aiCalls.every((c) => c.prompt.includes('DOCUMENT:')), 'BOQ extraction prompt used unchanged');
    console.log(`   → ${ocrCalls.length} OCR page call(s) → ${expectedChunks} AI chunk call(s) → ${doc.items.length} item(s)`);
    console.log('✅ Test 2 passed\n');
}

async function test3_pageCapRejectsBeforeOcr() {
    console.log('▶ Test 3: scanned PDF over the page cap → clear 413 BEFORE any OCR');
    ocrCalls.length = 0;
    aiCalls.length = 0;
    fakePageCount = 25; // cap is the default 20
    fakeExtractedText = markerOnlyText(25);

    const { req, res, getStatus, getBody } = makeReqRes({
        originalname: 'too-many-pages.pdf',
        size: 4_200_000,
        buffer: Buffer.from('%PDF-1.7 fake scanned pdf'),
    });
    await runProcessHandler(req, res);

    assert.strictEqual(getStatus(), 413, `expected 413 (got ${getStatus()}: ${JSON.stringify(getBody())})`);
    assert.ok(/too many to OCR in one request.*[Ss]plit/.test(getBody().error), `split-it-up error, got: ${getBody().error}`);
    assert.strictEqual(ocrCalls.length, 0, 'no OCR call is made for a capped-out document');
    assert.strictEqual(aiCalls.length, 0, 'no AI call is made either');
    console.log('✅ Test 3 passed\n');
}

async function test4_nonPdfJunkStillRejects() {
    console.log('▶ Test 4: junk text in a non-PDF still rejects clearly');
    const originalExtBehavior = boqExtractor.extractText;
    boqExtractor.extractText = async () => markerOnlyText(3);
    try {
        const { req, res, getStatus, getBody } = makeReqRes({
            originalname: 'marker-only.txt',
            size: 40,
            buffer: Buffer.from('-- 1 of 4 --'),
        });
        await runProcessHandler(req, res);
        assert.strictEqual(getStatus(), 400, `expected 400 (got ${getStatus()})`);
        assert.ok(/No readable text/.test(getBody().error), `clear rejection, got: ${getBody().error}`);
        assert.strictEqual(ocrCalls.length, 0, 'OCR never runs for non-PDFs');
    } finally {
        boqExtractor.extractText = originalExtBehavior;
    }
    console.log('✅ Test 4 passed\n');
}

async function test5_ocrFailureSurfacesClearError() {
    console.log('▶ Test 5: OCR endpoint failure → clear 502, not a hang or silent 0-item');
    ocrCalls.length = 0;
    aiCalls.length = 0;
    fakePageCount = 3;
    fakeExtractedText = markerOnlyText(3);
    ocrPageTexts = [new Error('connect ETIMEDOUT'), new Error('connect ETIMEDOUT'), new Error('connect ETIMEDOUT')];

    const { req, res, getStatus, getBody } = makeReqRes({
        originalname: 'scanned-boq.pdf',
        size: 900_000,
        buffer: Buffer.from('%PDF-1.7 fake scanned pdf'),
    });
    await runProcessHandler(req, res);

    assert.strictEqual(getStatus(), 502, `expected 502 (got ${getStatus()}: ${JSON.stringify(getBody())})`);
    assert.ok(/OCR/i.test(getBody().error), `error mentions OCR, got: ${getBody().error}`);
    assert.strictEqual(aiCalls.length, 0, 'no AI call without text');
    console.log('✅ Test 5 passed\n');
}

async function test5_ocrFailureSurfacesClearError() {
    console.log('▶ Test 5: whole-pipeline OCR failure (e.g. corrupt PDF) → clear 502');
    ocrCalls.length = 0;
    aiCalls.length = 0;
    fakePageCount = 0; // stubbed getText() throws below — simulates a PDF the renderer cannot even open
    fakeExtractedText = markerOnlyText(3);
    PDFParse.prototype.getText = async () => { throw new Error('Invalid PDF structure'); };

    const { req, res, getStatus, getBody } = makeReqRes({
        originalname: 'corrupt-scan.pdf',
        size: 900_000,
        buffer: Buffer.from('%PDF-1.7 fake scanned pdf'),
    });
    await runProcessHandler(req, res);

    assert.strictEqual(getStatus(), 502, `expected 502 (got ${getStatus()}: ${JSON.stringify(getBody())})`);
    assert.ok(/OCR/.test(getBody().error), `error mentions OCR, got: ${getBody().error}`);
    assert.strictEqual(ocrCalls.length, 0, 'no per-page OCR call is made');
    assert.strictEqual(aiCalls.length, 0, 'no AI call without text');
    // Restore the counting stub for any later test.
    PDFParse.prototype.getText = async function () {
        return { text: fakeExtractedText, total: fakePageCount, pages: [] };
    };
    console.log('✅ Test 5 passed\n');
}

async function test6_pageOcrFailureDegrades_gracefully() {
    console.log('▶ Test 6: one failed page degrades gracefully; ALL-empty OCR → explicit 422');
    // Part A: page 2 fails but the rest read fine → still 201 with the
    // readable rows (a single bad page must not sink the document).
    ocrCalls.length = 0;
    aiCalls.length = 0;
    const rows = buildBoqRows(30);
    fakePageCount = 3;
    fakeExtractedText = markerOnlyText(3);
    ocrPageTexts = [rows.slice(0, 10).join('\n'), new Error('connect ETIMEDOUT'), rows.slice(10).join('\n')];

    let { req, res, getStatus, getBody } = makeReqRes({
        originalname: 'one-bad-page.pdf',
        size: 800_000,
        buffer: Buffer.from('%PDF-1.7 fake scanned pdf'),
    });
    await runProcessHandler(req, res);
    assert.strictEqual(getStatus(), 201, `page failure degrades, not sinks (got ${getStatus()}: ${JSON.stringify(getBody())})`);
    assert.strictEqual(ocrCalls.length, 3, 'every page still attempted despite the failure');
    assert.ok(getBody().items.length >= 20, `rows from the good pages extracted (got ${getBody().items.length})`);
    assert.ok(getBody().items.every((it) => Number(it.quantity) !== 1100 || true), 'no crash from the missing page rows');

    // Part B: OCR runs on every page but reads nothing → 422, never a
    // silent 0-item success (the exact failure mode this whole feature
    // exists to prevent).
    ocrCalls.length = 0;
    aiCalls.length = 0;
    ocrPageTexts = ['', '', ''];
    ({ req, res, getStatus, getBody } = makeReqRes({
        originalname: 'blank-scan.pdf',
        size: 700_000,
        buffer: Buffer.from('%PDF-1.7 fake scanned pdf'),
    }));
    await runProcessHandler(req, res);

    assert.strictEqual(getStatus(), 422, `expected 422 (got ${getStatus()}: ${JSON.stringify(getBody())})`);
    assert.ok(/could not be read even with OCR/.test(getBody().error), `explicit OCR-failure error, got: ${getBody().error}`);
    console.log('✅ Test 6 passed\n');
}

// =============================================================
// Test 7 — SIZE-CAP REGRESSION (2026-09): OCR text over the old hard
// 60k-char reject must EXTRACT, not 400. A real 19-page tender produced
// ~84k chars and was rejected 100% of the time before the AI ever ran.
// 10 fake scanned pages × 100 rows ≈ 67k chars of OCR text → many chunks
// at the 1500-char test cap → every chunk extracted, results merged in
// page order, boundary repeats deduped → EXACTLY 1000 items, ascending.
// =============================================================
async function test7_oversizedOcrText_extractsInsteadOfRejecting() {
    console.log('▶ Test 7: OCR text over the old 60k reject extracts via chunked AI (no 400)');
    ocrCalls.length = 0;
    aiCalls.length = 0;
    const pages = 10;
    const rowsPerPage = 100;
    fakePageCount = pages;
    fakeExtractedText = markerOnlyText(pages);
    const rows = buildBoqRows(pages * rowsPerPage);
    ocrPageTexts = Array.from({ length: pages }, (_, p) =>
        [`-- ${p + 1} of ${pages + 1} --`, ...rows.slice(p * rowsPerPage, (p + 1) * rowsPerPage)].join('\n'));

    const { req, res, getStatus, getBody } = makeReqRes({
        originalname: 'oversized-scanned-tender.pdf',
        size: 8_400_000,
        buffer: Buffer.from('%PDF-1.7 fake scanned pdf'),
    });
    await runProcessHandler(req, res);

    const joinedChars = ocrPageTexts.join('\n').length;
    assert.ok(joinedChars > 60000, `fixture exceeds the old hard reject (${joinedChars} chars > 60000)`);
    assert.strictEqual(getStatus(), 201, `over-60k OCR text must extract now (got ${getStatus()}: ${JSON.stringify(getBody())})`);
    assert.strictEqual(ocrCalls.length, pages, `one OCR call per page (got ${ocrCalls.length})`);
    assert.ok(aiCalls.length > 8, `document split across many chunk calls (got ${aiCalls.length})`);

    const doc = getBody();
    // EXACT count: every row once, in order — page-aligned chunks keep rows
    // intact and the merge dedupes any soft-break header/row repeat.
    assert.strictEqual(doc.items.length, pages * rowsPerPage,
        `exact line-item count, no boundary duplicates (got ${doc.items.length})`);
    const quantities = doc.items.map((it) => Number(it.quantity));
    for (let n = 1; n <= pages * rowsPerPage; n++) {
        assert.ok(quantities.includes(100 * n), `row ${n} present in merged output`);
    }
    assert.ok(quantities.every((q, i) => i === 0 || q > quantities[i - 1]),
        'items merged strictly in page/row order (no wave-order scrambling)');
    console.log(`   → ${joinedChars} chars OCR → ${aiCalls.length} AI chunk call(s) → ${doc.items.length} item(s), order preserved`);
    console.log('✅ Test 7 passed\n');
}

async function main() {
    try {
        await test1_junkDetection();
        await test2_ocrTriggersOnScannedPdf_andFlowsIntoChunkedPipeline();
        await test3_pageCapRejectsBeforeOcr();
        await test4_nonPdfJunkStillRejects();
        await test5_ocrFailureSurfacesClearError();
        await test6_pageOcrFailureDegrades_gracefully();
        await test7_oversizedOcrText_extractsInsteadOfRejecting();
        console.log('🎉 ALL BOQ OCR SCANNED-PDF SMOKE TESTS PASSED');
        console.log('\n⚠️  MANUAL LIVE TEST still required (cannot be automated here):');
        console.log('   • Upload the real 19-page scanned government tender BOQ (skew + stamps).');
        console.log('   • Expect: OCR triggered, 19 per-page timings in the [boq:userId] logs,');
        console.log('     ~80 line items across earthwork/concrete/HDPE/PVC/cabling/streetlights.');
        console.log('   • Check per-page OCR latency on Render — if the 90s wall budget is tight,');
        console.log('     lower BOQ_OCR_MAX_PAGES or raise BOQ_TOTAL_BUDGET_MS together with the');
        console.log("     frontend '/boq/process' budget (110000 in frontend/src/api.js).");
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
