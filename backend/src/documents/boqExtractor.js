// =============================================================
// Document Intelligence — BOQ / project-requirement extraction.
//
// Text-based AI extraction (BOQs are tabular/text documents, not
// images), reusing the per-user OpenAI-compatible AI service. The
// raw file text is pulled out with:
//   .xlsx  → exceljs (already used for campaign parsing)
//   .docx  → mammoth (plain text extraction)
//   .pdf   → pdf-parse (text layer)
//   .txt/.csv/.md → utf8 decode
//
// All rows belong to the uploading user (user_id on every table row);
// extraction results are persisted so users can revisit past runs.
// =============================================================
const ExcelJS = require('exceljs');

const ITEM_SCHEMA_KEYS = ['product', 'size', 'specification', 'quantity', 'unit', 'application', 'notes'];

// ─── Raw text extraction per format ───────────────────────────

async function extractText(buffer, ext) {
    switch (ext) {
        case '.xlsx': return extractXlsxText(buffer);
        case '.docx': {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer });
            return result.value || '';
        }
        case '.pdf': {
            // pdf-parse v2 exports a PDFParse class; the v1 callable default
            // is gone (calling the module throws "pdfParse is not a function").
            const { PDFParse } = require('pdf-parse');
            const parser = new PDFParse({ data: buffer });
            try {
                const parsed = await parser.getText();
                return parsed.text || '';
            } finally {
                await parser.destroy(); // release the worker thread
            }
        }
        case '.txt':
        case '.md':
        case '.csv':
            return buffer.toString('utf8');
        default:
            throw new Error(`Unsupported document type "${ext}". Upload XLSX, DOCX, PDF, TXT, or CSV.`);
    }
}

async function extractXlsxText(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const lines = [];
    for (const worksheet of workbook.worksheets) {
        worksheet.eachRow({ includeEmpty: false }, (row) => {
            const cells = [];
            row.eachCell({ includeEmpty: true }, (cell) => {
                cells.push(stringifyCell(cell.value));
            });
            // Trim trailing empties but keep interior alignment spaces.
            while (cells.length && !cells[cells.length - 1]) cells.pop();
            if (cells.some((c) => c !== '')) lines.push(cells.join(' | '));
        });
        lines.push(''); // blank line between sheets
    }
    return lines.join('\n').trim();
}

function stringifyCell(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'object') {
        if (typeof value.text === 'string') return value.text;
        if (value.result !== undefined) return String(value.result);
        if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
        return String(value);
    }
    return String(value);
}

// ─── Junk-text detection (scanned-PDF guard) ─────────────────
// pdf-parse never returns '' for a page-image-only PDF: the page
// separators alone ("\n\n-- 1 of 20 --\n\n-- 2 of 20 --") are "non-empty",
// which let marker-only extractions sail past the old !text.trim() guard
// and silently produce 0 items. A real document's text layer is mostly
// alphanumeric; a separator-only one is mostly punctuation/digits of the
// markers themselves.
const JUNK_MIN_ALNUM_RATIO = Number(process.env.BOQ_MIN_ALNUM_RATIO || 0.2);
// Distinct 2+ letter words required to consider text a real document.
const JUNK_MIN_ALPHA_WORDS = 4;

/**
 * Decide whether extracted text is junk — marker/separator output rather
 * than a document. Two signals (a real document trips neither):
 *   1. Content-free or symbol-heavy: no letters at all, or alphanumeric
 *      characters make up too small a share of the non-space text.
 *   2. Word-starved: fewer than a handful of DISTINCT alphabetic words.
 *      This is what actually catches "-- 1 of 20 --" separator runs:
 *      digits and dashes beat a raw ratio check ("of" is alnum), but the
 *      only letter-word on 20 pages of markers is "of" — a real BOQ has
 *      dozens (description, specification, quantity, unit, pipe…).
 */
function looksLikeJunkText(text) {
    const value = String(text || '');
    if (!value.trim()) return true;
    if (!/[a-zA-Z]/.test(value)) return true; // digits+punctuation only → markers, not words
    const chars = value.replace(/\s+/g, '');
    if (!chars.length) return true;
    const alnum = (value.match(/[a-zA-Z0-9]/g) || []).length;
    if ((alnum / chars.length) < JUNK_MIN_ALNUM_RATIO) return true;
    const distinctWords = new Set(
        (value.match(/[a-zA-Z]{2,}/g) || []).map((w) => w.toLowerCase())
    );
    return distinctWords.size < JUNK_MIN_ALPHA_WORDS;
}

