const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const db = require('../database/db');
const boqExtractor = require('../documents/boqExtractor');
const documentModel = require('../documents/documentModel');
const { respondIfInvalidUpload, validateUploadBuffer } = require('../middleware/fileValidation');
const { aiExtractLimiter } = require('../middleware/rateLimiterMiddleware');
const { resolveAiConfig } = require('../utils/aiConfig');
const { randomUUID } = require('crypto');

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
// The browser allows /boq/process 180s (frontend/src/api.js — the two
// budgets must move together). The WHOLE server pipeline — text
// extraction, OCR (render + parallel NVIDIA batches sharing this same
// deadline) and every AI chunk — is capped at 150s, so the server always
// answers FIRST with a precise error instead of the browser's generic
// timeout. Render itself allows responses up to 100 minutes (verified
// 2026-09 in Render's docs — no short platform proxy ceiling), so this
// pairing is our own UX choice, not a platform constraint.
//
// WHY 150s (2026-09 option-A size-up): real free-tier runs of the
// 19-page tender spent ~80-90s in RENDERING alone (pdfjs+canvas on <1
// CPU, see pdfOcr.js) plus ~9s of NVIDIA calls — the old 90s total
// expired during OCR and the AI phase started with 0s. 150s fits
// render + OCR + AI with margin; the client keeps a 30s window so the
// server's precise 504/502 always beats the browser's generic abort.
const BOQ_TOTAL_BUDGET_MS = Number(process.env.BOQ_TOTAL_BUDGET_MS || 150000);
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
const BOQ_AI_GLOBAL_CONCURRENCY = Math.max(1, Number(process.env.BOQ_AI_GLOBAL_CONCURRENCY || 8));
const BOQ_AI_MAX_PENDING = Math.max(0, Number(process.env.BOQ_AI_MAX_PENDING || 32));
let activeBoqAiCalls = 0;
const pendingBoqAiCalls = [];
const boqJobs = new Map();
// Chunk cap: how many extraction calls one request may make. The old
// formula (budget ÷ min-call floor = 90s/20s = 4) silently regressed the
// size-cap removal — it re-rejected the real 19-page tender at ~48k chars
// with a 413. Extraction now runs in waves of BOQ_AI_CONCURRENCY, so wall
// time is ceil(N/4) × per-call, and the cap is floored at 8 (~96k chars at
// the 12k-char default chunk size — the real 19-page tender needs 7).
const BOQ_MAX_CHUNKS = Number(process.env.BOQ_MAX_CHUNKS)
    || Math.max(8, Math.floor(BOQ_TOTAL_BUDGET_MS / BOQ_AI_MIN_CALL_MS) * BOQ_AI_CONCURRENCY);
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

function createCancellationError() {
    const error = new Error('BOQ extraction was cancelled.');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function acquireBoqAiSlot(signal) {
    if (signal?.aborted) return Promise.reject(createCancellationError());
    if (activeBoqAiCalls < BOQ_AI_GLOBAL_CONCURRENCY && !pendingBoqAiCalls.length) {
        activeBoqAiCalls++;
        return Promise.resolve();
    }
    if (pendingBoqAiCalls.length >= BOQ_AI_MAX_PENDING) {
        return Promise.reject(new Error('BOQ AI capacity is full; this batch was deferred for manual review.'));
    }
    return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, onAbort: null };
        waiter.onAbort = () => {
            const index = pendingBoqAiCalls.indexOf(waiter);
            if (index >= 0) pendingBoqAiCalls.splice(index, 1);
            reject(createCancellationError());
        };
        signal?.addEventListener('abort', waiter.onAbort, { once: true });
        pendingBoqAiCalls.push(waiter);
    });
}

function releaseBoqAiSlot() {
    activeBoqAiCalls--;
    while (pendingBoqAiCalls.length) {
        const waiter = pendingBoqAiCalls.shift();
        waiter.signal?.removeEventListener('abort', waiter.onAbort);
        if (waiter.signal?.aborted) {
            waiter.reject(createCancellationError());
            continue;
        }
        activeBoqAiCalls++;
        waiter.resolve();
        break;
    }
}

async function withBoqAiSlot(task, signal) {
    await acquireBoqAiSlot(signal);
    try {
        if (signal?.aborted) throw createCancellationError();
        return await task();
    } finally {
        releaseBoqAiSlot();
    }
}

function boqJobKey(userId, jobId) {
    return `${userId}:${jobId}`;
}

function publicBoqProgress(job) {
    return {
        ...job.progress,
        jobId: job.jobId,
        activeBatches: [...job.activeBatches].sort((a, b) => a - b),
    };
}

function updateBoqProgress(job, updates = {}) {
    Object.assign(job.progress, updates, { updatedAt: new Date().toISOString() });
    const total = job.progress.totalBatches;
    job.progress.percent = total
        ? Math.min(100, Math.floor((job.progress.completedBatches / total) * 100))
        : 0;
    return publicBoqProgress(job);
}

