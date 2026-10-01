// =============================================================
// Scanned-PDF OCR pipeline for Document Intelligence (BOQ).
//
// A scanned/photographed PDF has no text layer: pdf-parse returns
// only page separators ("-- 1 of 20 --") and the AI gets nothing.
// This module renders each page to PNG and runs NVIDIA Nemotron
// OCR (the same service the Image Extractor uses, via
// ai/ocrService) on every page, producing one text string that is
// fed into the UNCHANGED chunked extraction pipeline in
// routes/boq.js (splitIntoChunks → BOQ prompt → flagAll).
//
// Rendering uses pdf-parse's own getScreenshot() (pdfjs-dist +
// prebuilt @napi-rs/canvas binaries) — no Ghostscript/Poppler/
// ImageMagick, nothing to compile, so it installs and runs on
// Render's native Node runtime with plain `npm install`.
//
// CONCURRENCY (2026-09 timeout fix): pages used to OCR strictly
// sequentially, so a real 19-page government tender spent
// 19 × per-page latency on the wall clock and blew through both
// the server's 90s budget and the frontend's 110s client timeout.
// Per-page latency is dominated by the NVIDIA round trip, so pages
// now run CONCURRENTLY in bounded batches (default 5). Worst-case
// OCR wall time drops from N × latency to ceil(N/5) × latency
// (~5 batches for 19 pages instead of 19 sequential calls).
//
// DEADLINE: the whole OCR phase shares the request's wall-clock
// budget (startedAt + BOQ_TOTAL_BUDGET_MS, passed in as deadlineMs
// by routes/boq.js). Page-cap and text checks fire synchronously
// BEFORE any OCR spend, so an over-cap PDF still rejects instantly.
// The render step is CPU-bound (pdfjs+canvas) and not clampable — on a
// Render free-tier box it took ~80-90s for the real 19-page tender, which
// is why the total budget was sized up to 150s (routes/boq.js). NVIDIA
// batches still clamp their per-attempt time to what remains, and a
// batch that cannot start before the deadline is SKIPPED (an attempt
// that can only fail at its timeout would waste the same wall time and
// log a fake success). If OCR legitimately eats the whole budget, the
// route fails fast with an honest 504 (see boq.js budget guard).
// =============================================================
const BOQ_LOGGER_TAG = 'boq';

// OCR is per-page slow (seconds each) and spends API credits, so a
// scanned PDF gets a hard page cap — mirroring the chunk cap in
// routes/boq.js. Default 20 covers the 19-page real-world tender.
const OCR_MAX_PAGES = Number(process.env.BOQ_OCR_MAX_PAGES || 20);
// Render scale: 2x of a ~595pt-wide A4 page ≈ 1190px — comfortably
// readable for 8-10pt table text without ballooning upload size.
const OCR_RENDER_SCALE = Number(process.env.BOQ_OCR_SCALE || 2);
// Per-page OCR timeout CEILING. One slow page must not eat the whole
// budget — but under concurrency a batch waits for its slowest member,
// so this is a per-ATTEMPT ceiling, clamped down to fit the deadline
// (see ocrBudget below). The request-level budget governs the phase.
const OCR_PER_PAGE_TIMEOUT_MS = Number(process.env.BOQ_OCR_PAGE_TIMEOUT_MS || 30000);
// Pages OCR'd simultaneously (the provider-permissioned batch size).
// Bounded — never all 19 at once — to stay inside NVIDIA rate limits
// and avoid throttling/free-tier CPU contention. 5 turns the real
// 19-page tender into 5 wait-for-slowest batches.
const OCR_CONCURRENCY = Math.max(1, Number(process.env.BOQ_OCR_CONCURRENCY || 5));
// Share of the remaining phase budget that sizes the per-NVIDIA-call
// ceiling: a batch of 5 waits for its slowest member, so one attempt may
// not eat everything that remains. (Historical note: this was described
// as an "AI-phase reserve", but real free-tier logs showed the CPU-bound
// render step consuming 80-90s regardless — a multiplier on remaining
// time cannot reserve wall clock for AI. The honest AI protection is the
// route-level budget guard in boq.js, which fails fast after OCR when
// nothing is left.)
const OCR_BUDGET_SHARE = Math.min(0.9, Math.max(0.1, Number(process.env.BOQ_OCR_BUDGET_SHARE || 0.4)));

function ocrConfig() {
    return { OCR_MAX_PAGES, OCR_RENDER_SCALE, OCR_PER_PAGE_TIMEOUT_MS, OCR_CONCURRENCY, OCR_BUDGET_SHARE };
}

