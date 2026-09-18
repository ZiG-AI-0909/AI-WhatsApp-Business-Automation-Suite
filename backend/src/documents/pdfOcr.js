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
// =============================================================
const BOQ_LOGGER_TAG = 'boq';

// OCR is per-page slow (seconds each) and spends API credits, so a
// scanned PDF gets a hard page cap — mirroring the chunk cap in
// routes/boq.js. Default 20 covers the 19-page real-world tender.
const OCR_MAX_PAGES = Number(process.env.BOQ_OCR_MAX_PAGES || 20);
// Render scale: 2x of a ~595pt-wide A4 page ≈ 1190px — comfortably
// readable for 8-10pt table text without ballooning upload size.
const OCR_RENDER_SCALE = Number(process.env.BOQ_OCR_SCALE || 2);
// Per-page OCR timeout. One slow page must not eat the whole budget.
const OCR_PER_PAGE_TIMEOUT_MS = Number(process.env.BOQ_OCR_PAGE_TIMEOUT_MS || 30000);

function ocrConfig() {
    return { OCR_MAX_PAGES, OCR_RENDER_SCALE, OCR_PER_PAGE_TIMEOUT_MS };
}

/**
 * OCR a scanned PDF: render every page to PNG, OCR each page, and
 * return the concatenated text (page breaks between pages).
 * Returns { text, ocrUsed, failedPages, totalMs }.
 * @param {Buffer} pdfBuffer the uploaded PDF bytes.
 * @param {number} userId for [boq:userId] logging only.
 */
async function ocrScannedPdf(pdfBuffer, userId) {
    const startedAt = Date.now();
    const { PDFParse } = require('pdf-parse');
    const { ocrImage } = require('../ai/ocrService');

    const parser = new PDFParse({ data: pdfBuffer });
    try {
        // Page count comes free from getText() — no rendering needed —
        // so the cap trips BEFORE any render/OCR spend.
        const meta = await parser.getText();
        const pageCount = meta.total || meta.pages?.length || 0;
        if (pageCount > OCR_MAX_PAGES) {
            const error = new Error(`This scanned PDF has ${pageCount} pages — too many to OCR in one request (max ${OCR_MAX_PAGES}). Split it up (e.g. save page ranges as separate PDFs) and upload each part.`);
            error.statusCode = 413;
            throw error;
        }
        if (!pageCount) throw new Error('This PDF has no readable pages.');

        console.log(`[boq:${userId}] OCR mode: ${pageCount} page(s) to render + OCR (max ${OCR_MAX_PAGES}, scale ${OCR_RENDER_SCALE})`);
        const screenshots = await parser.getScreenshot({ first: pageCount, scale: OCR_RENDER_SCALE, imageBuffer: true });
        const pages = screenshots.pages || [];

        const ocrStart = Date.now();
        const pageTexts = [];
        const failedPages = [];
        for (const page of pages) {
            const pageStart = Date.now();
            try {
                const text = await ocrImage(Buffer.from(page.data), {
                    mimeType: 'image/png',
                    timeoutMs: OCR_PER_PAGE_TIMEOUT_MS,
                });
                pageTexts.push(text || '');
                const chars = (text || '').trim().length;
                console.log(`[boq:${userId}] OCR page ${page.pageNumber}/${pageCount} ok in ${Date.now() - pageStart}ms (${chars} chars)`);
            } catch (error) {
                // One unreadable/failed page must not sink the document:
                // concatenate what we got and let the AI see partial text.
                failedPages.push(page.pageNumber);
                pageTexts.push('');
                console.error(`[boq:${userId}] OCR page ${page.pageNumber}/${pageCount} FAILED after ${Date.now() - pageStart}ms: ${error.message}`);
            }
        }
        const totalMs = Date.now() - startedAt;
        const text = pageTexts.join('\n');
        console.log(`[boq:${userId}] OCR done in ${totalMs}ms: ${pageCount - failedPages.length}/${pageCount} page(s) succeeded, ${text.trim().length} chars total (OCR phase ${Date.now() - ocrStart}ms)${failedPages.length ? ` — failed pages: ${failedPages.join(', ')}` : ''}`);
        return { text, ocrUsed: true, failedPages, totalMs, pageCount };
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

module.exports = { ocrScannedPdf, ocrConfig };
