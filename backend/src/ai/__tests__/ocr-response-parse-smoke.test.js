// =============================================================
// Smoke test — NVIDIA OCR response parsing + parallel page isolation.
//
// Real-world regression (2026-09): a 19-page scanned tender OCR'd on
// Render to 0 chars on ALL 20 pages, every page "ok", zero errors.
// Root-cause trace (per-page PNG checksums + raw NVIDIA response
// capture) showed:
//   • every parallel worker sent a DISTINCT, valid PNG (unique md5s) —
//     the parallelization batching in pdfOcr.js was NOT the bug;
//   • NVIDIA returned a fully successful, text-filled response of the
//     documented shape data[].text_detections[].text_prediction.text;
//   • ocrService.js parsed a NONEXISTENT top-level "ocr_txts" field and
//     silently returned '' — so a perfect OCR response became "ok (0
//     chars)" on every page.
// This file pins BOTH halves so neither can regress:
//   1. Real documented NVIDIA shape parses to the recognized text,
//      ordered by bounding box (top edge, then left edge) — table/BOQ
//      rows must come out in visual reading order even when NVIDIA
//      returns detections shuffled.
//   2. An HTTP-200 response with an UNRECOGNIZED shape never parses to
//      a quiet '' — it warns loudly (and still returns '').
//   3. Legacy shapes (ocr_txts / texts / extracted_text) still parse.
//   4. N parallel OCR calls (pdfOcr's batch of 5) each carry genuinely
//      DISTINCT image bytes — a closure/loop-variable bug that sends
//      the same buffer to every worker fails here.
//   5. A 7-page document assembles all pages in order from concurrent
//      batches (7 > one batch of 5), with the fix's parser in the loop.
// Run: node src/ai/__tests__/ocr-response-parse-smoke.test.js
// =============================================================
const assert = require('assert');

process.env.AI_API_KEY = 'env-test-key';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const axios = require('axios');
const { ocrImage } = require('../ocrService');

// The real hosted response from the live trace (trimmed): detections
// for a rendered scanned page. "Page 2 of 3" sits BELOW the title but
// is listed FIRST here — reading order is not contractual, so the
// parser must sort by bounding box, not trust array order.
function realShapeResponse(detections) {
    return {
        data: [{
            index: 0,
            text_detections: detections.map(([text, x, y, w, h, confidence]) => ({
                text_prediction: { text, confidence },
                bounding_box: { points: [
                    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
                ] },
            })),
        }],
        usage: { images_size_mb: 0.25 },
    };
}

// Line-oriented fake OCR: the stub decodes the sent buffer, reads the
// marker line after the PNG signature ("%PNG-page-N:<text>"), and
// answers with the REAL documented NVIDIA response shape for that
// page's text.
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function fakePagePng(pageNumber, text) {
    const marker = Buffer.from(`%PNG-page-${pageNumber}:${text}`, 'utf8');
    return Buffer.concat([pngSignature, marker]);
}
// The raw marker bytes carried after the PNG signature (binary-safe:
// the signature itself contains control bytes, so never head-slice it).
function pageMarker(pngBuffer) {
    return pngBuffer.subarray(pngSignature.length).toString('utf8');
}
function nvidiaResponseFor(pngBuffer) {
    const marker = pageMarker(pngBuffer);
    const text = marker.split(':').slice(1).join(':');
    const lines = text.split('|');
    return realShapeResponse(lines.map((line, i) => [line, 0.05, 0.05 + i * 0.06, 0.6, 0.03, 0.95]));
}

let ocrCalls = []; // { url, imageBytes, imageMd5Head, body }

async function test1_realShapeParses_inReadingOrder() {
    console.log('▶ Test 1: documented NVIDIA shape parses; bounding-box sort restores reading order');
    // Deliberately SHUFFLED detections: "Page 2 of 3" (y≈0.031) before the
    // title (y≈0.0306) and table rows out of order — array order ≠ visual order.
    const res = { data: { data: [realShapeResponse([
        ['Page 2 of 3', 0.37, 0.031, 0.15, 0.02, 0.94],
        ['7 Earthwork Excavation Hard soil 250 cum', 0.05, 0.62, 0.7, 0.03, 0.93],
        ['BILL OF QUANTITIES', 0.05, 0.0306, 0.28, 0.016, 0.95],
        ['2 HDPE Pipe 110mm 800 m', 0.05, 0.32, 0.7, 0.03, 0.94],
        ['1 uPVC Column Pipe 63mm 1200 m', 0.05, 0.24, 0.7, 0.03, 0.95],
    ]).data[0] ] } };
    const originalPost = axios.post;
    axios.post = async () => res;
    try {
        const text = await ocrImage(fakePagePng(1, 'ignored'), { logLabel: 'test1' });
        const lines = text.split('\n');
        assert.strictEqual(lines.length, 5, `one line per detection (got ${lines.length}: ${JSON.stringify(lines)})`);
        assert.strictEqual(lines[0], 'BILL OF QUANTITIES', 'top-most line first');
        assert.strictEqual(lines[1], 'Page 2 of 3', 'second line by y');
        assert.ok(lines[2].startsWith('1 uPVC'), 'table row 1 above row 2');
        assert.ok(lines[3].startsWith('2 HDPE'), 'table row 2 above row 7');
        assert.ok(lines[4].startsWith('7 Earthwork'), 'bottom row last');
    } finally {
        axios.post = originalPost;
    }
    console.log('✅ Test 1 passed\n');
}

