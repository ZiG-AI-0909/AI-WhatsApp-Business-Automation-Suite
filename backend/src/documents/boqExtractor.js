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
const documentModel = require('./documentModel');

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

async function parseXlsxDocument(buffer, filename) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheets = [];
    const tables = [];
    const textLines = [];
    for (const worksheet of workbook.worksheets) {
        const matrix = Array.from({ length: worksheet.rowCount }, () => []);
        worksheet.eachRow({ includeEmpty: true }, (row) => {
            const values = [];
            for (let column = 1; column <= worksheet.columnCount; column++) {
                const cell = row.getCell(column);
                values.push(cell.isMerged && cell.master.address !== cell.address ? '' : stringifyCell(cell.value));
            }
            matrix[row.number - 1] = values;
            if (values.some((value) => value !== '')) textLines.push(values.join(' | '));
        });
        const sheetTables = documentModel.extractTablesFromMatrix(matrix, { sheet: worksheet.name });
        sheets.push({ name: worksheet.name, rows: matrix, merges: worksheet.model.merges || [], tables: sheetTables });
        tables.push(...sheetTables);
        textLines.push('');
    }
    return documentModel.createDocument({
        filename,
        fileExt: '.xlsx',
        rawText: textLines.join('\n').trim(),
        sheets,
        tables,
    });
}

function parseCsvText(text) {
    const delimiters = [',', ';', '\t', '|'];
    const input = String(text || '');
    const { parse } = require('csv-parse/sync');
    let delimiter = ',';
    let widestFirstRecord = 0;
    for (const candidate of delimiters) {
        try {
            const firstRecord = parse(input, {
                bom: true,
                delimiter: candidate,
                relax_quotes: true,
                to_line: 1,
            })[0] || [];
            if (firstRecord.length > widestFirstRecord) {
                widestFirstRecord = firstRecord.length;
                delimiter = candidate;
            }
        } catch {
            // A candidate delimiter can be invalid for malformed CSV; try the others.
        }
    }
    const rows = parse(input, {
        bom: true,
        delimiter,
        relax_column_count: true,
        skip_empty_lines: true,
    });
    return { delimiter, rows };
}

function decodeHtmlEntities(value) {
    return String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, token) => {
        const normalized = token.toLowerCase();
        if (normalized[0] === '#') {
            const code = normalized[1] === 'x' ? parseInt(normalized.slice(2), 16) : parseInt(normalized.slice(1), 10);
            try { return String.fromCodePoint(code); } catch { return entity; }
        }
        return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[normalized] || entity;
    });
}

function htmlCellText(html) {
    return decodeHtmlEntities(String(html || '')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/(?:p|div|li)>/gi, '\n')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .trim());
}

function parseDocxTables(html) {
    const tables = [];
    for (const tableMatch of String(html || '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
        const matrix = [];
        for (const rowMatch of tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
            const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)]
                .map((cell) => htmlCellText(cell[1]));
            if (cells.length) matrix.push(cells);
        }
        tables.push(...documentModel.extractTablesFromMatrix(matrix, { table: tables.length + 1 }));
    }
    return tables;
}

function matrixFromDelimitedText(text) {
    return String(text || '').split(/\r?\n/).map((line) => {
        if (line.includes('\t')) return line.split('\t').map((cell) => cell.trim());
        if (line.includes('|')) return line.split('|').map((cell) => cell.trim());
        return [line];
    });
}

function delimitedTablesFromText(text, location = {}) {
    const matrix = matrixFromDelimitedText(text);
    return documentModel.extractTablesFromMatrix(matrix, location);
}

