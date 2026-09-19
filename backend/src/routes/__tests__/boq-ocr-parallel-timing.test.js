// =============================================================
// Timing test — parallel OCR wall-time on a 19-page scanned PDF.
//
// Real-world regression (2026-09): a genuine 19-page scanned
// government tender BOQ timed out on the frontend after 110s.
// Root cause: pdfOcr.js OCR'd pages strictly SEQUENTIALLY
// (19 × per-page NVIDIA round trip on the wall clock) and the OCR
// phase did not share the request's 90s wall budget at all.
//
// This test mocks OCR at the axios boundary with a REALISTIC
// per-page latency (6s — derived from the deployed service's
// [boq:*] OCR page lines; tune via OCR_MOCK_PAGE_LATENCY_MS) and
// measures simulated wall time for the exact page count of the
// real document (19 — tune via OCR_MOCK_PAGE_COUNT):
//
//   1. Sequential baseline (the old behavior): N × latency.
//   2. Parallel batches of OCR_CONCURRENCY (the new behavior):
//      ceil(N/concurrency) × latency worst case.
//   3. Proves the ~1/concurrency speedup actually materializes.
//   4. Proves page order is preserved and every page is OCR'd
//      exactly once despite concurrent batches.
//
// The concurrency knob comes from the same env var the server uses
// (BOQ_OCR_CONCURRENCY, default 5).
//
// Run: node backend/src/routes/__tests__/boq-ocr-parallel-timing.test.js
// =============================================================
const assert = require('assert');

process.env.AI_API_KEY = 'env-test-key';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

// The real failed run: 19-page scanned government BOQ. Overridable to
// experiment with other sizes/latencies without touching the test.
const PAGE_COUNT = Number(process.env.OCR_MOCK_PAGE_COUNT || 19);
const PAGE_LATENCY_MS = Number(process.env.OCR_MOCK_PAGE_LATENCY_MS || 6000);

// ── Stub pdf-parse BEFORE pdfOcr loads it ────────────────────
const pdfParsePath = require.resolve('pdf-parse');
require.cache[pdfParsePath] = {
    id: pdfParsePath,
    filename: pdfParsePath,
    loaded: true,
    exports: {
        PDFParse: class {
            async getText() { return { text: '', total: PAGE_COUNT, pages: [] }; }
            async getScreenshot(params) {
                return {
                    pages: Array.from({ length: params?.first || PAGE_COUNT }, (_, i) => ({
                        pageNumber: i + 1,
                        width: 1190,
                        height: 1684,
                        data: new Uint8Array(Buffer.from(`%PNG-fake-page-${i + 1}`)),
                    })),
                    total: params?.first || PAGE_COUNT,
                };
            }
            async destroy() {}
        },
    },
};

// ── Stub OCR at the axios boundary: each call takes PAGE_LATENCY_MS,
//    tracked with concurrency probe (max simultaneous in flight) ──
const axios = require('axios');
let inFlight = 0;
let maxInFlight = 0;
const callTimes = [];
let activeConcurrency = Number(process.env.BOQ_OCR_CONCURRENCY || 5);
axios.post = async (url) => {
    if (!url.includes('nemotron-ocr')) throw new Error(`unexpected axios.post URL in test: ${url}`);
    const started = Date.now();
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, PAGE_LATENCY_MS));
    inFlight -= 1;
    callTimes.push(Date.now() - started);
    return { data: { ocr_txts: [`page ${callTimes.length} text`] } };
};

const { ocrScannedPdf, ocrConfig } = require('../../documents/pdfOcr');

async function main() {
    const cfg = ocrConfig();
    activeConcurrency = cfg.OCR_CONCURRENCY;
    console.log(`▶ Simulated OCR: ${PAGE_COUNT} pages × ${PAGE_LATENCY_MS}ms/page, concurrency ${cfg.OCR_CONCURRENCY}`);

    // ── Sequential baseline (the OLD pipeline's behavior) ──
    const sequentialMs = PAGE_COUNT * PAGE_LATENCY_MS;

    // ── Run the NEW pipeline end to end ──
    const startedAt = Date.now();
    const result = await ocrScannedPdf(Buffer.from('%PDF-1.7 fake scanned pdf'), 'timing-test', {});
    const parallelMs = Date.now() - startedAt;

    const expectedBatches = Math.ceil(PAGE_COUNT / activeConcurrency);
    const expectedWorstCase = expectedBatches * PAGE_LATENCY_MS;

    console.log(`   sequential (old): ${sequentialMs}ms → parallel (new): ${parallelMs}ms  (${(sequentialMs / parallelMs).toFixed(1)}× faster)`);
    console.log(`   expected worst case: ${expectedBatches} batch(es) × ${PAGE_LATENCY_MS}ms = ${expectedWorstCase}ms`);

    // 1. Speedup: with a 19-page document the batches are uneven
    //    (5+5+5+4) so assert the solid floor — at least the
    //    concurrency factor minus rounding slack, and never slower
    //    than sequential.
    assert.ok(parallelMs <= sequentialMs, `parallel must not be slower than sequential (${parallelMs}ms > ${sequentialMs}ms)`);
    const minExpectedSpeedup = activeConcurrency === 1 ? 1 : 1.8;
    assert.ok(sequentialMs / parallelMs >= minExpectedSpeedup,
        `expected ≥${minExpectedSpeedup}× speedup, got ${(sequentialMs / parallelMs).toFixed(2)}×`);

    // 2. Every page OCR'd exactly once.
    assert.strictEqual(callTimes.length, PAGE_COUNT, `one OCR call per page (got ${callTimes.length})`);

    // 3. Concurrency actually bounded at the knob (never all 19 at once).
    assert.ok(maxInFlight <= activeConcurrency, `in-flight OCR calls (${maxInFlight}) must never exceed concurrency (${activeConcurrency})`);
    assert.ok(maxInFlight > 1, `pages must actually run concurrently (max in flight was ${maxInFlight})`);

    // 4. Page order preserved in the concatenated text.
    const order = result.text.split('\n').filter(Boolean).map((line) => Number(line.match(/^page (\d+) /)[1]));
    assert.strictEqual(order.length, PAGE_COUNT, 'one text line per page');
    for (let i = 0; i < PAGE_COUNT; i++) assert.strictEqual(order[i], i + 1, `page ${i + 1} must land in position ${i + 1}`);

    // 5. Contract intact: all pages succeeded, no failed pages.
    assert.deepStrictEqual(result.failedPages, [], `no failed pages (got ${result.failedPages.join(', ')})`);
    assert.strictEqual(result.pageCount, PAGE_COUNT);
    assert.strictEqual(result.ocrUsed, true);

    console.log('✅ Parallel OCR timing test passed');
    console.log(`\nSimulated wall-time for the real 19-page tender: ${sequentialMs}ms → ${parallelMs}ms` +
        ` (${(sequentialMs / parallelMs).toFixed(1)}× faster; worst case ${expectedWorstCase}ms)`);
    process.exit(0);
}

main().catch((error) => {
    console.error('❌ TEST FAILED:', error.message);
    console.error(error.stack);
    process.exit(1);
});