async function test2_unrecognizedShape_neverSilent() {
    console.log('▶ Test 2: HTTP-200 with an unrecognized shape warns loudly instead of a quiet \'\'');
    const originalPost = axios.post;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    axios.post = async () => ({ data: { completions: ['nonsense shape'] } });
    try {
        const text = await ocrImage(fakePagePng(1, 'x'), { logLabel: 'test2' });
        assert.strictEqual(text, '');
        assert.ok(warnings.some((w) => w.includes('unrecognized NVIDIA OCR response shape') && w.includes('completions')),
            `loud warning fired with the response's top-level keys (got: ${JSON.stringify(warnings)})`);
    } finally {
        console.warn = originalWarn;
        axios.post = originalPost;
    }
    console.log('✅ Test 2 passed\n');
}

async function test3_legacyShapesStillParse() {
    console.log('▶ Test 3: legacy ocr_txts/texts/extracted_text shapes still parse');
    const originalPost = axios.post;
    const cases = [
        [{ ocr_txts: ['legacy a', 'legacy b'] }, 'legacy a\nlegacy b'],
        [{ texts: ['legacy c'] }, 'legacy c'],
        [{ extracted_text: 'legacy d' }, 'legacy d'],
        [{ text: 'legacy e' }, 'legacy e'],
    ];
    try {
        for (const [data, expected] of cases) {
            axios.post = async () => ({ data });
            const text = await ocrImage(fakePagePng(1, 'x'), { logLabel: 'test3' });
            assert.strictEqual(text, expected, `shape ${JSON.stringify(Object.keys(data))} → ${JSON.stringify(expected)}`);
        }
    } finally {
        axios.post = originalPost;
    }
    console.log('✅ Test 3 passed\n');
}

async function test4_parallelWorkers_sendDistinctImages() {
    console.log('▶ Test 4: 5 parallel OCR calls (pdfOcr batch) each send DISTINCT image bytes');
    ocrCalls = [];
    const originalPost = axios.post;
    axios.post = async (url, body) => {
        const dataUrl = body?.input?.[0]?.url || '';
        assert.ok(dataUrl.startsWith('data:image/png;base64,'), 'PNG data URL sent');
        const img = Buffer.from(dataUrl.split(',')[1], 'base64');
        ocrCalls.push({ url, imageBytes: img.length, marker: pageMarker(img) });
        await new Promise((r) => setTimeout(r, 5));
        return { data: nvidiaResponseFor(img) };
    };
    try {
        // 5 distinct pages fired CONCURRENTLY, exactly like one pdfOcr batch.
        const pages = Array.from({ length: 5 }, (_, i) => fakePagePng(i + 1, `row-${i + 1}-a|row-${i + 1}-b`));
        const texts = await Promise.all(pages.map((p) => ocrImage(p, { logLabel: 'test4' })));
        assert.strictEqual(ocrCalls.length, 5, 'one HTTP call per page');
        const markers = new Set(ocrCalls.map((c) => c.marker));
        assert.strictEqual(markers.size, 5,
            `every worker must send DIFFERENT bytes (got ${markers.size} distinct payloads for 5 pages — same-value bug!)`);
        markers.forEach((marker) => assert.ok(/^%PNG-page-\d+:/.test(marker),
            `payload is the page PNG, not garbage (marker=${marker})`));
        texts.forEach((t, i) => assert.ok(
            t.includes(`row-${i + 1}-a`) && t.includes(`row-${i + 1}-b`),
            `page ${i + 1}'s OCR text matches ITS OWN image (got: ${JSON.stringify(t)})`));
    } finally {
        axios.post = originalPost;
    }
    console.log('✅ Test 4 passed\n');
}

async function test5_multipageDocument_assemblesInOrder() {
    console.log('▶ Test 5: 7-page document (2 concurrent batches) assembles every page in order');
    ocrCalls = [];
    const originalPost = axios.post;
    axios.post = async (url, body) => {
        const img = Buffer.from(body.input[0].url.split(',')[1], 'base64');
        ocrCalls.push(pageMarker(img));
        await new Promise((r) => setTimeout(r, 5));
        return { data: nvidiaResponseFor(img) };
    };
    try {
        // Drive ocrImage the way pdfOcr's batched Promise.all does.
        const pageCount = 7;
        const concurrency = 5;
        const pageTexts = new Array(pageCount).fill('');
        for (let start = 0; start < pageCount; start += concurrency) {
            const batch = Array.from({ length: Math.min(concurrency, pageCount - start) }, (_, k) => start + k);
            const results = await Promise.all(batch.map((n) => ocrImage(
                fakePagePng(n + 1, `page-${n + 1} first row|page-${n + 1} second row`),
                { logLabel: 'test5' })));
            results.forEach((t, k) => { pageTexts[batch[k]] = t; });
        }
        assert.strictEqual(ocrCalls.length, pageCount, 'every page OCRd exactly once');
        const distinct = new Set(ocrCalls).size;
        assert.strictEqual(distinct, pageCount, `all ${pageCount} sent images distinct (got ${distinct})`);
        for (let n = 0; n < pageCount; n++) {
            assert.ok(pageTexts[n].includes(`page-${n + 1} first row`),
                `slot ${n} holds page ${n + 1}'s text (order preserved across batches)`);
        }
    } finally {
        axios.post = originalPost;
    }
    console.log('✅ Test 5 passed\n');
}

async function main() {
    try {
        await test1_realShapeParses_inReadingOrder();
        await test2_unrecognizedShape_neverSilent();
        await test3_legacyShapesStillParse();
        await test4_parallelWorkers_sendDistinctImages();
        await test5_multipageDocument_assemblesInOrder();
        console.log('🎉 ALL OCR RESPONSE-PARSE + PARALLEL-ISOLATION SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