async function parseDocument(buffer, ext, filename = '') {
    const normalizedExt = String(ext || '').toLowerCase();
    if (normalizedExt === '.xlsx') return parseXlsxDocument(buffer, filename);
    if (normalizedExt === '.csv') {
        const rawText = buffer.toString('utf8');
        const parsed = parseCsvText(rawText);
        const tables = documentModel.extractTablesFromMatrix(parsed.rows, { table: 1 });
        return documentModel.createDocument({
            filename, fileExt: normalizedExt, rawText,
            sheets: [{ name: 'CSV', rows: parsed.rows, tables }], tables,
        });
    }
    if (normalizedExt === '.docx') {
        const mammoth = require('mammoth');
        const [raw, html] = await Promise.all([
            mammoth.extractRawText({ buffer }),
            mammoth.convertToHtml({ buffer }),
        ]);
        const tables = parseDocxTables(html.value || '');
        return documentModel.createDocument({
            filename, fileExt: normalizedExt, rawText: raw.value || '',
            tables,
        });
    }
    if (normalizedExt === '.pdf') {
        const { PDFParse } = require('pdf-parse');
        const parser = new PDFParse({ data: buffer });
        try {
            let parsed;
            try {
                parsed = await parser.getText({ cellSeparator: '\t' });
            } catch (error) {
                return documentModel.createDocument({
                    filename,
                    fileExt: normalizedExt,
                    rawText: '',
                    metadata: { textParseError: error.message },
                });
            }
            const pages = (parsed.pages || []).map((page) => ({ page: page.num, text: page.text || '' }));
            let tables = documentModel.extractTablesAcrossPages(pages.map((page) => ({
                page: page.page,
                matrix: matrixFromDelimitedText(page.text),
            })));
            if (!tables.length) {
                try {
                    const tableResult = await parser.getTable();
                    const vectorTables = (tableResult.pages || []).flatMap((page) =>
                        (page.tables || []).flatMap((matrix) =>
                            documentModel.extractTablesFromMatrix(matrix, { page: page.num })
                        )
                    );
                    tables = documentModel.mergeContinuedPageTables(vectorTables);
                } catch (error) {
                    console.warn(`[boq] native PDF vector-table extraction unavailable for "${filename}": ${error.message}`);
                }
            }
            return documentModel.createDocument({
                filename, fileExt: normalizedExt, rawText: parsed.text || '', pages, tables,
            });
        } finally {
            await parser.destroy();
        }
    }

    const rawText = await extractText(buffer, normalizedExt);
    const tables = delimitedTablesFromText(rawText);
    return documentModel.createDocument({ filename, fileExt: normalizedExt, rawText, tables });
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
    return `You are extracting procurement line items from a Bill of Quantities (BOQ) or project requirement document. The document may describe any industry or material. Return ONLY valid JSON, no commentary.

Extract every requirement line item into this shape:
{"items":[{"product":null,"description":null,"size":null,"specification":null,"quantity":null,"unit":null,"application":null,"notes":null}]}

Field rules:
- Identify the actual material/product and preserve the item's description.
- Quantity and unit must be copied only when plainly present in the document. Never infer either from a description, nearby row, serial number, rate, amount, or example. Use null when missing or uncertain.
- Do not confuse rate or amount with quantity.
- Keep one entry per source line. Never merge lines or invent values. Use null for unsupported fields and preserve the document's wording.

DOCUMENT:
${documentText}`;
}

