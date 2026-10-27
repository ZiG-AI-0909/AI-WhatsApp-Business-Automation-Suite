'use strict';

// Proforma Invoice Maker API. Mounted at /api/proforma behind requireAuth;
// open to every signed-in user (no staff allowlist) and scoped by
// req.user.id. Totals, words and validation always come from the backend
// (proformaCalculation / proformaValidation), never from the browser.
//
// Preview and export take the form itself, so they work before the
// database migration; saving needs supabase-proforma-migration.sql.

const express = require('express');
const multer = require('multer');
const { validateUploadBuffer } = require('../middleware/fileValidation');
const { aiExtractLimiter } = require('../middleware/rateLimiterMiddleware');
const extractor = require('../proforma/proformaExtractor');
const defaults = require('../proforma/proformaDefaults');
const calc = require('../proforma/proformaCalculation');
const { sanitizeInvoice, sanitizeProfile, validateInvoice, isDate } = require('../proforma/proformaValidation');
const exporter = require('../proforma/proformaExport');
const service = require('../proforma/proformaService');

const router = express.Router();

// Upload -> auto-fill runs as TWO requests with independent budgets: OCR
// (/upload/ocr) and AI extraction (/upload/extract). A slow OCR can never
// eat the extraction's time (the BOQ pipeline once shared one budget and
// OCR starved extraction on every real scan), and a failed extraction can
// be retried from the same OCR text without paying for OCR again.
const OCR_BUDGET_MS = Number(process.env.PROFORMA_OCR_BUDGET_MS || 100000);
const EXTRACT_BUDGET_MS = Number(process.env.PROFORMA_EXTRACT_BUDGET_MS || 100000);
const MAX_PDF_PAGES = Number(process.env.PROFORMA_MAX_PDF_PAGES || 5);
const MAX_TEXT_CHARS = 60000;
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = /\.(jpe?g|png|webp|pdf)$/i.test(file.originalname || '');
        cb(ok ? null : Object.assign(new Error('Upload a JPG, PNG or PDF of the invoice.'), { statusCode: 400 }), ok);
    },
});
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function singleFile(req, res, next) {
    upload.single('file')(req, res, (error) => {
        if (!error) return next();
        const tooBig = error.code === 'LIMIT_FILE_SIZE';
        res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'The file is larger than 15 MB.' : error.message });
    });
}

function httpError(status, message, extra) {
    return Object.assign(new Error(message), { statusCode: status, extra, expose: true });
}

function sendError(res, error, fallback) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(`[proforma] ${status}${fallback ? ` ${fallback}` : ''}:`, error.message || error);
    // Messages written for the user (httpError) are shown; unexpected 5xx are not.
    res.status(status).json({ error: status < 500 || error.expose ? error.message : fallback, ...(error.extra || {}) });
}