function createBoqJob(userId, requestedJobId) {
    const jobId = /^[a-zA-Z0-9-]{1,100}$/.test(requestedJobId || '') ? requestedJobId : randomUUID();
    const key = boqJobKey(userId, jobId);
    const existing = boqJobs.get(key);
    if (existing && ['reading', 'extracting', 'cancelling'].includes(existing.progress.status)) return null;
    const job = {
        userId,
        jobId,
        key,
        controller: new AbortController(),
        activeBatches: new Set(),
        progress: {
            status: 'reading',
            totalBatches: 0,
            completedBatches: 0,
            currentBatch: 0,
            totalSourceRows: 0,
            handledRows: 0,
            reviewCount: 0,
            percent: 0,
            documentId: null,
            updatedAt: new Date().toISOString(),
        },
    };
    boqJobs.set(key, job);
    const expiry = setTimeout(() => {
        if (boqJobs.get(key) === job) boqJobs.delete(key);
    }, 10 * 60 * 1000);
    expiry.unref?.();
    return job;
}

function startBoqBatch(job, batchNumber) {
    if (job.controller.signal.aborted) return false;
    job.activeBatches.add(batchNumber);
    updateBoqProgress(job, {
        status: 'extracting',
        currentBatch: batchNumber,
        activeBatches: [...job.activeBatches],
    });
    return true;
}