// ─── AI extraction ────────────────────────────────────────────

function buildExtractionPrompt(documentText) {
    return `You are extracting line items from a pipe-industry Bill of Quantities (BOQ) or project requirement document. Return ONLY valid JSON, no commentary.

Extract every material line item into this shape:
{"items":[{"product":"","size":"","specification":"","quantity":"","unit":"","application":"","notes":""}]}

Field rules:
- product: pipe/product type (e.g. "HDPE Pipe", "uPVC Pipe", "Ductile Iron Pipe"). Empty if unclear.
- size: diameter/rate size as written (e.g. "6 inch", "110mm", "DN200"). Empty if missing.
- specification: standard or grade (e.g. "IS 4985:2020", "PE100 PN10", "Sch 40"). Empty if missing.
- quantity: numeric quantity only (digits/decimal). Empty if missing or unreadable.
- unit: unit of measure (e.g. "m", "meters", "nos", "kg"). Empty if missing.
- application: stated use (e.g. "water supply", "irrigation"). Empty if missing.
- notes: anything notable (delivery terms, remarks, brand). Empty if missing.
- Keep one entry per table line. Never merge lines. Never invent values — leave a field empty when the document does not state it. Preserve the document's own wording.

DOCUMENT:
${documentText}`;
}

function normalizeResponse(content) {
    // Reasoning models that ignored the "don't think" kwargs open with a
    // ɵink>…</think> preamble. It often CONTAINS JSON-shaped schema text,
    // which defeats the brace-slice fallback below — so it must go before
    // any parsing. A thinking model then degrades to slow-but-correct
    // instead of an unparseable-output 502.
    let text = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
    // Unterminated thinking block (cut off by the token budget): drop
    // everything from the opening tag on — nothing after it can be JSON.
    const unterminated = text.search(/<think>/i);
    if (unterminated >= 0) text = text.slice(0, unterminated);
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
    const attempt = (input) => {
        try { return JSON.parse(input); } catch { return null; }
    };
    let parsed = attempt(String(fenced).trim());
    if (parsed === null) {
        const start = fenced.indexOf('{');
        const end = fenced.lastIndexOf('}');
        if (start >= 0 && end > start) parsed = attempt(fenced.slice(start, end + 1));
    }
    if (parsed === null) throw new Error('The AI did not return structured extraction data. Try again.');
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    return Array.isArray(items) ? items : [];
}

function cleanItem(item) {
    const source = item && typeof item === 'object' ? item : {};
    const cleaned = {};
    for (const key of ITEM_SCHEMA_KEYS) {
        cleaned[key] = String(source[key] ?? '').trim();
    }
    if (source.row_label) cleaned.row_label = String(source.row_label).trim();
    return cleaned;
}

// ─── Row validation / error flagging ──────────────────────────
// Same review-before-confirm philosophy as the Image Extractor: rows are
// editable, and suspicious rows carry warnings inline.