// How much wall-clock time OCR may spend: the remaining budget up to
// this point (startedAt → now) minus the AI reserve, with a floor of
// 2s so a pathologically slow start still gets one attempt per page.
function ocrBudget(deadlineMs, startedAt) {
    if (!deadlineMs) return Number.POSITIVE_INFINITY;
    const elapsed = Date.now() - startedAt;
    return Math.max(2000, Math.floor((deadlineMs - Date.now()) * OCR_BUDGET_SHARE - elapsed));
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('BOQ OCR was cancelled.');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
}

/**
 * OCR one page with a per-attempt timeout that fits the remaining
 * budget. Always resolves (never throws) so one bad page can never
 * sink the document — returns { text, failed } and keeps its slot in
 * the result array, preserving page order under concurrency.
 */
async function ocrOnePage(ocrImage, page, perPageMs, userId, pageCount, signal) {
    const pageStart = Date.now();
    try {
        const result = await ocrImage(Buffer.from(page.data), {
            mimeType: 'image/png',
            timeoutMs: perPageMs,
            returnLayout: true,
            signal,
            // TEMP DIAGNOSTIC (remove after live verify): tags ocrService's
            // "[ocr-diag:…] HTTP + top-level keys" line with THIS page number,
            // so per-page status/keys/char-count evidence is attributable
            // even with 5 pages interleaved in the logs.
            logLabel: `boq-page-${page.pageNumber}`,
        });
        const text = typeof result === 'string' ? result : result?.text || '';
        const chars = (text || '').trim().length;
        console.log(`[boq:${userId}] OCR page ${page.pageNumber}/${pageCount} ok in ${Date.now() - pageStart}ms (${chars} chars)`);
        return { text, detections: typeof result === 'object' ? result.detections || [] : [], failed: false };
    } catch (error) {
        // One unreadable/failed page must not sink the document:
        // concatenate what we got and let the AI see partial text.
        console.error(`[boq:${userId}] OCR page ${page.pageNumber}/${pageCount} FAILED after ${Date.now() - pageStart}ms: ${error.message}`);
        return { text: '', detections: [], failed: true };
    }
}

function groupOcrDetections(detections) {
    const positioned = (detections || []).map((detection) => {
        const points = detection.boundingBox?.points;
        if (!Array.isArray(points) || !points.length) return { ...detection, top: null, bottom: null, left: null, center: null };
        const ys = points.map((point) => Number(point?.y ?? 0));
        const xs = points.map((point) => Number(point?.x ?? 0));
        return {
            ...detection,
            top: Math.min(...ys),
            bottom: Math.max(...ys),
            left: Math.min(...xs),
            center: (Math.min(...ys) + Math.max(...ys)) / 2,
        };
    }).sort((a, b) => {
        if (a.center == null || b.center == null) return 0;
        return (a.center - b.center) || ((a.left ?? 0) - (b.left ?? 0));
    });
    const heights = positioned.filter((item) => item.top != null).map((item) => Math.max(0, item.bottom - item.top)).sort((a, b) => a - b);
    const rowTolerance = heights.length ? Math.max(heights[Math.floor(heights.length / 2)] * 1.25, 0.001) : 0;
    const rows = [];
    for (const detection of positioned) {
        const prior = rows[rows.length - 1];
        const priorCenter = prior?.center;
        const sameLine = prior && detection.center != null && priorCenter != null
            && Math.abs(detection.center - priorCenter) <= rowTolerance;
        if (!sameLine) {
            rows.push({ center: detection.center, cells: [detection] });
        } else {
            prior.cells.push(detection);
            prior.center = prior.cells.reduce((sum, cell) => sum + cell.center, 0) / prior.cells.length;
        }
    }
    return rows.map((row) => row.cells
        .sort((a, b) => (a.left ?? 0) - (b.left ?? 0))
        .map((cell) => ({ text: cell.text, boundingBox: cell.boundingBox || null, confidence: cell.confidence ?? null })));
}

/**
 * OCR a scanned PDF: render every page to PNG, OCR pages in bounded
 * parallel batches, and return the concatenated text (page breaks
 * between pages, always in page order).
 * Returns { text, ocrUsed, failedPages, totalMs, pageCount }.
 * @param {Buffer} pdfBuffer the uploaded PDF bytes.
 * @param {number} userId for [boq:userId] logging only.
 * @param {object} [options]
 * @param {number} [options.deadlineMs] wall-clock deadline (epoch ms) shared
 *   with the AI phase — from startedAt + BOQ_TOTAL_BUDGET_MS in boq.js.
 */
