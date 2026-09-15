const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('../database/db');
const boqExtractor = require('../documents/boqExtractor');
const { respondIfInvalidUpload, validateUploadBuffer } = require('../middleware/fileValidation');
const { resolveAiConfig } = require('../utils/aiConfig');

const router = express.Router();

// Formats the Document Intelligence page accepts. BOQs arrive as Excel,
// Word, or PDF; text formats round out the set. Magic-byte validation
// comes from the shared fileValidation middleware.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = /\.(xlsx|docx|pdf|txt|csv|md)$/i.test(file.originalname || '');
        cb(ok ? null : new Error('Unsupported file type. Upload XLSX, DOCX, PDF, TXT, or CSV.'), ok);
    },
});

function extOf(filename) {
    return (filename.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
}

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function loadUserSettings(userId) {
    const settings = {};
    try {
        const rows = await db.select('app_settings', 'key, value', 'user_id = ?', [userId], '', 100, 0);
        const { decryptSettingIfSecret } = require('../utils/encryption');
        for (const row of rows) settings[row.key] = decryptSettingIfSecret(row.key, row.value);
    } catch (error) {
        console.error('[boq] failed to load settings:', error.message);
    }
    return settings;
}

// Per-chunk AI budget and chunk cap. With BOQ_MAX_CHUNKS × BOQ_CHUNK_MAX_CHARS
// characters covered, the server's worst-case wall time stays bounded well
// under the frontend's request timeout for this endpoint (see api.js).
const BOQ_AI_TIMEOUT_MS = Number(process.env.BOQ_AI_TIMEOUT_MS || 25000);
const BOQ_MAX_CHUNKS = Number(process.env.BOQ_MAX_CHUNKS || 4);

/**
 * Run AI extraction over the document text with the user's own AI
 * credentials (same never-mix guard as every other AI path).
 *
 * The document is extracted CHUNK BY CHUNK (see boqExtractor.splitIntoChunks):
 * one giant call truncates its JSON output on real-world BOQs (~25+ rows
 * exceed the maxTokens budget) and looked like an inexplicable hang/500.
 * Each chunk gets a hard per-call timeout and NO retries so a hung provider
 * fails fast with a clear, attributable error instead of stacking 3 retries.
 */
async function extractItemsWithAI(userId, documentText, filename = 'document') {
    const rows = await loadUserSettings(userId);
    const aiConfig = resolveAiConfig({
        storedKey: rows.AI_API_KEY,
        storedBaseURL: rows.AI_BASE_URL,
        envKey: process.env.AI_API_KEY,
        envBaseURL: process.env.AI_BASE_URL,
    });
    if (!aiConfig.apiKey) throw new Error('AI is not configured. Set AI_API_KEY on the server or in Settings.');
    const aiService = require('../ai/aiService');

    const chunks = boqExtractor.splitIntoChunks(documentText);
    if (chunks.length > BOQ_MAX_CHUNKS) {
        const error = new Error(`Document is too large to extract in one request (${chunks.length} sections, max ${BOQ_MAX_CHUNKS}). Split it into smaller parts and upload each separately.`);
        error.statusCode = 413;
        throw error;
    }
    console.log(`[boq:${userId}] AI extraction: "${filename}" → ${chunks.length} chunk(s) (${documentText.length} chars total, timeout ${Math.round(BOQ_AI_TIMEOUT_MS / 1000)}s per chunk)`);

    const items = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunkStart = Date.now();
        console.log(`[boq:${userId}] AI chunk ${i + 1}/${chunks.length} starting (${chunks[i].length} chars, model ${rows.AI_MODEL || process.env.AI_MODEL || 'default'})`);
        let content;
        try {
            content = await aiService._complete(
                [{ role: 'user', content: boqExtractor.buildExtractionPrompt(chunks[i]) }],
                {
                    apiKey: aiConfig.apiKey,
                    baseURL: aiConfig.baseURL,
                    model: rows.AI_MODEL || process.env.AI_MODEL,
                    temperature: 0.1,
                    maxTokens: 3000,
                    timeoutMs: BOQ_AI_TIMEOUT_MS,
                    retries: 1, // per-chunk: fail fast, the loop is the retry story
                    reasoningEffort: 'none', // raw JSON out; thinking burned the old token budget
                }
            );
        } catch (error) {
            console.error(`[boq:${userId}] AI chunk ${i + 1}/${chunks.length} FAILED after ${Date.now() - chunkStart}ms: ${error.message}`);
            error.message = `Section ${i + 1} of ${chunks.length} of "${filename}" could not be extracted: ${error.message}`;
            error.statusCode = error.statusCode || 502; // upstream AI/provider failure
            throw error;
        }
        let chunkItems;
        try {
            chunkItems = boqExtractor.normalizeResponse(content).map(boqExtractor.cleanItem);
        } catch (error) {
            console.error(`[boq:${userId}] AI chunk ${i + 1}/${chunks.length} returned unparseable output (${String(content || '').length} chars) after ${Date.now() - chunkStart}ms`);
            const parseError = new Error(`Section ${i + 1} of ${chunks.length} of "${filename}" did not return structured data (AI output truncated or malformed). Try again, or split the document into smaller parts.`);
            parseError.statusCode = 502;
            throw parseError;
        }
        console.log(`[boq:${userId}] AI chunk ${i + 1}/${chunks.length} completed in ${Date.now() - chunkStart}ms → ${chunkItems.length} item(s)`);
        items.push(...chunkItems);
    }
    return items;
}