function finishBoqBatch(job, batchNumber, rowCount, failed) {
    job.activeBatches.delete(batchNumber);
    updateBoqProgress(job, {
        completedBatches: job.progress.completedBatches + 1,
        handledRows: Math.min(job.progress.totalSourceRows, job.progress.handledRows + rowCount),
        reviewCount: job.progress.reviewCount + (failed ? rowCount : 0),
        activeBatches: [...job.activeBatches],
    });
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
async function extractItemsWithAI(userId, documentText, filename = 'document', deadlineMs = 0, job) {
    const { aiConfig, model, aiService } = await loadExtractionClient(userId);

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
    // OCR text blew the old 90s budget), while waves bound provider
    // rate-limit exposure. Every result lands in its own slot, so the merge
    // below is always in page order no matter which wave finishes first.
    //
    // WAVE-AWARE FAIR SHARE (2026-09 fix): a wave of 4 chunks runs its
    // members CONCURRENTLY, so the wave costs ~ONE per-call latency, not
    // four. The original sequential formula (remaining ÷ chunksLeft) gave
    // every call remaining/N — on the real tender that was ~7s per call,
    // far under what a 12k-char chunk needs, and every chunk timed out.
    // A call's timeout must instead divide what is left by the number of
    // REMAINING WAVES: ceil(chunksLeft / BOQ_AI_CONCURRENCY). Two waves of
    // 4 split 56s into 28s each — a real attempt, still bounded by the
    // per-call ceiling.
    const results = new Array(chunks.length).fill(null);
    const failed = new Array(chunks.length).fill(null);
    const runChunk = async (i) => {
        const chunkStart = Date.now();
        const batchNumber = i + 1;
        if (!startBoqBatch(job, batchNumber)) return;
        const sourceLines = chunks[i].split('\n').filter((line) => line.trim() && !boqExtractor.isPageBreak(line)).length;
        const chunksLeft = chunks.length - i; // chunks i+1.. have not started yet
        // The wave this chunk belongs to and how many waves remain AFTER it.
        // Waves, not chunks, are what serially consume the wall clock.
        const wavesLeft = Math.max(1, Math.ceil(chunksLeft / BOQ_AI_CONCURRENCY));
        const remaining = deadlineMs ? deadlineMs - Date.now() : BOQ_TOTAL_BUDGET_MS;
        if (deadlineMs && remaining <= 0) {
            const exhausted = new Error(`The AI extraction budget ran out before section ${i + 1} of ${chunks.length} of "${filename}" could be attempted.`);
            exhausted.statusCode = 504;
            exhausted.extraction = { stage: 'ai_extraction', section: i + 1, of: chunks.length, retryable: true };
            failed[i] = exhausted;
            finishBoqBatch(job, batchNumber, sourceLines, true);
            return;
        }
        // Fair share of what is left, clamped to the per-call ceiling. A
        // 1-chunk document effectively gets the whole remaining budget.
        const perCallMs = deadlineMs
            ? Math.max(100, Math.min(BOQ_AI_MAX_CALL_MS, Math.floor(remaining / wavesLeft)))
            : BOQ_AI_MAX_CALL_MS;
        console.log(`[boq:${userId}] AI chunk ${i + 1}/${chunks.length} starting (${chunks[i].length} chars, budget ${Math.round(remaining / 1000)}s left, per-call timeout ${Math.round(perCallMs / 1000)}s, model ${model || 'default'})`);
        let content;
        try {
            content = await withBoqAiSlot(() => aiService._complete(
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
                    signal: job.controller.signal,
                    logLabel: `boq chunk ${i + 1}/${chunks.length}`,
                }
            ), job.controller.signal);
        } catch (error) {
            if (job.controller.signal.aborted) {
                failed[i] = createCancellationError();
                finishBoqBatch(job, batchNumber, sourceLines, true);
                return;
            }
            const mapped = mapExtractionStatus(error);
            console.error(`[boq:${userId}] AI chunk ${i + 1}/${chunks.length} FAILED after ${Date.now() - chunkStart}ms (attempt(s): ${error.attempts || 1}, kind ${error.aiKind || 'unknown'}${error.providerStatus ? `, provider HTTP ${error.providerStatus}` : ''}${error.providerRequestId ? `, req-id ${error.providerRequestId}` : ''}): ${error.message}${error.providerBody ? ` | provider body: ${error.providerBody}` : ''}`);
            error.message = `Section ${i + 1} of ${chunks.length} of "${filename}" could not be extracted: ${error.message}`;
            error.statusCode = mapped.status;
            error.extraction = { stage: 'ai_extraction', section: i + 1, of: chunks.length, retryable: mapped.retryable };
            failed[i] = error;
            finishBoqBatch(job, batchNumber, sourceLines, true);
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
            finishBoqBatch(job, batchNumber, sourceLines, true);
            return;
        }
        console.log(`[boq:${userId}] AI chunk ${i + 1}/${chunks.length} completed in ${Date.now() - chunkStart}ms → ${chunkItems.length} item(s)`);
        results[i] = chunkItems;
        finishBoqBatch(job, batchNumber, sourceLines, false);
    };
    for (let waveStart = 0; waveStart < chunks.length; waveStart += BOQ_AI_CONCURRENCY) {
        if (job.controller.signal.aborted) break;
        const wave = [];
        for (let i = waveStart; i < Math.min(chunks.length, waveStart + BOQ_AI_CONCURRENCY); i++) wave.push(i);
        const waveStartMs = Date.now();
        // runChunk never throws (failures land in failed[i]); Promise.all
        // just waits for the wave. Waves run strictly in order so the
        // chunksLeft share math stays the same as the sequential form.
        await Promise.all(wave.map((i) => runChunk(i)));
        console.log(`[boq:${userId}] AI wave done in ${Date.now() - waveStartMs}ms (${wave.length} chunk(s), remaining ${Math.round((deadlineMs ? deadlineMs - Date.now() : BOQ_TOTAL_BUDGET_MS) / 1000)}s)`);
    }
    if (job.controller.signal.aborted) {
        for (let index = 0; index < chunks.length; index++) {
            if (job.activeBatches.has(index + 1) || results[index] || failed[index]) continue;
            failed[index] = createCancellationError();
            const sourceLines = chunks[index].split('\n').filter((line) => line.trim() && !boqExtractor.isPageBreak(line)).length;
            updateBoqProgress(job, {
                handledRows: Math.min(job.progress.totalSourceRows, job.progress.handledRows + sourceLines),
                reviewCount: job.progress.reviewCount + sourceLines,
            });
        }
        return results.flatMap((chunkItems) => chunkItems || []);
    }
    // One failure sinks the run with the FIRST (lowest-section) error so
    // messages stay deterministic and correctly attributed.
    const firstFailure = failed.find(Boolean);
    if (firstFailure) throw firstFailure;

    return results.flatMap((chunkItems) => chunkItems || []);
}

async function loadExtractionClient(userId) {
    const rows = await loadUserSettings(userId);
    const aiConfig = resolveAiConfig({
        storedKey: rows.AI_API_KEY,
        storedBaseURL: rows.AI_BASE_URL,
        ...resolveDocIntelServerConfig(),
    });
    if (!aiConfig.apiKey) throw new Error('AI is not configured. Set AI_API_KEY on the server or in Settings.');
    return { aiConfig, model: resolveDocIntelModel(rows.AI_MODEL), aiService: require('../ai/aiService') };
}