function istToday() {
    return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

// Everything the form shows that the backend derives from the invoice.
function preview(invoice) {
    const totals = calc.calculate(invoice);
    const errors = validateInvoice(invoice);
    const texts = (value) => {
        const segments = calc.parseTemplate(value, invoice, totals);
        return { segments, dynamic: calc.isDynamic(segments) };
    };
    return {
        totals,
        texts: {
            payment: texts(invoice.payment.summary),
            terms: invoice.terms.map((term) => ({ id: term.id, ...texts(term.text) })),
            delivery_terms: invoice.shipping.delivery_terms.trim() || [invoice.shipping.incoterm, invoice.shipping.incoterm_place].filter(Boolean).join(' '),
        },
        errors,
        valid: Object.keys(errors).length === 0,
    };
}

router.get('/defaults', async (req, res) => {
    try {
        const { profile, saved, persistence } = await service.getProfile(req.user.id);
        res.json({
            profile,
            profile_saved: saved,
            persistence,
            blank: defaults.blankInvoice(profile, istToday()),
            sample: defaults.sampleInvoice(profile),
            factory_profile: defaults.DEFAULT_PROFILE,
            currencies: Object.values(defaults.CURRENCIES),
            incoterms: defaults.INCOTERMS,
            tokens: calc.TOKENS,
        });
    } catch (error) {
        sendError(res, error, 'Could not load the proforma defaults.');
    }
});

router.put('/profile', async (req, res) => {
    try {
        const profile = await service.saveProfile(req.user.id, sanitizeProfile(req.body?.profile));
        res.json({ profile, profile_saved: true });
    } catch (error) {
        sendError(res, error, 'Could not save the company profile.');
    }
});

router.post('/preview', (req, res) => {
    try {
        res.json(preview(sanitizeInvoice(req.body?.invoice)));
    } catch (error) {
        sendError(res, error, 'Could not calculate the invoice.');
    }
});

router.post('/export', async (req, res) => {
    try {
        const invoice = sanitizeInvoice(req.body?.invoice);
        const errors = validateInvoice(invoice);
        if (Object.keys(errors).length) {
            return res.status(422).json({ error: 'Fix the highlighted fields before exporting.', errors });
        }
        const { buffer } = await exporter.buildProformaWorkbook(invoice);
        res.setHeader('Content-Disposition', `attachment; filename="${exporter.exportFileName(invoice)}"`);
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
    } catch (error) {
        sendError(res, error, 'Could not build the proforma invoice spreadsheet.');
    }
});

// Step 1: file -> text. Images are one OCR call; a PDF uses its text layer
// when it has one, otherwise the scanned-PDF OCR path with this step's own
// deadline.
router.post('/upload/ocr', aiExtractLimiter, singleFile, async (req, res) => {
    const userId = req.user.id;
    try {
        if (!req.file) throw httpError(400, 'Choose an image or PDF of the invoice.');
        const check = validateUploadBuffer(req.file.buffer, req.file.originalname);
        if (!check.ok) throw httpError(400, check.error);
        const startedAt = Date.now();
        let text = '';
        let source = 'ocr';
        let pages = 1;
        let failedPages = [];
        if (check.ext === '.pdf') {
            const { PDFParse } = require('pdf-parse');
            const parser = new PDFParse({ data: req.file.buffer });
            let layer;
            try { layer = await parser.getText(); } finally { await parser.destroy(); }
            pages = layer.total || layer.pages?.length || 0;
            if (pages > MAX_PDF_PAGES) throw httpError(413, `This PDF has ${pages} pages. Upload the invoice pages only (at most ${MAX_PDF_PAGES}).`);
            const layerText = String(layer.text || '').replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '');
            if (layerText.replace(/\s+/g, '').length >= 200) {
                text = layerText;
                source = 'pdf_text';
            } else {
                const result = await require('../documents/pdfOcr').ocrScannedPdf(req.file.buffer, userId, { deadlineMs: startedAt + OCR_BUDGET_MS });
                text = result.text;
                failedPages = result.failedPages || [];
            }
        } else {
            text = await require('../ai/ocrService').ocrImage(req.file.buffer, { mimeType: MIME[check.ext], timeoutMs: OCR_BUDGET_MS, logLabel: `proforma:${userId}` });
        }
        if (!extractor.hasReadableText(text)) {
            throw httpError(422, 'No readable text was found in this file. Upload a clearer photo or scan of the invoice, or fill in the form by hand.', { code: 'NO_TEXT' });
        }
        console.log(`[proforma:${userId}] upload text via ${source}: ${text.length} chars in ${Date.now() - startedAt}ms`);
        res.json({ text: text.slice(0, MAX_TEXT_CHARS), source, pages, failed_pages: failedPages, chars: text.length });
    } catch (error) {
        if (!error.statusCode && /timeout|ECONNABORTED|aborted/i.test(`${error.code} ${error.message}`)) {
            return sendError(res, httpError(504, 'Reading the file took too long. Try again, or upload a smaller or clearer image.', { retryable: true }), '');
        }
        if (!error.statusCode && /NVIDIA_API_KEY/.test(error.message)) {
            return sendError(res, httpError(503, 'Reading uploaded invoices is not configured on the server (NVIDIA OCR key missing).'), '');
        }
        sendError(res, error, 'Could not read the uploaded file.');
    }
});

