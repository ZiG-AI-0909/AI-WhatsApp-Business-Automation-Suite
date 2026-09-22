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

// ─── ONE wall-time budget, shared with the frontend ──────────
// The browser allows /boq/process 110s (frontend/src/api.js — the two
// budgets must move together). The WHOLE server pipeline — text
// extraction, OCR (parallel batches sharing this same deadline) and
// every AI chunk — is capped at 90s, so the server always answers FIRST
// with a precise error instead of the browser's generic timeout. Render
// itself allows responses up to 100 minutes (verified 2026-09 in Render's
// docs — no short platform proxy ceiling), so 90/110 is our own UX
// pairing, not a platform constraint.
const BOQ_TOTAL_BUDGET_MS = Number(process.env.BOQ_TOTAL_BUDGET_MS || 90000);
// Per-call FLOOR: the smallest per-attempt timeout that is still useful.
// It also derives the default chunk cap (budget ÷ floor) so the cap and
// the floor can never contradict each other.
const BOQ_AI_MIN_CALL_MS = Number(process.env.BOQ_AI_MIN_CALL_MS || 20000);
// Per-call CEILING: one attempt can never hog the budget — a failed
// attempt always leaves room for the single transient retry.
const BOQ_AI_MAX_CALL_MS = Math.max(
    BOQ_AI_MIN_CALL_MS,
    Number(process.env.BOQ_AI_MAX_CALL_MS || 45000)
);
// Chunk-extraction wave width: chunks are extracted in bounded parallel
// waves (mirroring BOQ_OCR_CONCURRENCY on the OCR side) so a many-chunk
// document still fits the ONE wall-clock budget. 4 keeps provider rate
// limits comfortable and turns the worst case from N × per-call latency
// into ceil(N/4) × per-call latency.
const BOQ_AI_CONCURRENCY = Math.max(1, Number(process.env.BOQ_AI_CONCURRENCY || 4));
// Chunk cap: how many extraction calls one request may make. The old
// formula (budget ÷ min-call floor = 90s/20s = 4) silently regressed the
// size-cap removal — it re-rejected the real 19-page tender at ~48k chars
// with a 413. Extraction now runs in waves of BOQ_AI_CONCURRENCY, so wall
// time is ceil(N/4) × per-call, and the cap is floored at 8 (~96k chars at
// the 12k-char default chunk size — the real 19-page tender needs 7).
const BOQ_MAX_CHUNKS = Number(process.env.BOQ_MAX_CHUNKS)
    || Math.max(8, Math.floor(BOQ_TOTAL_BUDGET_MS / BOQ_AI_MIN_CALL_MS));
// OCR page cap (scanned PDFs): enforced inside documents/pdfOcr.js — kept
// visible here for the logging line. BOQ_OCR_MAX_PAGES is the env knob.
const BOQ_OCR_MAX_PAGES = Number(process.env.BOQ_OCR_MAX_PAGES || 20);

// Host of a base URL for LOGGING ONLY — never the key, never the full URL
// when it could carry credentials.
function hostOf(baseURL) {
    try {
        return new URL(baseURL).host;
    } catch {
        try { return new URL(`https://${String(baseURL || '').replace(/^\/+/, '')}`).host; } catch { return 'unparseable-host'; }
    }
}

/**
 * Map an AI extraction failure to the right HTTP status and retryable flag:
 *   timeout / network break  → 504 (retry might work)
 *   provider answered 429/5xx → 502 (retryable — quota/backpressure)
 *   provider answered 4xx    → 502 (permanent — bad key/model/template)
 */
function mapExtractionStatus(error) {
    if (error?.aiKind === 'timeout' || error?.aiKind === 'network') return { status: 504, retryable: true };
    const providerStatus = error?.providerStatus;
    if (providerStatus) return { status: 502, retryable: providerStatus === 429 || providerStatus >= 500 };
    return { status: 502, retryable: false };
}

/**
 * Server-level credentials for Document Intelligence, scoped to this
 * feature: DOCUMENT_INTELLIGENCE_NVIDIA_* wins when set, otherwise the
 * generic AI_* env pair is used. Both entries are (key, URL) PAIRS that
 * belong together, so resolveAiConfig's never-mix guarantee still holds:
 * a tenant's stored key + custom URL always wins, and a custom URL
 * WITHOUT a stored key never receives a server key.
 */
function resolveDocIntelServerConfig() {
    const featureKey = (process.env.DOCUMENT_INTELLIGENCE_NVIDIA_API_KEY || '').trim();
    const featureURL = (process.env.DOCUMENT_INTELLIGENCE_NVIDIA_BASE_URL || '').trim();
    return {
        envKey: featureKey || process.env.AI_API_KEY,
        envBaseURL: featureURL || process.env.AI_BASE_URL,
    };
}