async function extractStructuredTableWithAI(userId, table, entries, filename, deadlineMs, job, batchOffset = 0) {
    if (!entries.length) return [];
    const { aiConfig, model, aiService } = await loadExtractionClient(userId);
    const groups = boqExtractor.splitStructuredRowBatches(entries, undefined, undefined, table.headers || []);
    if (groups.length > BOQ_MAX_CHUNKS) {
        const error = new Error(`Document is too large to extract in one request (${groups.length} table sections, max ${BOQ_MAX_CHUNKS}). Split it into smaller parts and upload each separately.`);
        error.statusCode = 413;
        throw error;
    }
    const results = new Array(groups.length).fill(null);
    const failures = new Array(groups.length).fill(null);
    const started = new Set();
    const runGroup = async (index) => {
        const group = groups[index];
        const batchNumber = batchOffset + index + 1;
        const expectedRowIds = group.map((entry) => entry.item.lineItemId);
        if (!startBoqBatch(job, batchNumber)) {
            failures[index] = createCancellationError();
            return;
        }
        started.add(index);
        const batchCharLimit = Number(process.env.BOQ_STRUCTURED_BATCH_MAX_CHARS || 12000);
        if (group.length > Number(process.env.BOQ_STRUCTURED_BATCH_MAX_ROWS || 40)
            || boqExtractor.estimateBatchChars(group, table.headers || []) > batchCharLimit) {
            failures[index] = new Error(`Source batch ${index + 1} exceeds the configured row/character limit and was retained for review without sending an oversized prompt.`);
            finishBoqBatch(job, batchNumber, group.length, true);
            return;
        }
        const chunksLeft = groups.length - index;
        const wavesLeft = Math.max(1, Math.ceil(chunksLeft / BOQ_AI_CONCURRENCY));
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) {
            const error = new Error(`The AI extraction budget ran out before section ${index + 1} of ${groups.length} of "${filename}" could be attempted.`);
            error.statusCode = 504;
            error.extraction = { stage: 'ai_extraction', section: index + 1, of: groups.length, retryable: true };
            failures[index] = error;
            finishBoqBatch(job, batchNumber, group.length, true);
            return;
        }
        const timeoutMs = Math.max(100, Math.min(BOQ_AI_MAX_CALL_MS, Math.floor(remaining / wavesLeft)));
        const callGroup = async () => {
            const attemptRemaining = deadlineMs - Date.now();
            if (attemptRemaining <= 0) throw Object.assign(new Error('The shared AI extraction deadline expired.'), { aiKind: 'timeout' });
            const content = await withBoqAiSlot(() => aiService._complete(
                [{ role: 'user', content: boqExtractor.buildStructuredExtractionPrompt(table, group) }],
                {
                    apiKey: aiConfig.apiKey,
                    baseURL: aiConfig.baseURL,
                    model,
                    temperature: 0.1,
                    maxTokens: 8000,
                    timeoutMs: Math.min(timeoutMs, attemptRemaining),
                    deadlineMs,
                    minAttemptMs: BOQ_AI_MIN_CALL_MS,
                    retries: 0,
                    reasoningEffort: 'none',
                    signal: job.controller.signal,
                    logLabel: `boq structured ${index + 1}/${groups.length}`,
                }
            ), job.controller.signal);
            return boqExtractor.validateStructuredBatchResponse(content, expectedRowIds);
        };
        try {
            results[index] = await callGroup();
        } catch (error) {
            if (job.controller.signal.aborted) {
                failures[index] = createCancellationError();
                finishBoqBatch(job, batchNumber, group.length, true);
                return;
            }
            try {
                results[index] = await callGroup();
            } catch (retryError) {
                if (job.controller.signal.aborted) {
                    failures[index] = createCancellationError();
                    finishBoqBatch(job, batchNumber, group.length, true);
                    return;
                }
                const mapped = mapExtractionStatus(retryError);
                const wrapped = retryError instanceof Error ? retryError : new Error(String(retryError));
                wrapped.message = `Section ${index + 1} of ${groups.length} of "${filename}" returned malformed or untrusted AI output; this batch was marked for review instead of failing the entire BOQ: ${wrapped.message}`;
                wrapped.statusCode = mapped.status;
                wrapped.extraction = { stage: 'ai_extraction', section: index + 1, of: groups.length, retryable: mapped.retryable };
                failures[index] = wrapped;
                results[index] = null;
            }
        }
        finishBoqBatch(job, batchNumber, group.length, Boolean(failures[index]));
    };
    for (let waveStart = 0; waveStart < groups.length; waveStart += BOQ_AI_CONCURRENCY) {
        if (job.controller.signal.aborted) break;
        await Promise.all(Array.from(
            { length: Math.min(BOQ_AI_CONCURRENCY, groups.length - waveStart) },
            (_, offset) => runGroup(waveStart + offset)
        ));
    }
    if (job.controller.signal.aborted) {
        for (let index = 0; index < groups.length; index++) {
            if (started.has(index)) continue;
            failures[index] = createCancellationError();
            updateBoqProgress(job, {
                handledRows: Math.min(job.progress.totalSourceRows, job.progress.handledRows + groups[index].length),
                reviewCount: job.progress.reviewCount + groups[index].length,
            });
        }
    }
    return groups.flatMap((group, groupIndex) => {
        const derived = results[groupIndex] || [];
        const failure = failures[groupIndex];
        const byId = new Map(derived.filter((item) => item?.rowId != null).map((item) => [String(item.rowId), item]));
        return group.map((entry, index) => {
            const enrichment = byId.get(String(entry.item.lineItemId))
                || null;
            const fallbackWarnings = [
                ...(failure ? [`AI batch review required: ${failure.message}`] : []),
                ...(enrichment ? [] : ['AI enrichment could not be matched to this source row.']),
            ];
            return documentModel.mergeDerivedFields(entry.item, enrichment || {
                warnings: fallbackWarnings,
            });
        });
    });
}