function buildStructuredExtractionPrompt(table, rows) {
    const sourceRows = rows.map((entry, index) => ({
        rowId: entry.item.lineItemId,
        source: entry.item.provenance,
        cells: entry.row.cells,
    }));
    const readableRows = rows.map(({ row }) => row.cells.map((cell) => String(cell ?? '')).join(' | ')).join('\n');
    return `You normalize procurement requirements from a structured BOQ table. The source may describe any industry or material. Return ONLY valid JSON, no commentary.

TABLE HEADERS (original wording, in source order):
${JSON.stringify(table.headers)}

STRUCTURED ROWS (cell arrays align to the headers; source values are authoritative):
${JSON.stringify(sourceRows)}

For each input row, return exactly one item in the same order with this shape:
{"items":[{"rowId":"source rowId","product":null,"size":null,"specification":null,"application":null,"remarks":null,"confidence":{},"warnings":[]}]}

Derive only product, size, specification, application, and remarks from the row description/cells. Do not output or alter serial number, item code, quantity, unit, rates, or amounts; the application copies those directly from their source columns. Do not move values between columns or rows. Use null when a derived value is unclear. Preserve original terminology when practical.

DOCUMENT:
${readableRows}`;
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
    const cleaned = { ...source };
    for (const key of ['product', 'size', 'specification', 'application', 'description', 'serialNumber', 'itemCode']) {
        cleaned[key] = String(source[key] ?? '').trim() || null;
    }
    cleaned.remarks = String(source.remarks ?? source.notes ?? '').trim() || null;
    cleaned.notes = String(source.notes ?? source.remarks ?? '').trim() || null;
    const rawQuantity = source.quantity;
    cleaned.quantity = rawQuantity === null || rawQuantity === undefined || String(rawQuantity).trim() === ''
        ? null
        : documentModel.parseSourceQuantity(rawQuantity);
    cleaned.unit = String(source.unit ?? '').trim() || null;
    cleaned.sourceValues = source.sourceValues && typeof source.sourceValues === 'object' ? source.sourceValues : {};
    cleaned.sourceCells = Array.isArray(source.sourceCells) ? source.sourceCells : [];
    cleaned.provenance = source.provenance && typeof source.provenance === 'object' ? source.provenance : {};
    cleaned.confidence = source.confidence && typeof source.confidence === 'object' ? source.confidence : {};
    cleaned.warnings = Array.isArray(source.warnings) ? source.warnings : [];
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
    const generatedWarning = /^(Missing (?:size|quantity|unit)|Quantity could not be determined from source\.|Unit could not be determined from source\.|Quantity .* is not a number|Quantity is zero or negative|Inconsistent unit for this product\+size:|Duplicate line item|Quantity .* is over 100x the document median)/i;
    const warnings = Array.isArray(item.warnings) ? item.warnings.filter((warning) => !generatedWarning.test(warning)) : [];
    const size = String(item.size || '').trim();
    const quantityRaw = String(item.quantity ?? '').trim();
    const quantity = parseQuantity(quantityRaw);
    const unit = normalizeUnit(item.unit);

    if (!size) warnings.push('Missing size');
    if (!quantityRaw) {
        const message = item.provenance?.columns?.quantity
            ? 'Quantity could not be determined from source.'
            : 'Missing quantity';
        warnings.push(message);
    } else if (quantity === null) {
        warnings.push(`Quantity "${quantityRaw}" is not a number`);
    } else if (quantity <= 0) {
        warnings.push('Quantity is zero or negative');
    }
    if (!String(item.unit || '').trim() && !warnings.some((warning) => /unit/i.test(warning))) {
        warnings.push(item.provenance?.columns?.unit ? 'Unit could not be determined from source.' : 'Missing unit');
    }

    // Unit consistency: same product+size appearing with different units.
    const identity = String(item.product || item.description || item.itemCode || '').trim().toLowerCase();
    if (size && unit && identity) {
        const key = `${identity}|${size.toLowerCase()}`;
        const prior = seenKeys.get(key);
        if (prior === undefined) {
            seenKeys.set(key, unit);
        } else if (prior && prior !== unit) {
            warnings.push(`Inconsistent unit for this product+size: "${prior}" earlier vs "${unit}" here`);
        }
    }

    // Duplicate line items: exact product+size+spec match seen before.
    const dupKey = [item.itemCode || item.product || item.description, item.size, item.specification]
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
// BOQ's per-row JSON costs ~80-150 tokens, so a whole 84k-char document
// in one call truncates past ~25 rows and the response stops being valid
// JSON. Splitting the document into bounded chunks and extracting
// per-chunk keeps every single AI response well inside budget.
//
// PAGE ALIGNMENT (2026-09 size-cap fix): OCR output arrives as whole pages
// joined with "-- N of M --" separators, so chunks prefer to break AT page
// markers — a BOQ line item's description/qty/unit then always stays
// inside one chunk instead of straddling a boundary (which produced
// duplicate or partial rows). Pages bigger than a whole chunk fall back to
// the line-boundary walk; marker-less text chunks exactly as before.

const CHUNK_MAX_CHARS = Number(process.env.BOQ_CHUNK_MAX_CHARS || 12000);

// An OCR page separator as left in the concatenated text by pdfOcr.js
// ("-- 3 of 20 --", also "-- 3 --" / "--- 3 ---" variants).
function isPageBreak(line) {
    return /^\s*-{2,}\s*\d+(\s+of\s+\d+)?\s*-{2,}\s*$/.test(line);
}

/**
 * Split document text into chunks of at most maxChars, preferring page
 * boundaries (whole OCR pages are packed per chunk; a chunk break lands
 * exactly on a "-- N of M --" marker). Pages larger than maxChars, and
 * text with no page markers, split on line boundaries (BOQ rows are one
 * line each). The first line of a line-walked chunk after the first may
 * repeat the previous chunk's last line so column headers are never
 * orphaned at a boundary — routes/boq.js dedupes that repeated row after
 * the per-chunk merge.
 */
function splitIntoChunks(documentText, maxChars = CHUNK_MAX_CHARS) {
    const text = String(documentText || '');
    if (text.length <= maxChars) return [text];
    // Group lines into page segments: each page-marker line starts a new
    // segment. Marker-less text is ONE segment and takes the line walk
    // below, unchanged from the original behavior.
    const segments = [];
    let segment = [];
    for (const line of text.split('\n')) {
        if (isPageBreak(line) && segment.length) { segments.push(segment); segment = []; }
        segment.push(line);
    }
    if (segment.length) segments.push(segment);

    const chunks = [];
    let current = [];
    let length = 0;
    let lastLine = null; // last line placed into any chunk (header repeat)
    const flush = () => {
        if (current.length) { chunks.push(current.join('\n')); current = []; length = 0; }
    };
    for (const seg of segments) {
        const segLength = seg.reduce((n, l) => n + l.length + 1, 0);
        if (segLength <= maxChars) {
            // Whole page fits in a chunk: append it whole, breaking the
            // chunk BEFORE it when full — the boundary then sits exactly
            // on the next page marker.
            if (length + segLength > maxChars && current.length) flush();
            for (const line of seg) { current.push(line); lastLine = line; }
            length += segLength;
        } else {
            // Page longer than a whole chunk: walk its lines.
            for (const line of seg) {
                // A single overlong line still gets its own chunk (never dropped).
                if (length + line.length + 1 > maxChars && current.length) {
                    flush();
                    // Repeat the previous line into the new chunk so a table
                    // header that landed at the end of the last chunk is present.
                    current = lastLine ? [lastLine, line] : [line];
                    length = current.reduce((n, l) => n + l.length + 1, 0);
                } else {
                    current.push(line);
                    length += line.length + 1;
                }
                lastLine = line;
            }
        }
    }
    flush();
    return chunks;
}

/**
 * Normalized identity of one extracted line item, for boundary dedupe:
 * splitIntoChunks may repeat the previous chunk's last line at a soft
 * break, and the model can emit that repeated row again. Two items with
 * the same key are treated as the SAME row only when every schema field
 * matches (quantity coerced through parseQuantity so '100' and '100.0'
 * collide). The route applies this ONLY between adjacent chunks'
 * boundary rows, so genuinely repeated line items elsewhere in a BOQ
 * are preserved.
 */
function chunkDedupeKey(item) {
    if (!item || typeof item !== 'object') return '';
    return ITEM_SCHEMA_KEYS.map((k) => {
        const value = item[k];
        if (k === 'quantity') return String(parseQuantity(value) ?? '').trim();
        return String(value ?? '').trim().toLowerCase();
    }).join('|');
}

module.exports = {
    ITEM_SCHEMA_KEYS,
    looksLikeJunkText,
    CHUNK_MAX_CHARS,
    splitIntoChunks,
    isPageBreak,
    chunkDedupeKey,
    extractText,
    parseDocument,
    parseCsvText,
    parseDocxTables,
    delimitedTablesFromText,
    matrixFromDelimitedText,
    extractXlsxText,
    buildExtractionPrompt,
    buildStructuredExtractionPrompt,
    normalizeResponse,
    cleanItem,
    parseQuantity,
    normalizeUnit,
    flagItem,
    flagAll,
};