// POST /api/boq/process — upload a requirement document, extract text,
// run AI extraction, flag suspicious rows, and store everything for review.
router.post('/process', upload.single('file'), async (req, res) => {
    const startedAt = Date.now();
    const userId = req.user?.id;
    if (!req.file) return res.status(400).json({ error: 'Upload an XLSX, DOCX, PDF, TXT, or CSV document.' });
    if (!respondIfInvalidUpload(req, res)) return;

    const ext = extOf(req.file.originalname);
    console.log(`[boq:${userId}] process START: "${req.file.originalname}" (${req.file.size} bytes, ${ext})`);
    try {
        const textStart = Date.now();
        const documentText = await boqExtractor.extractText(req.file.buffer, ext);
        const lineCount = documentText.split('\n').filter((l) => l.trim()).length;
        console.log(`[boq:${userId}] text extraction done in ${Date.now() - textStart}ms: ${documentText.length} chars / ${lineCount} non-empty lines`);

        if (!documentText.trim()) {
            console.log(`[boq:${userId}] rejected: no readable text (scanned/image-only document?)`);
            return res.status(400).json({ error: 'No readable text found in this document. Scanned/image-only PDFs are not supported — try the original Excel or Word file.' });
        }
        if (documentText.length > 60000) {
            console.log(`[boq:${userId}] rejected: document too large (${documentText.length} chars > 60000)`);
            return res.status(400).json({ error: 'Document is too large to process in one pass (over ~60k characters). Split it into sections and upload each part.' });
        }

        const items = await extractItemsWithAI(userId, documentText, req.file.originalname);
        const warnings = boqExtractor.flagAll(items);

        const dbStart = Date.now();
        const created = await db.insert('boq_documents', {
            filename: req.file.originalname,
            file_ext: ext,
            document_text: documentText,
            status: 'review',
            items: JSON.stringify(items),
            warnings: JSON.stringify(warnings),
            user_id: req.user.id,
        });

        const warnRows = warnings.filter((w) => Array.isArray(w) && w.length).length;
        console.log(`[boq:${userId}] process COMPLETE in ${Date.now() - startedAt}ms: ${items.length} item(s), ${warnRows} row(s) flagged, saved as #${created?.id ?? '?'} (db ${Date.now() - dbStart}ms)`);
        res.status(201).json(serializeDoc(created));
    } catch (error) {
        const status = error.statusCode || 500;
        // Full stack — this line is the whole point of the logging pass:
        // the original incident produced ZERO log lines, so the failure
        // stage and cause were invisible in Render's logs.
        console.error(`[boq:${userId}] process FAILED after ${Date.now() - startedAt}ms (HTTP ${status}):`, error.stack || error.message);
        res.status(status).json({ error: error.message });
    }
});