// POST /api/boq/process — upload a requirement document, extract text,
// run AI extraction, flag suspicious rows, and store everything for review.
router.post('/process', aiExtractLimiter, upload.single('file'), async (req, res) => {
    const startedAt = Date.now();
    const userId = req.user?.id;
    if (!req.file) return res.status(400).json({ error: 'Upload an XLSX, DOCX, PDF, TXT, or CSV document.' });
    if (!respondIfInvalidUpload(req, res)) return;

    const requestedJobId = req.get?.('x-boq-job-id') || req.headers?.['x-boq-job-id'];
    const job = createBoqJob(userId, requestedJobId);
    if (!job) return res.status(409).json({ error: 'A BOQ extraction with this job ID is already active.' });
    const markDisconnected = () => {
        if (!job.controller.signal.aborted) {
            updateBoqProgress(job, { status: 'cancelling' });
            job.controller.abort();
        }
    };
    req.on?.('aborted', markDisconnected);
    res.on?.('close', () => {
        if (!res.writableEnded) markDisconnected();
    });

    const ext = extOf(req.file.originalname);
    console.log(`[boq:${userId}] process START: "${req.file.originalname}" (${req.file.size} bytes, ${ext})`);
    try {
        const textStart = Date.now();
        let document = await boqExtractor.parseDocument(req.file.buffer, ext, req.file.originalname);
        if (job.controller.signal.aborted) {
            updateBoqProgress(job, { status: 'cancelled' });
            if (!res.destroyed && !res.writableEnded) res.status(499).json({ error: 'BOQ extraction cancelled.' });
            return;
        }
        let documentText = document.rawText || '';
        const lineCount = documentText.split('\n').filter((l) => l.trim()).length;
        console.log(`[boq:${userId}] text extraction done in ${Date.now() - textStart}ms: ${documentText.length} chars / ${lineCount} non-empty lines`);
        let usedVisualOcr = false;

        // Junk-text guard: a scanned/image-only PDF still yields "text" from
        // pdf-parse — the page separators alone ("-- 1 of 20 --") are
        // non-empty — so emptiness is not the test. If what came out is
        // marker-only junk AND this is a PDF, run the OCR pipeline (render
        // pages → NVIDIA Nemotron OCR → concatenated text) and continue with
        // that instead. Non-PDF junk is still a clear rejection.
        let usedOcr = false; // becomes true only if the OCR path produced the text
        if (ext === '.pdf' && !(document.tables || []).length && !boqExtractor.looksLikeJunkText(documentText)) {
            const pageNumbers = documentModel.findVisualTablePages(document.pages || []);
            if (pageNumbers.length) {
                try {
                    const visual = await require('../documents/pdfOcr').ocrNativePdfPages(
                        req.file.buffer,
                        userId,
                        pageNumbers,
                        { deadlineMs: startedAt + BOQ_TOTAL_BUDGET_MS, signal: job.controller.signal }
                    );
                    if (job.controller.signal.aborted) {
                        updateBoqProgress(job, { status: 'cancelled' });
                        if (!res.destroyed && !res.writableEnded) res.status(499).json({ error: 'BOQ extraction cancelled.' });
                        return;
                    }
                    const visualTables = documentModel.reconstructTablesFromLayoutPages(visual.pages);
                    if (visualTables.length) {
                        const visualByPage = new Map(visual.pages.map((page) => [page.page, page]));
                        document.pages = (document.pages || []).map((page) => ({
                            ...page,
                            ...(visualByPage.get(page.page) || {}),
                            text: page.text,
                        }));
                        document.tables = visualTables;
                        usedVisualOcr = true;
                        console.log(`[boq:${userId}] visual PDF table reconstruction found ${visualTables.length} table(s) across ${visual.pages.length} rendered page(s)`);
                    } else {
                        console.log(`[boq:${userId}] visual PDF pass found no header-aligned table; retaining text fallback`);
                    }
                } catch (visualError) {
                    if (job.controller.signal.aborted) {
                        updateBoqProgress(job, { status: 'cancelled' });
                        if (!res.destroyed && !res.writableEnded) res.status(499).json({ error: 'BOQ extraction cancelled.' });
                        return;
                    }
                    console.warn(`[boq:${userId}] visual PDF table pass failed; retaining text fallback: ${visualError.message}`);
                }
            }
        }
        if (boqExtractor.looksLikeJunkText(documentText)) {
            console.log(`[boq:${userId}] junk text detected (${documentText.trim().length} chars, alnum-starved) — scanned/image-only document?`);
            if (ext !== '.pdf') {
                console.log(`[boq:${userId}] rejected: no readable text in a non-PDF document`);
                updateBoqProgress(job, { status: 'failed' });
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
                    signal: job.controller.signal,
                });
                if (job.controller.signal.aborted) {
                    updateBoqProgress(job, { status: 'cancelled' });
                    if (!res.destroyed && !res.writableEnded) res.status(499).json({ error: 'BOQ extraction cancelled.' });
                    return;
                }
                documentText = ocr.text;
                document.pages = ocr.pages?.length ? ocr.pages : documentText
                    .split(/(?=^\s*-{2,}\s*\d+(?:\s+of\s+\d+)?\s*-{2,}\s*$)/m)
                    .filter((text) => text.trim())
                    .map((text, index) => ({ page: index + 1, text }));
                const pageMatrices = document.pages.map((page) => {
                    const layoutMatrix = (page.rows || []).map((row) => row.map((cell) => cell.text));
                    const hasCellLayout = layoutMatrix.some((row) => row.length > 1);
                    return {
                        page: page.page,
                        matrix: hasCellLayout ? layoutMatrix : boqExtractor.matrixFromDelimitedText(page.text || ''),
                    };
                });
                document.tables = documentModel.extractTablesAcrossPages(pageMatrices);
                usedOcr = true;
                console.log(`[boq:${userId}] OCR fallback produced ${documentText.trim().length} chars in ${Date.now() - ocrStart}ms (cap ${BOQ_OCR_MAX_PAGES} pages, ${ocr.failedPages.length} failed page(s))`);
            } catch (ocrError) {
                if (job.controller.signal.aborted) {
                    updateBoqProgress(job, { status: 'cancelled' });
                    if (!res.destroyed && !res.writableEnded) res.status(499).json({ error: 'BOQ extraction cancelled.' });
                    return;
                }
                const status = ocrError.statusCode || 502;
                console.error(`[boq:${userId}] OCR fallback FAILED after ${Date.now() - ocrStart}ms (HTTP ${status}): ${ocrError.message}`);
                // Forward retry/stage hints (deadline timeouts are usually
                // transient) so the UI can offer a Retry button instead of
                // a generic failure.
                const body = { error: ocrError.message };
                if (typeof ocrError.retryable === 'boolean') body.retryable = ocrError.retryable;
                if (ocrError.extraction?.stage) body.stage = ocrError.extraction.stage;
                updateBoqProgress(job, { status: 'failed' });
                return res.status(status).json(body);
            }
            // OCR text gets the same junk check: an all-failed-pages run must
            // not hand the AI an empty string and silently extract 0 items.
            if (boqExtractor.looksLikeJunkText(documentText)) {
                console.log(`[boq:${userId}] rejected: OCR produced no readable text either`);
                updateBoqProgress(job, { status: 'failed' });
                return res.status(422).json({ error: 'This scanned PDF could not be read even with OCR — the pages may be blank, handwritten, or too low-quality. Try the original Excel or Word file.' });
            }
        }
        // (The old hard 60k-character reject lived here. It rejected a real
        // 19-page scanned tender (~84k chars of OCR text) 100% of the time
        // before the AI ever saw it. extractItemsWithAI now chunk-splits ANY
        // size — see boqExtractor.splitIntoChunks — with the chunk CAP as the
        // graceful upper bound, so no pathologically huge document can turn
        // into hundreds of silent AI calls.)

        // HONEST BUDGET GUARD (2026-09): OCR deliberately runs to a bounded
        // conclusion inside the shared deadline ("once OCR starts it is
        // allowed to run to its bounded conclusion"), which means OCR can
        // legitimately consume the WHOLE budget — real free-tier runs: ~80s
        // rendering 19 pages (pdfjs+canvas on <1 CPU) + ~9s of NVIDIA calls
        // vs the 90s total. Attempting the AI phase with ~0s left produced
        // the opaque "wall budget 0s of 90s" log and a confusing 504 two
        // lines later. Fail HERE instead, honestly: the text was read, only
        // the shared wall clock ran out. Threshold 1500ms: below it, not
        // even one chunk attempt (min per-call share 100ms, floor 20s) can
        // meaningfully run, so starting the phase would be theater.
        const budgetLeftMs = startedAt + BOQ_TOTAL_BUDGET_MS - Date.now();
        if (budgetLeftMs <= 1500) {
            const error = usedOcr
                ? 'All pages were read successfully, but the request ran out of time before AI extraction could start — reading the scanned pages took the whole budget. Please retry; if this keeps happening for this document, extraction needs to run in the background.'
                : 'The request ran out of its time budget before AI extraction could start. Please retry.';
            console.error(`[boq:${userId}] budget exhausted after ${Date.now() - startedAt}ms with ${documentText.length} chars in hand (${usedOcr ? 'OCR path' : 'direct-text path'}): ${Math.round(budgetLeftMs)}ms left — AI extraction cannot start inside this request, failing fast instead of a "0s of 90s" wave`);
            updateBoqProgress(job, { status: 'failed' });
            return res.status(504).json({ error, retryable: true, stage: 'budget_exhausted_before_ai' });
        }

        // The AI phase works against a wall-clock deadline measured from
        // request start — text extraction and DB time are part of the same
        // budget, so per-chunk timeouts shrink to absorb slow parsing.
        const deadlineMs = startedAt + BOQ_TOTAL_BUDGET_MS;
        let items = [];
        const structuredTables = (document.tables || []).filter((table) => table.rows?.length);
        const structuredEntries = structuredTables.map((table) => table.rows.map((row) => ({
            row,
            item: documentModel.lineItemFromRow({
                headers: table.headers,
                row: row.cells,
                source: row.source || table.source,
                filename: req.file.originalname,
                headerMap: {
                    columns: table.columnMap || documentModel.mapHeaders(table.headers).columns,
                    ambiguous: table.ambiguousHeaders || {},
                },
            }),
        })));
        const batchCounts = structuredTables.map((table, index) =>
            boqExtractor.splitStructuredRowBatches(structuredEntries[index], undefined, undefined, table.headers || []).length
        );
        const textChunks = structuredTables.length ? [] : boqExtractor.splitIntoChunks(documentText);
        updateBoqProgress(job, {
            status: 'extracting',
            totalBatches: structuredTables.length ? batchCounts.reduce((sum, count) => sum + count, 0) : textChunks.length,
            totalSourceRows: structuredTables.length
                ? structuredEntries.reduce((sum, entries) => sum + entries.length, 0)
                : lineCount,
        });
        if (structuredTables.length) {
            let batchOffset = 0;
            for (let index = 0; index < structuredTables.length; index++) {
                const table = structuredTables[index];
                const entries = structuredEntries[index];
                if (job.controller.signal.aborted) {
                    const message = 'Extraction cancelled before this source batch was attempted; verify this row during review.';
                    items.push(...entries.map((entry) => documentModel.mergeDerivedFields(entry.item, { warnings: [message] })));
                    updateBoqProgress(job, {
                        handledRows: job.progress.handledRows + entries.length,
                        reviewCount: job.progress.reviewCount + entries.length,
                    });
                    batchOffset += batchCounts[index];
                    continue;
                }
                items.push(...await extractStructuredTableWithAI(
                    userId,
                    table,
                    entries,
                    req.file.originalname,
                    deadlineMs,
                    job,
                    batchOffset
                ));
                batchOffset += batchCounts[index];
            }
        } else {
            const extracted = await extractItemsWithAI(userId, documentText, req.file.originalname, deadlineMs, job);
            items = extracted.map((item, index) => ({
                ...boqExtractor.cleanItem(item),
                lineItemId: `${req.file.originalname}:text:${index + 1}`,
                serialNumber: item.serialNumber ?? null,
                itemCode: item.itemCode ?? null,
                description: item.description ?? null,
                sourceValues: {},
                provenance: { document: req.file.originalname, page: null, table: null, row: null, columns: {} },
                confidence: item.confidence || {},
                warnings: Array.isArray(item.warnings) ? item.warnings : [],
            }));
        }
        if (job.controller.signal.aborted && !items.length) {
            updateBoqProgress(job, { status: 'cancelled' });
            if (!res.destroyed && !res.writableEnded) res.status(499).json({ error: 'BOQ extraction cancelled before any rows could be retained.' });
            return;
        }
        const wasCancelled = job.controller.signal.aborted;
        const warnings = boqExtractor.flagAll(items);
        const extractionMetadata = {
            version: 1,
            processingStatus: wasCancelled ? 'cancelled' : 'completed',
            documentType: structuredTables.length ? 'boq_table' : 'requirements_text',
            format: ext,
            strategy: structuredTables.length
                ? (usedVisualOcr ? 'pdf_visual_tables' : usedOcr ? 'ocr_tables' : 'structured_tables')
                : 'text_fallback',
            pageCount: document.pages?.length || null,
            sheetCount: document.sheets?.length || null,
            ...document.metadata,
            pages: document.pages || [],
            sheets: (document.sheets || []).map((sheet) => ({ name: sheet.name, tables: sheet.tables || [] })),
            tables: structuredTables,
        };

        const dbStart = Date.now();
        const created = await db.insert('boq_documents', {
            filename: req.file.originalname,
            file_ext: ext,
            document_text: documentText,
            extraction_metadata: extractionMetadata,
            status: 'review',
            items: JSON.stringify(items),
            warnings: JSON.stringify(warnings),
            user_id: req.user.id,
        });
        if (job.controller.signal.aborted && !wasCancelled) {
            extractionMetadata.processingStatus = 'cancelled';
            created.status = 'review';
            created.extraction_metadata = extractionMetadata;
            await db.update('boq_documents', {
                status: 'review',
                extraction_metadata: extractionMetadata,
            }, 'id = ? AND user_id = ?', [created.id, userId]);
        }

        const warnRows = warnings.filter((w) => Array.isArray(w) && w.length).length;
        updateBoqProgress(job, {
            status: job.controller.signal.aborted ? 'cancelled' : 'completed',
            documentId: created?.id ?? null,
            handledRows: job.controller.signal.aborted ? job.progress.handledRows : job.progress.totalSourceRows,
            reviewCount: Math.max(job.progress.reviewCount, warnRows),
            completedBatches: job.controller.signal.aborted ? job.progress.completedBatches : job.progress.totalBatches,
        });
        console.log(`[boq:${userId}] process ${job.controller.signal.aborted ? 'CANCELLED' : 'COMPLETE'} in ${Date.now() - startedAt}ms: ${items.length} item(s), ${warnRows} row(s) flagged, saved as #${created?.id ?? '?'} (db ${Date.now() - dbStart}ms)`);
        res.status(201).json(serializeDoc(created));
    } catch (error) {
        if (job.controller.signal.aborted) {
            updateBoqProgress(job, { status: 'cancelled' });
            if (!res.destroyed && !res.writableEnded) res.status(499).json({ error: 'BOQ extraction cancelled.' });
            return;
        }
        updateBoqProgress(job, { status: 'failed' });
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

router.get('/progress/:jobId', (req, res) => {
    const job = boqJobs.get(boqJobKey(req.user.id, req.params.jobId));
    if (!job) return res.status(404).json({ error: 'BOQ extraction progress not found.' });
    res.set?.('Cache-Control', 'no-store');
    res.json(publicBoqProgress(job));
});

router.delete('/progress/:jobId', (req, res) => {
    const job = boqJobs.get(boqJobKey(req.user.id, req.params.jobId));
    if (!job) return res.status(404).json({ error: 'BOQ extraction progress not found.' });
    if (!['completed', 'cancelled', 'failed'].includes(job.progress.status)) {
        updateBoqProgress(job, { status: 'cancelling' });
        job.controller.abort();
    }
    res.json(publicBoqProgress(job));
});

// GET /api/boq — this user's processed documents (history).
router.get('/', async (req, res) => {
    try {
        const rows = await db.select(
            'boq_documents',
            'id, filename, file_ext, status, items, warnings, extraction_metadata, created_at',
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
        'Product': item.product || item.description || '',
        'Size': item.size || '',
        'Specification': item.specification || '',
        'Quantity': item.quantity ?? '',
        'Unit': item.unit || '',
        'Application / Remarks': [item.application, item.notes || item.remarks].filter(Boolean).join(' — '),
    }));
}

function requireConfirmedDocument(doc, res) {
    if (doc.status === 'confirmed') return false;
    res.status(409).json({ error: 'Confirm the requirement sheet before exporting an RFQ.' });
    return true;
}

router.get('/:id/export/excel', async (req, res) => {
    try {
        const doc = await db.getById('boq_documents', req.params.id, req.user.id);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });
        if (requireConfirmedDocument(doc, res)) return;
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

    const pageContents = [[]];
    let y = pageHeight - margin;
    for (const line of lines) {
        const fontSize = line.bold ? 16 : 10;
        for (const piece of wrap(line.text, fontSize)) {
            if (y < margin) {
                pageContents.push([]);
                y = pageHeight - margin;
                pageContents[pageContents.length - 1].push(`BT /F2 12 Tf ${margin} ${y} Td (REQUEST FOR QUOTATION - continued) Tj ET`);
                y -= lineHeight;
            }
            const font = line.bold ? '/F2' : '/F1';
            pageContents[pageContents.length - 1].push(`BT ${font} ${fontSize} Tf ${margin} ${y} Td (${escapePdfText(piece)}) Tj ET`);
            y -= lineHeight;
        }
    }
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    ];
    const pageReferences = [];
    for (const pageLines of pageContents) {
        const pageObjectNumber = objects.length + 1;
        const contentObjectNumber = pageObjectNumber + 1;
        pageReferences.push(`${pageObjectNumber} 0 R`);
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`);
        const content = pageLines.join('\n');
        objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    }
    objects[1] = `<< /Type /Pages /Kids [${pageReferences.join(' ')}] /Count ${pageContents.length} >>`;
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
        if (requireConfirmedDocument(doc, res)) return;
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
    let extractionMetadata = doc.extraction_metadata || {};
    if (typeof extractionMetadata === 'string') {
        try { extractionMetadata = JSON.parse(extractionMetadata); } catch { extractionMetadata = {}; }
    }
    return {
        ...doc,
        items: parseJsonArray(doc.items),
        warnings: parseJsonArray(doc.warnings),
        extraction_metadata: extractionMetadata,
    };
}

module.exports = { router, buildRfqPdf, rfqRows, sanitizeFilename };