async function ocrScannedPdf(pdfBuffer, userId, { deadlineMs = 0, signal } = {}) {
    const startedAt = Date.now();
    const { PDFParse } = require('pdf-parse');
    const { ocrImage } = require('../ai/ocrService');

    const parser = new PDFParse({ data: pdfBuffer });
    try {
        // Page count comes free from getText() — no rendering needed —
        // so the cap trips BEFORE any render/OCR spend.
        const meta = await parser.getText();
        throwIfAborted(signal);
        const pageCount = meta.total || meta.pages?.length || 0;
        if (pageCount > OCR_MAX_PAGES) {
            const error = new Error(`This scanned PDF has ${pageCount} pages — too many to OCR in one request (max ${OCR_MAX_PAGES}). Split it up (e.g. save page ranges as separate PDFs) and upload each part.`);
            error.statusCode = 413;
            throw error;
        }
        if (!pageCount) throw new Error('This PDF has no readable pages.');

        const budgetMs = ocrBudget(deadlineMs, startedAt);
        const budgetLabel = Number.isFinite(budgetMs) ? `deadline in ${Math.round((deadlineMs - Date.now()) / 1000)}s` : 'no shared deadline';
        console.log(`[boq:${userId}] OCR mode: ${pageCount} page(s) to render + OCR (max ${OCR_MAX_PAGES}, scale ${OCR_RENDER_SCALE}, ${OCR_CONCURRENCY} at a time, ${budgetLabel})`);
        // Render every page to PNG. CPU-bound and NOT clampable — measure
        // it separately so free-tier slowdowns are visible in the logs
        // instead of silently inflating the first NVIDIA batch's budget.
        const renderStart = Date.now();
        const screenshots = await parser.getScreenshot({ first: pageCount, scale: OCR_RENDER_SCALE, imageBuffer: true });
        throwIfAborted(signal);
        const pages = screenshots.pages || [];
        const renderMs = Date.now() - renderStart;
        console.log(`[boq:${userId}] rendered ${pages.length} page(s) in ${renderMs}ms (${Math.round(renderMs / Math.max(1, pages.length))}ms/page)`);

        const ocrStart = Date.now();
        // Results pre-seeded per page index: concurrent batches fill their
        // own slots, so the final join is ALWAYS in page order regardless
        // of which batch finishes first.
        const pageTexts = new Array(pages.length).fill('');
        const pageLayouts = new Array(pages.length).fill(null);
        const failedPages = [];
        // Per-attempt timeout: the 30s ceiling clamped to what the shared
        // deadline can still absorb for the CURRENT batch. Floor 2s keeps
        // a pathological start from degenerating into instant 0ms aborts.
        const attemptCeiling = Math.max(2000, Math.min(
            OCR_PER_PAGE_TIMEOUT_MS,
            Number.isFinite(budgetMs) ? budgetMs : OCR_PER_PAGE_TIMEOUT_MS
        ));

        for (let batchStart = 0; batchStart < pages.length; batchStart += OCR_CONCURRENCY) {
            throwIfAborted(signal);
            const batch = pages.slice(batchStart, batchStart + OCR_CONCURRENCY);
            // Re-clamp per batch: earlier batches' spend shrinks what this
            // one may still use. Floor 2s keeps a pathological start from
            // degenerating into instant 0ms aborts — but once the deadline
            // is inside the floor, SKIP the batch instead of attempting:
            // an attempt that can only fail at its timeout would waste the
            // same wall time and log pages as failed-late rather than
            // honestly not-attempted.
            const left = Number.isFinite(budgetMs) ? budgetMs - (Date.now() - ocrStart) : Number.POSITIVE_INFINITY;
            if (left < 2000) {
                console.error(`[boq:${userId}] OCR batch skipped: deadline exhausted — pages ${batchStart + 1}-${pages.length} not attempted (deadline in ${Math.round(left)}s)`);
                for (let k = batchStart; k < pages.length; k++) failedPages.push(pages[k].pageNumber);
                break; // every later batch is equally doomed
            }
            const remaining = Math.max(2000, Math.min(
                attemptCeiling,
                Number.isFinite(budgetMs) ? left : OCR_PER_PAGE_TIMEOUT_MS
            ));
            const results = await Promise.all(batch.map((page) => ocrOnePage(
                ocrImage,
                page,
                remaining,
                userId,
                pageCount,
                signal
            )));
            throwIfAborted(signal);
            // Slot = absolute batch position, NOT pageNumber: order must
            // survive regardless of what pageNumber the renderer reports.
            results.forEach((result, idx) => {
                pageTexts[batchStart + idx] = result.text;
                pageLayouts[batchStart + idx] = {
                    page: batch[ idx ].pageNumber,
                    text: result.text,
                    detections: result.detections,
                    rows: groupOcrDetections(result.detections),
                };
                if (result.failed) failedPages.push(batch[idx].pageNumber);
            });
        }
        const totalMs = Date.now() - startedAt;
        const text = pageTexts.join('\n');
        console.log(`[boq:${userId}] OCR done in ${totalMs}ms: ${pageCount - failedPages.length}/${pageCount} page(s) succeeded, ${text.trim().length} chars total (OCR phase ${Date.now() - ocrStart}ms, batches of ${OCR_CONCURRENCY})${failedPages.length ? ` — failed pages: ${failedPages.join(', ')}` : ''}`);
        return { text, pages: pageLayouts.filter(Boolean), ocrUsed: true, failedPages, totalMs, pageCount };
    } catch (error) {
        // The cap error (413) is already user-facing — pass it through.
        // Anything else escaping here is a pipeline failure (corrupt PDF,
        // render blow-up, network down): give the route/user OCR context.
        if (error.statusCode) throw error;
        throw new Error(`Scanned-PDF OCR failed: ${error.message}`);
    } finally {
        await parser.destroy(); // release the worker thread
    }
}