function parseQuantity(raw) {
    const match = String(raw || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return match ? Number(match[0]) : null;
}

function normalizeUnit(unit) {
    const u = String(unit || '').trim().toLowerCase().replace(/\.$/, '');
    if (!u) return '';
    if (/^(m|meter|metre|meters|metres|running.?m|rmt|lm|lin(ear)?\.?\s*m)$/.test(u)) return 'm';
    if (/^(mm|millimeter|millimetre|millimeters|millimetres)$/.test(u)) return 'mm';
    if (/^(ft|feet|foot|fts)$/.test(u)) return 'ft';
    if (/^(nos?|number|numbers|pcs|pieces|piece|ea|each|no\.?)$/.test(u)) return 'nos';
    if (/^(kg|kilogram|kilograms|kgs)$/.test(u)) return 'kg';
    if (/^(ton|tons|tonne|tonnes|mt)$/.test(u)) return 'ton';
    if (/^(set|sets|lot|lots|job|jobs)$/.test(u)) return 'set';
    return u;
}

const SIZE_UNIT_TOKENS = ['mm', 'cm', 'inch', 'inches', 'in', 'dn', 'nb', 'm', 'ft', '"', 'k'];

/**
 * Flag one item. Returns an array of human-readable warnings (empty = clean row).
 * Deliberately rule-based (deterministic + testable): no AI involved.
 */
function flagItem(item, seenKeys, index, allItems) {
    const warnings = [];
    const size = String(item.size || '').trim();
    const quantityRaw = String(item.quantity || '').trim();
    const quantity = parseQuantity(quantityRaw);
    const unit = normalizeUnit(item.unit);

    if (!size) warnings.push('Missing size');
    if (!quantityRaw) {
        warnings.push('Missing quantity');
    } else if (quantity === null) {
        warnings.push(`Quantity "${quantityRaw}" is not a number`);
    } else if (quantity <= 0) {
        warnings.push('Quantity is zero or negative');
    }

    // Unit consistency: same product+size appearing with different units.
    if (size && unit) {
        const key = `${String(item.product || '').trim().toLowerCase()}|${size.toLowerCase()}`;
        const prior = seenKeys.get(key);
        if (prior === undefined) {
            seenKeys.set(key, unit);
        } else if (prior && prior !== unit) {
            warnings.push(`Inconsistent unit for this product+size: "${prior}" earlier vs "${unit}" here`);
        }
    }

    // Duplicate line items: exact product+size+spec match seen before.
    const dupKey = [item.product, item.size, item.specification]
        .map((v) => String(v || '').trim().toLowerCase())
        .join('|');
    if (dupKey !== '||') {
        if (seenKeys.has(`dup:${dupKey}`)) {
            warnings.push('Duplicate line item (same product, size and specification as an earlier row)');
        }
        seenKeys.set(`dup:${dupKey}`, true);
    }

    // Outlier quantity: a quantity more than 100x the median of parseable
    // quantities in this document (needs >= 4 items to be meaningful).
    if (quantity !== null && quantity > 0) {
        const others = allItems
            .filter((_, i) => i !== index)
            .map((it) => parseQuantity(it.quantity))
            .filter((q) => q !== null && q > 0)
            .sort((a, b) => a - b);
        if (others.length >= 3) {
            const mid = Math.floor(others.length / 2);
            const median = others.length % 2 ? others[mid] : (others[mid - 1] + others[mid]) / 2;
            if (median > 0 && quantity > median * 100) {
                warnings.push(`Quantity ${quantity} is over 100x the document median (${median}) — check for a unit or entry error`);
            }
        }
    }

    return warnings;
}

function flagAll(items) {
    const seenKeys = new Map();
    return items.map((item, index) => flagItem(item, seenKeys, index, items));
}

// ─── Document chunking ────────────────────────────────────────
// The extraction AI call has a finite output budget (maxTokens). A real
// BOQ's per-row JSON costs ~80-150 tokens, so a whole 60k-char document
// in one call truncates past ~25 rows and the response stops being valid
// JSON. Splitting the document into bounded chunks (on row boundaries) and
// extracting per-chunk keeps every single AI response well inside budget.

const CHUNK_MAX_CHARS = Number(process.env.BOQ_CHUNK_MAX_CHARS || 12000);

/**
 * Split document text into chunks of at most maxChars, breaking on line
 * boundaries (BOQ rows are one line each) and keeping blank separator
 * lines with the preceding chunk. The first line of each chunk after the
 * first may repeat the previous chunk's last line so column headers are
 * never orphaned at a boundary.
 */
function splitIntoChunks(documentText, maxChars = CHUNK_MAX_CHARS) {
    const text = String(documentText || '');
    if (text.length <= maxChars) return [text];
    const lines = text.split('\n');
    const chunks = [];
    let current = [];
    let length = 0;
    for (const line of lines) {
        // A single overlong line still gets its own chunk (never dropped).
        if (length + line.length + 1 > maxChars && current.length) {
            chunks.push(current.join('\n'));
            // Repeat the previous line into the new chunk so a table
            // header that landed at the end of the last chunk is present.
            current = [current[current.length - 1], line];
            length = current[0].length + line.length + 1;
        } else {
            current.push(line);
            length += line.length + 1;
        }
    }
    if (current.length) chunks.push(current.join('\n'));
    return chunks;
}

module.exports = {
    ITEM_SCHEMA_KEYS,
    looksLikeJunkText,
    CHUNK_MAX_CHARS,
    splitIntoChunks,
    extractText,
    extractXlsxText,
    buildExtractionPrompt,
    normalizeResponse,
    cleanItem,
    parseQuantity,
    normalizeUnit,
    flagItem,
    flagAll,
};