// Step 2: text -> form fields, with its own budget. Fills the form only;
// nothing is saved or exported.
router.post('/upload/extract', aiExtractLimiter, async (req, res) => {
    const userId = req.user.id;
    try {
        const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, MAX_TEXT_CHARS) : '';
        if (!extractor.hasReadableText(text)) throw httpError(400, 'There is no invoice text to extract. Upload the file again.');
        const deadlineMs = Date.now() + EXTRACT_BUDGET_MS;
        const { aiConfig, model, aiService } = await require('./boq').loadExtractionClient(userId);
        const content = await aiService._complete([{ role: 'user', content: extractor.buildExtractionPrompt(text) }], {
            apiKey: aiConfig.apiKey,
            baseURL: aiConfig.baseURL,
            model,
            temperature: 0.1,
            maxTokens: 6000,
            timeoutMs: EXTRACT_BUDGET_MS,
            deadlineMs,
            minAttemptMs: 15000,
            retries: 1,
            reasoningEffort: 'none',
            logLabel: `proforma extract ${userId}`,
        });
        const { profile } = await service.getProfile(userId);
        const result = extractor.mapExtraction(extractor.parseJsonObject(content), defaults.blankInvoice(profile, istToday()));
        if (!extractor.isUsableExtraction(result)) {
            throw httpError(422, 'This does not look like a proforma invoice: none of the expected fields (invoice number, parties, ports, product rows) were found. Check the file, or fill in the form by hand.', { code: 'NOT_A_PROFORMA' });
        }
        res.json({ invoice: result.invoice, flags: result.flags, warnings: result.warnings, document_totals: result.document_totals, ...preview(result.invoice) });
    } catch (error) {
        if (!error.statusCode && (error.aiKind === 'timeout' || /timeout|deadline|ECONNABORTED/i.test(`${error.code} ${error.message}`))) {
            return sendError(res, httpError(504, 'Reading the invoice fields took too long. Try again: the file does not need to be read again.', { retryable: true }), '');
        }
        if (!error.statusCode && /not configured/i.test(error.message)) return sendError(res, httpError(503, error.message), '');
        if (!error.statusCode && /structured invoice data/.test(error.message)) {
            return sendError(res, httpError(502, error.message, { retryable: true }), '');
        }
        sendError(res, error, 'Could not extract the invoice fields.');
    }
});

router.get('/next-number', async (req, res) => {
    try {
        const date = isDate(String(req.query.date || '')) ? String(req.query.date) : istToday();
        res.json(await service.nextNumber(req.user.id, { prefix: req.query.prefix, date }));
    } catch (error) {
        sendError(res, error, 'Could not suggest an invoice number.');
    }
});

router.get('/', async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        res.json(await service.list(req.user.id, { search: req.query.search, limit, offset }));
    } catch (error) {
        sendError(res, error, 'Could not load proforma invoices.');
    }
});

router.post('/', async (req, res) => {
    try {
        const saved = await service.create(req.user.id, sanitizeInvoice(req.body?.invoice));
        res.status(201).json({ ...saved, ...preview(saved.invoice) });
    } catch (error) {
        sendError(res, error, 'Could not save the proforma invoice.');
    }
});

router.get('/:id', async (req, res) => {
    try {
        const saved = await service.get(req.params.id, req.user.id);
        if (!saved) return res.status(404).json({ error: 'Proforma invoice not found.' });
        res.json({ ...saved, ...preview(saved.invoice) });
    } catch (error) {
        sendError(res, error, 'Could not load the proforma invoice.');
    }
});

router.put('/:id', async (req, res) => {
    try {
        const saved = await service.update(req.params.id, req.user.id, sanitizeInvoice(req.body?.invoice));
        if (!saved) return res.status(404).json({ error: 'Proforma invoice not found.' });
        res.json({ ...saved, ...preview(saved.invoice) });
    } catch (error) {
        sendError(res, error, 'Could not save the proforma invoice.');
    }
});

router.delete('/:id', async (req, res) => {
    try {
        if (!await service.remove(req.params.id, req.user.id)) return res.status(404).json({ error: 'Proforma invoice not found.' });
        res.json({ success: true });
    } catch (error) {
        sendError(res, error, 'Could not delete the proforma invoice.');
    }
});

module.exports = router;