async function ocrNativePdfPages(pdfBuffer, userId, pageNumbers, { deadlineMs = 0, signal } = {}) {
    const startedAt = Date.now();
    const { PDFParse } = require('pdf-parse');
    const { ocrImage } = require('../ai/ocrService');
    const parser = new PDFParse({ data: pdfBuffer });
    try {
        const meta = await parser.getText();
        throwIfAborted(signal);
        const pageCount = meta.total || meta.pages?.length || 0;
        const selectedPages = [...new Set((pageNumbers || []).map(Number))]
            .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
            .sort((a, b) => a - b);
        if (!selectedPages.length) return { pages: [], failedPages: [], pageCount, totalMs: Date.now() - startedAt };
        if (selectedPages.length > OCR_MAX_PAGES) {
            const error = new Error(`This PDF has ${selectedPages.length} candidate table pages — too many for visual table extraction in one request (max ${OCR_MAX_PAGES}).`);
            error.statusCode = 413;
            throw error;
        }

        const screenshots = await parser.getScreenshot({
            partial: selectedPages,
            scale: OCR_RENDER_SCALE,
            imageBuffer: true,
        });
        throwIfAborted(signal);
        const renderedPages = screenshots.pages || [];
        const results = new Array(renderedPages.length).fill(null);
        const failedPages = [];
        for (let batchStart = 0; batchStart < renderedPages.length; batchStart += OCR_CONCURRENCY) {
            throwIfAborted(signal);
            const batch = renderedPages.slice(batchStart, batchStart + OCR_CONCURRENCY);
            const remaining = deadlineMs ? deadlineMs - Date.now() : OCR_PER_PAGE_TIMEOUT_MS;
            if (deadlineMs && remaining < 2000) {
                for (const page of renderedPages.slice(batchStart)) failedPages.push(page.pageNumber);
                break;
            }
            const timeoutMs = Math.max(2000, Math.min(OCR_PER_PAGE_TIMEOUT_MS, remaining));
            const pageResults = await Promise.all(batch.map((page) =>
                ocrOnePage(ocrImage, page, timeoutMs, userId, pageCount, signal)
            ));
            throwIfAborted(signal);
            pageResults.forEach((result, index) => {
                const page = batch[index];
                results[batchStart + index] = {
                    page: page.pageNumber,
                    text: result.text,
                    detections: result.detections,
                    rows: groupOcrDetections(result.detections),
                    width: page.width,
                    height: page.height,
                };
                if (result.failed) failedPages.push(page.pageNumber);
            });
        }
        return {
            pages: results.filter(Boolean),
            failedPages,
            pageCount,
            totalMs: Date.now() - startedAt,
            ocrUsed: true,
        };
    } catch (error) {
        if (error.statusCode) throw error;
        throw new Error(`Native-PDF visual table extraction failed: ${error.message}`);
    } finally {
        await parser.destroy();
    }
}

module.exports = { ocrScannedPdf, ocrNativePdfPages, ocrConfig, groupOcrDetections };