/**
 * Model for extraction: per-user stored setting first, then the
 * Document Intelligence default (DeepSeek), then the generic AI_MODEL.
 */
function resolveDocIntelModel(storedModel) {
    return (storedModel || '').trim()
        || (process.env.DOCUMENT_INTELLIGENCE_NVIDIA_MODEL || '').trim()
        || (process.env.AI_MODEL || '').trim()
        || undefined;
}

/**
 * Run AI extraction over the document text with the user's own AI
 * credentials (same never-mix guard as every other AI path).
 *
 * The document is extracted CHUNK BY CHUNK (see boqExtractor.splitIntoChunks):
 * one giant call truncates its JSON output on real-world BOQs (~25+ rows
 * exceed the maxTokens budget) and looked like an inexplicable hang/500.
 *
 * Budget model: the whole extraction phase shares ONE wall-clock deadline.
 * Each chunk's per-call timeout is the remaining budget divided by the
 * remaining chunks (clamped to the per-call ceiling), so a 1-chunk document
 * gets the WHOLE budget instead of a fixed 25s slice, and later chunks
 * inherit whatever earlier ones left behind. Each call gets exactly one
 * transient retry (timeout/socket break, 429, 5xx) inside that deadline.
 */
async function extractItemsWithAI(userId, documentText, filename = 'document', deadlineMs = 0) {
    const rows = await loadUserSettings(userId);
    const aiConfig = resolveAiConfig({
        storedKey: rows.AI_API_KEY,
        storedBaseURL: rows.AI_BASE_URL,
        ...resolveDocIntelServerConfig(),
    });
    if (!aiConfig.apiKey) throw new Error('AI is not configured. Set AI_API_KEY on the server or in Settings.');
    const model = resolveDocIntelModel(rows.AI_MODEL);
    const aiService = require('../ai/aiService');

    const chunks = boqExtractor.splitIntoChunks(documentText);
    if (chunks.length > BOQ_MAX_CHUNKS) {
        const error = new Error(`Document is too large to extract in one request (${chunks.length} sections, max ${BOQ_MAX_CHUNKS}). Split it into smaller parts and upload each separately.`);
        error.statusCode = 413;
        throw error;
    }
    const budgetRemaining = deadlineMs ? Math.max(0, deadlineMs - Date.now()) : BOQ_TOTAL_BUDGET_MS;
    console.log(`[boq:${userId}] AI extraction: "${filename}" → ${chunks.length} chunk(s) (${documentText.length} chars total, wall budget ${Math.round(budgetRemaining / 1000)}s of ${Math.round(BOQ_TOTAL_BUDGET_MS / 1000)}s, per-call range ${Math.round(BOQ_AI_MIN_CALL_MS / 1000)}–${Math.round(BOQ_AI_MAX_CALL_MS / 1000)}s, model ${model || 'service default'}, host ${hostOf(aiConfig.baseURL)})`);

    // Extract chunks in PARALLEL WAVES of BOQ_AI_CONCURRENCY: N sequential
    // calls cost N × per-call latency on the wall clock (7+ chunks of real
    // OCR text blew the 90s budget), while waves bound provider rate-limit
    // exposure. Each call's timeout still divides what is LEFT by how many
    // chunks are unfinished, and every result lands in its own slot, so the
    // merge below is always in page order no matter which wave finishes first.
    const results = new Array(chunks.length).fill(null);
    const failed = new Array(chunks.length).fill(null);
    const runChunk = async (i) => {
        const chunkStart = Date.now();
        const chunksLeft = chunks.length - i; // chunks i+1.. have not started yet
        const remaining = deadlineMs ? deadlineMs - Date.now() : BOQ_TOTAL_BUDGET_MS;
        if (deadlineMs && remaining <= 0) {
            const exhausted = new Error(`The AI extraction budget ran out before section ${i + 1} of ${chunks.length} of "${filename}" could be attempted.`);
            exhausted.statusCode = 504;
            exhausted.extraction = { stage: 'ai_extraction', section: i + 1, of: chunks.length, retryable: true };
            failed[i] = exhausted;
            return;
        }
        // Fair share of what is left, clamped to the per-call ceiling. A
        // 1-chunk document effectively gets the whole remaining budget.
        const perCallMs = deadlineMs
            ? Math.max(100, Math.min(BOQ_AI_MAX_CALL_MS, Math.floor(remaining / chunksLeft)))
            : BOQ_AI_MAX_CALL_MS;
        console.log(`[boq:${userId}] AI chunk ${i + 1}/${chunks.length} starting (${chunks[i].length} chars, budget ${Math.round(remaining / 1000)}s left, per-call timeout ${Math.round(perCallMs / 1000)}s, model ${model || 'default'})`);
        let content;
        try {
            content = await aiService._complete(
                [{ role: 'user', content: boqExtractor.buildExtractionPrompt(chunks[i]) }],
                {
                    apiKey: aiConfig.apiKey,
                    baseURL: aiConfig.baseURL,
                    model,
                    temperature: 0.1,
                    // Output budget per chunk: ~60-100 tokens per extracted
                    // row + JSON overhead. A 12k-char chunk holds roughly
                    // 60-150 BOQ rows, so 8000 output tokens leaves headroom
                    // for dense pages without flirting with provider output
                    // ceilings. (Was 3000 — sized when chunks were half this
                    // and the whole document was capped at 60k chars.) If a
                    // provider still truncates dense chunks, lower
                    // BOQ_CHUNK_MAX_CHARS rather than raising this further.
                    maxTokens: 8000,
                    timeoutMs: perCallMs,
                    deadlineMs, // retries must fit inside the shared budget
                    minAttemptMs: BOQ_AI_MIN_CALL_MS,
                    retries: 1, // exactly ONE transient retry, inside the deadline
                    reasoningEffort: 'none', // raw JSON out; thinking burned the old token budget
                    logLabel: `boq chunk ${i + 1}/${chunks.length}`,
                }
            );
        } catch (error) {
            const mapped = mapExtractionStatus(error);
            console.error(`[boq:${userId}] AI chunk ${i + 1}/${chunks.length} FAILED after ${Date.now() - chunkStart}ms (attempt(s): ${error.attempts || 1}, kind ${error.aiKind || 'unknown'}${error.providerStatus ? `, provider HTTP ${error.providerStatus}` : ''}${error.providerRequestId ? `, req-id ${error.providerRequestId}` : ''}): ${error.message}${error.providerBody ? ` | provider body: ${error.providerBody}` : ''}`);
            error.message = `Section ${i + 1} of ${chunks.length} of "${filename}" could not be extracted: ${error.message}`;
            error.statusCode = mapped.status;
            error.extraction = { stage: 'ai_extraction', section: i + 1, of: chunks.length, retryable: mapped.retryable };
            failed[i] = error;
            return;
        }
        let chunkItems;
        try {
            chunkItems = boqExtractor.normalizeResponse(content).map(boqExtractor.cleanItem);
        } catch (error) {
            console.error(`[boq:${userId}] AI chunk ${i + 1}/${chunks.length} returned unparseable output (${String(content || '').length} chars) after ${Date.now() - chunkStart}ms`);
            const parseError = new Error(`Section ${i + 1} of ${chunks.length} of "${filename}" did not return structured data (AI output truncated or malformed). Try again, or split the document into smaller parts.`);
            parseError.statusCode = 502;
            parseError.extraction = { stage: 'ai_extraction', section: i + 1, of: chunks.length, retryable: true };
            failed[i] = parseError;
            return;
        }
        console.log(`[boq:${userId}] AI chunk ${i + 1}/${chunks.length} completed in ${Date.now() - chunkStart}ms → ${chunkItems.length} item(s)`);
        results[i] = chunkItems;
    };
    for (let waveStart = 0; waveStart < chunks.length; waveStart += BOQ_AI_CONCURRENCY) {
        const wave = [];
        for (let i = waveStart; i < Math.min(chunks.length, waveStart + BOQ_AI_CONCURRENCY); i++) wave.push(i);
        const waveStartMs = Date.now();
        // runChunk never throws (failures land in failed[i]); Promise.all
        // just waits for the wave. Waves run strictly in order so the
        // chunksLeft share math stays the same as the sequential form.
        await Promise.all(wave.map((i) => runChunk(i)));
        console.log(`[boq:${userId}] AI wave ${Math.floor(waveStart / BOQ_AI_CONCURRENCY) + 1} (${wave.length} chunk(s)) done in ${Date.now() - waveStartMs}ms`);
    }
    // One failure sinks the run with the FIRST (lowest-section) error so
    // messages stay deterministic and correctly attributed.
    const firstFailure = failed.find(Boolean);
    if (firstFailure) throw firstFailure;

    // Merge slot-ordered, collapsing the chunk-boundary repeat: a soft
    // break in splitIntoChunks repeats ONE line (header continuity), and
    // the model can emit that repeated row again — the identical row from
    // the END of chunk i and the START of chunk i+1 collapses to one.
    // Adjacent-pair comparison ONLY: genuinely repeated line items
    // elsewhere in the document survive and still surface as review
    // warnings via flagAll.
    const items = [];
    for (const chunkItems of results) {
        for (const item of chunkItems || []) {
            if (items.length) {
                const key = boqExtractor.chunkDedupeKey(item);
                if (key && key === boqExtractor.chunkDedupeKey(items[items.length - 1])) continue;
            }
            items.push(item);
        }
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
        let documentText = await boqExtractor.extractText(req.file.buffer, ext);
        const lineCount = documentText.split('\n').filter((l) => l.trim()).length;
        console.log(`[boq:${userId}] text extraction done in ${Date.now() - textStart}ms: ${documentText.length} chars / ${lineCount} non-empty lines`);

        // Junk-text guard: a scanned/image-only PDF still yields "text" from
        // pdf-parse — the page separators alone ("-- 1 of 20 --") are
        // non-empty — so emptiness is not the test. If what came out is
        // marker-only junk AND this is a PDF, run the OCR pipeline (render
        // pages → NVIDIA Nemotron OCR → concatenated text) and continue with
        // that instead. Non-PDF junk is still a clear rejection.
        if (boqExtractor.looksLikeJunkText(documentText)) {
            console.log(`[boq:${userId}] junk text detected (${documentText.trim().length} chars, alnum-starved) — scanned/image-only document?`);
            if (ext !== '.pdf') {
                console.log(`[boq:${userId}] rejected: no readable text in a non-PDF document`);
                return res.status(400).json({ error: 'No readable text found in this document. If it is a scan or photo, upload it as a PDF — scanned PDFs are read with OCR.' });
            }
            const ocrStart = Date.now();
            try {
                // deadlineMs = startedAt + BOQ_TOTAL_BUDGET_MS: the OCR phase
                // shares the SAME wall budget as the AI phase — parallel OCR
                // batches inside pdfOcr.js respect this deadline (per-batch
                // timeouts clamp to what is left, with a reserve for AI), so
                // a slow scan answers INSIDE the request instead of letting
                // the browser's 110s timeout fire first.
                const ocr = await require('../documents/pdfOcr').ocrScannedPdf(req.file.buffer, userId, {
                    deadlineMs: startedAt + BOQ_TOTAL_BUDGET_MS,
                });
                documentText = ocr.text;
                console.log(`[boq:${userId}] OCR fallback produced ${documentText.trim().length} chars in ${Date.now() - ocrStart}ms (cap ${BOQ_OCR_MAX_PAGES} pages, ${ocr.failedPages.length} failed page(s))`);
            } catch (ocrError) {
                const status = ocrError.statusCode || 502;
                console.error(`[boq:${userId}] OCR fallback FAILED after ${Date.now() - ocrStart}ms (HTTP ${status}): ${ocrError.message}`);
                // Forward retry/stage hints (deadline timeouts are usually
                // transient) so the UI can offer a Retry button instead of
                // a generic failure.
                const body = { error: ocrError.message };
                if (typeof ocrError.retryable === 'boolean') body.retryable = ocrError.retryable;
                if (ocrError.extraction?.stage) body.stage = ocrError.extraction.stage;
                return res.status(status).json(body);
            }
            // OCR text gets the same junk check: an all-failed-pages run must
            // not hand the AI an empty string and silently extract 0 items.
            if (boqExtractor.looksLikeJunkText(documentText)) {
                console.log(`[boq:${userId}] rejected: OCR produced no readable text either`);
                return res.status(422).json({ error: 'This scanned PDF could not be read even with OCR — the pages may be blank, handwritten, or too low-quality. Try the original Excel or Word file.' });
            }
        }
        // (The old hard 60k-character reject lived here. It rejected a real
        // 19-page scanned tender (~84k chars of OCR text) 100% of the time
        // before the AI ever saw it. extractItemsWithAI now chunk-splits ANY
        // size — see boqExtractor.splitIntoChunks — with the chunk CAP as the
        // graceful upper bound, so no pathologically huge document can turn
        // into hundreds of silent AI calls.)

        // The AI phase works against a wall-clock deadline measured from
        // request start — text extraction and DB time are part of the same
        // budget, so per-chunk timeouts shrink to absorb slow parsing.
        const deadlineMs = startedAt + BOQ_TOTAL_BUDGET_MS;
        const items = await extractItemsWithAI(userId, documentText, req.file.originalname, deadlineMs);
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
        const body = { error: error.message };
        // Retry hint + where it failed, so the client can offer a Retry
        // button instead of guessing. Timeout/abort → 504 + retryable;
        // provider 4xx → 502 + permanent.
        if (error.extraction) {
            body.stage = error.extraction.stage;
            body.section = error.extraction.section;
            body.of = error.extraction.of;
            body.retryable = error.extraction.retryable ?? (status === 504);
        }
        res.status(status).json(body);
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