// GET /api/boq — this user's processed documents (history).
router.get('/', async (req, res) => {
    try {
        const rows = await db.select(
            'boq_documents',
            'id, filename, file_ext, status, items, warnings, created_at',
            'user_id = ?',
            [req.user.id],
            'created_at',
            100,
            0
        );
        res.json(rows.reverse().map(serializeDoc));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/boq/:id — one document with items + warnings (revisit past run).
router.get('/:id', async (req, res) => {
    try {
        const doc = await db.getById('boq_documents', req.params.id, req.user.id);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });
        res.json(serializeDoc(doc));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PUT /api/boq/:id — save edited rows from the review table (and updated status).
router.put('/:id', async (req, res) => {
    try {
        const doc = await db.getById('boq_documents', req.params.id, req.user.id);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });

        const items = (Array.isArray(req.body?.items) ? req.body.items : []).map(boqExtractor.cleanItem);
        if (!items.length) return res.status(400).json({ error: 'items must be a non-empty array.' });
        const status = ['review', 'confirmed'].includes(req.body?.status) ? req.body.status : doc.status;

        // Re-run the rule-based flags on the edited rows so warnings stay
        // truthful after edits (duplicates/outliers may appear or vanish).
        const warnings = boqExtractor.flagAll(items);
        await db.update('boq_documents', {
            items: JSON.stringify(items),
            warnings: JSON.stringify(warnings),
            status,
            updated_at: new Date(),
        }, 'id = ? AND user_id = ?', [req.params.id, req.user.id]);

        res.json(serializeDoc(await db.getById('boq_documents', req.params.id, req.user.id)));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/boq/:id
router.delete('/:id', async (req, res) => {
    try {
        const deleted = await db.del('boq_documents', 'id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!deleted || deleted.length === 0) return res.status(404).json({ error: 'Document not found.' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── RFQ export (Excel + PDF), regenerated from the stored rows ───

const RFQ_HEADERS = ['S.No', 'Product', 'Size', 'Specification', 'Quantity', 'Unit', 'Application / Remarks'];

function rfqRows(doc) {
    const items = parseJsonArray(doc.items);
    return items.map((item, index) => ({
        'S.No': index + 1,
        'Product': item.product || '',
        'Size': item.size || '',
        'Specification': item.specification || '',
        'Quantity': item.quantity || '',
        'Unit': item.unit || '',
        'Application / Remarks': [item.application, item.notes].filter(Boolean).join(' — '),
    }));
}

router.get('/:id/export/excel', async (req, res) => {
    try {
        const doc = await db.getById('boq_documents', req.params.id, req.user.id);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });
        const rows = rfqRows(doc);
        if (!rows.length) return res.status(400).json({ error: 'This document has no extracted items to export.' });

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('RFQ');
        sheet.addRow([`Request for Quotation — ${doc.filename}`]);
        sheet.addRow([]);
        sheet.addRow(RFQ_HEADERS);
        for (const row of rows) sheet.addRow(RFQ_HEADERS.map((h) => row[h]));
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        res.setHeader('Content-Disposition', `attachment; filename="rfq-${sanitizeFilename(doc.filename)}.xlsx"`);
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Minimal single-page PDF writer (no dependency): a header line, the RFQ
// table as text lines, and standard Helvetica metrics. Enough for a
// ready-to-review RFQ printout; the Excel export remains the data-faithful format.
function escapePdfText(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildRfqPdf(doc) {
    const rows = rfqRows(doc);
    const lines = [];
    lines.push({ text: 'REQUEST FOR QUOTATION', bold: true });
    lines.push({ text: `Source document: ${doc.filename}` });
    lines.push({ text: `Generated: ${new Date().toLocaleString()}` });
    lines.push({ text: '' });
    for (const row of rows) {
        const qty = [row.Quantity, row.Unit].filter(Boolean).join(' ');
        const spec = row.Specification ? ` | ${row.Specification}` : '';
        lines.push({ text: `${row['S.No']}. ${row.Product || '(product not stated)'} — ${row.Size || '(size missing)'}${spec}` });
        lines.push({ text: `      Qty: ${qty || '(missing)'}${row['Application / Remarks'] ? ` | ${row['Application / Remarks']}` : ''}` });
    }
    lines.push({ text: '' });
    lines.push({ text: 'Reviewed and approved for RFQ issue by: ______________________' });

    // Helvetica widths are approximated with a 0.5*fontsize average per char.
    const pageWidth = 595, pageHeight = 842, margin = 56, lineHeight = 16, maxWidth = pageWidth - margin * 2;
    const wrap = (text, fontSize) => {
        const charsPerLine = Math.max(10, Math.floor(maxWidth / (fontSize * 0.5)));
        const out = [];
        for (let i = 0; i < text.length; i += charsPerLine) out.push(text.slice(i, i + charsPerLine));
        return out.length ? out : [''];
    };

    const contentParts = [];
    let y = pageHeight - margin;
    for (const line of lines) {
        const fontSize = line.bold ? 16 : 10;
        for (const piece of wrap(line.text, fontSize)) {
            if (y < margin) break;
            const font = line.bold ? '/F2' : '/F1';
            contentParts.push(`BT ${font} ${fontSize} Tf ${margin} ${y} Td (${escapePdfText(piece)}) Tj ET`);
            y -= lineHeight;
        }
    }
    const content = contentParts.join('\n');
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
        `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((obj, i) => {
        offsets.push(pdf.length);
        pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xrefStart = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++) {
        pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
}

function sanitizeFilename(name) {
    return String(name || 'document').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 60) || 'document';
}

router.get('/:id/export/pdf', async (req, res) => {
    try {
        const doc = await db.getById('boq_documents', req.params.id, req.user.id);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });
        const items = parseJsonArray(doc.items);
        if (!items.length) return res.status(400).json({ error: 'This document has no extracted items to export.' });
        const buffer = buildRfqPdf(doc);
        res.setHeader('Content-Disposition', `attachment; filename="rfq-${sanitizeFilename(doc.filename)}.pdf"`);
        res.type('application/pdf').send(buffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function serializeDoc(doc) {
    return {
        ...doc,
        items: parseJsonArray(doc.items),
        warnings: parseJsonArray(doc.warnings),
    };
}

module.exports = { router, buildRfqPdf, rfqRows, sanitizeFilename };
