'use strict';

// Pure quotation rules: BOQ -> draft lines, validation, server-side totals,
// financial-year numbering, integrity checks, terms and placeholders.
// No database access here so every rule is unit-testable.
//
// Rates: the BOQ "rate"/"amount" columns are the CUSTOMER'S contract rates
// (installed: supply + laying + jointing + testing). They are stored as
// ref_rate/ref_amount for reference only and are NEVER copied into rate.
// A new draft always starts with rate = NULL; a human types every rate.

const { normalizeHeader } = require('./documentModel');
const detector = require('./pipeLineDetector');
const { amountInWordsIndian } = require('../utils/amountInWords');

const QUOTE_PREFIX = 'SP';
const STATUSES = ['draft', 'final', 'sent'];
const SUPPLY_TYPES = ['intra', 'inter'];
const SECTIONS = ['A', 'B'];
const AMOUNT_TOLERANCE = 1; // rupees, for qty x contract rate vs printed amount
const PLASTIC_PIPE_HSN = '3917';
const IST_OFFSET_MINUTES = 330;
const MAX_RATE = 1e9;
const MAX_QTY = 1e9;
const PLACEHOLDER_PATTERN = /\[[^\]\n]{1,160}\]/g;

const SECTION_TITLES = {
    A: 'A. Plastic pipes (HDPE / DWC / PVC) in the BOQ',
    B: 'B. Other pipe items in the BOQ (not in our standard range: review)',
};

function validationError(message, details) {
    const error = new Error(message);
    error.statusCode = 400;
    if (details) error.details = details;
    return error;
}

// Decimal-correct rounding to paise: 1.005 -> 1.01 (plain Math.round(x*100)
// gives 1.00 because 1.005 is stored as 1.00499...).
function round2(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    const sign = number < 0 ? -1 : 1;
    const abs = Math.abs(number);
    const text = String(abs);
    const shifted = text.includes('e') ? abs * 100 : Number(`${text}e2`);
    return (sign * Math.round(shifted)) / 100 + 0;
}

function toPaise(value) {
    return Math.round(round2(value) * 100);
}

// "2,13,37,436.00", "Rs. 470", 470 -> number; anything else -> null.
function parseAmount(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const cleaned = String(value).replace(/(?:rs\.?|inr|₹)/gi, '').replace(/[,\s]/g, '').trim();
    if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
    const number = Number(cleaned);
    return Number.isFinite(number) ? number : null;
}

function parseNumberInput(value, label, { min = 0, max = MAX_RATE, allowNull = false, exclusiveMin = false } = {}) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
        if (allowNull) return null;
        throw validationError(`${label} is required.`);
    }
    if (typeof value !== 'number' && typeof value !== 'string') throw validationError(`${label} must be a number.`);
    const number = typeof value === 'number' ? value : parseAmount(value);
    if (number === null || !Number.isFinite(number)) throw validationError(`${label} must be a number.`);
    if (exclusiveMin ? number <= min : number < min) {
        throw validationError(`${label} must be ${exclusiveMin ? 'greater than' : 'at least'} ${min}.`);
    }
    if (number > max) throw validationError(`${label} must be at most ${max}.`);
    return round2(number);
}

function cleanText(value, max = 2000) {
    return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

// ─── BOQ reference values ─────────────────────────────────────

function sourceValueByHeader(item, test) {
    const values = item?.sourceValues && typeof item.sourceValues === 'object' ? item.sourceValues : {};
    for (const [header, value] of Object.entries(values)) {
        if (test(normalizeHeader(header))) {
            const parsed = parseAmount(value);
            if (parsed !== null) return parsed;
        }
    }
    return null;
}

function refValues(item = {}) {
    const rate = parseAmount(item.rate) ?? sourceValueByHeader(item, (header) => /\brate\b/.test(header) && !/\bamount\b/.test(header));
    const amount = parseAmount(item.amount) ?? sourceValueByHeader(item, (header) => /\bamount\b/.test(header) && !/\brate\b/.test(header));
    return { ref_rate: rate, ref_amount: amount };
}

// ─── BOQ header -> customer / project / reference ─────────────

const HEADER_FIELDS = [
    ['project_name', /^(?:name\s+of\s+(?:the\s+)?work|work\s+name|work)\b\s*[:.\-–]?\s*/i],
    ['customer_name', /^issued\s+to\b\s*[:.\-–]?\s*/i],
    ['agreement_no', /^agreement\s+(?:no|number)\b\.?\s*[:.\-–]?\s*/i],
];
const HEADER_STOP = /^(?:scheme|authority|agreement\s+date|head\s+of\s+account|quotation\s+no|basis\s+of\s+rates|ddo\b|date\b|(?:s|sl|sr)\.?\s*no\b|item\s+code|name\s+of\s+(?:the\s+)?work|issued\s+to|agreement\s+(?:no|number)|work\b)/i;
const TABLE_START = /^\s*(?:s|sl|sr)\.?\s*no\b/i;

function joinWrapped(lines) {
    return lines.reduce((text, line) => {
        if (!text) return line;
        return /[-/]$/.test(text) ? `${text}${line}` : `${text} ${line}`;
    }, '');
}

function parseBoqHeader(documentText = '') {
    const allLines = String(documentText || '').split(/\r?\n/).map((line) => line.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim());
    const tableIndex = allLines.findIndex((line) => TABLE_START.test(line));
    const lines = allLines.slice(0, tableIndex >= 0 ? tableIndex : 80).filter(Boolean);
    const found = {};
    for (let index = 0; index < lines.length; index++) {
        for (const [field, label] of HEADER_FIELDS) {
            if (found[field] || !label.test(lines[index])) continue;
            const collected = [lines[index].replace(label, '')];
            for (let next = index + 1; next < lines.length && collected.length < 7; next++) {
                if (HEADER_STOP.test(lines[next])) break;
                collected.push(lines[next]);
            }
            const value = joinWrapped(collected.filter(Boolean))
                .replace(/^\((?:the\s+)?contractor\)\s*/i, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 600);
            if (value) found[field] = value;
        }
    }
    const authority = String(documentText || '').match(/\bauthority\s*[:\-–]?\s*([^\n|]{3,160})/i)?.[1]?.trim() || '';
    const referenceParts = [];
    if (authority) referenceParts.push(authority);
    if (found.agreement_no) referenceParts.push(`Agreement No. ${found.agreement_no}`);
    return {
        customer_name: found.customer_name || '',
        project_name: found.project_name || '',
        agreement_no: found.agreement_no || '',
        authority,
        reference_text: referenceParts.length ? `${referenceParts.join(', ')}. Quantities as per BOQ.` : '',
    };
}

function parsePrintedTotal(documentText = '') {
    const pattern = /\b(?:grand\s+total|total\s+(?:contract\s+)?amount)(?:\s+in\s+(?:rs|inr)\.?)?\s*[:.\-–]?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/gi;
    let last = null;
    let match;
    while ((match = pattern.exec(String(documentText || '')))) {
        const value = parseAmount(match[1]);
        if (value !== null && value > 0) last = value;
    }
    return last;
}

// ─── Integrity check (never auto-corrects) ────────────────────

function formatInr(value) {
    return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function checkBoqIntegrity(boqItems = [], documentText = '') {
    const lines = boqItems.map((item) => {
        const { ref_rate: refRate, ref_amount: refAmount } = refValues(item);
        const qty = parseAmount(item.quantity);
        const flags = [];
        if (qty !== null && refRate !== null && refAmount !== null) {
            const computed = round2(qty * refRate);
            const difference = round2(refAmount - computed);
            if (Math.abs(difference) > AMOUNT_TOLERANCE) {
                flags.push({
                    code: 'boq_amount_mismatch',
                    message: `BOQ qty x contract rate = ${formatInr(computed)} but the BOQ prints ${formatInr(refAmount)}: qty or rate may be misread: verify against the scan`,
                    computed,
                    printed: refAmount,
                    difference,
                });
            }
        }
        return { flags, ref_rate: refRate, ref_amount: refAmount };
    });
    const amounts = lines.map((line) => line.ref_amount).filter((value) => value !== null);
    const sum = amounts.length ? amounts.reduce((total, value) => total + toPaise(value), 0) / 100 : null;
    const printedTotal = parsePrintedTotal(documentText);
    const difference = sum !== null && printedTotal !== null ? round2(printedTotal - sum) : null;
    const totalOk = difference === null ? null : Math.abs(difference) <= AMOUNT_TOLERANCE;
    const mismatchedLines = lines.map((line, index) => (line.flags.length ? index + 1 : null)).filter(Boolean);
    const messages = [];
    if (totalOk === false) {
        messages.push(`Sum of BOQ amounts (${formatInr(sum)}) differs from the printed total (${formatInr(printedTotal)}) by ${formatInr(difference)}: an amount may be misread: verify against the scan`);
    }
    if (mismatchedLines.length) messages.push(`${mismatchedLines.length} BOQ line(s) where qty x rate does not match the printed amount.`);
    return {
        lines,
        summary: {
            boq_amount_sum: sum,
            printed_total: printedTotal,
            difference,
            total_ok: totalOk,
            lines_with_amount: amounts.length,
            total_lines: boqItems.length,
            mismatched_lines: mismatchedLines,
            messages,
        },
    };
}

// ─── Draft lines from a confirmed BOQ ─────────────────────────

function textOrEmpty(value, max = 200) {
    return value === null || value === undefined ? '' : String(value).trim().slice(0, max);
}

function buildDraftItems(boqItems = [], documentText = '') {
    const detections = detector.detectPipeLines(boqItems);
    const integrity = checkBoqIntegrity(boqItems, documentText);
    const rows = boqItems.map((item, index) => {
        const detection = detections[index];
        const check = integrity.lines[index];
        const qty = parseAmount(item.quantity);
        const spec = detection.spec || {};
        const provenance = item.provenance || {};
        return {
            line_no: index + 1,
            section: detection.section,
            include: detection.include,
            boq_item_no: textOrEmpty(item.serialNumber, 40),
            boq_item_code: textOrEmpty(item.itemCode, 60),
            description: detection.short_description || textOrEmpty(item.product || item.description, 300),
            boq_description: detection.full_text || '',
            size_mm: spec.size_mm ?? null,
            unit: textOrEmpty(item.unit, 20),
            qty: qty !== null && qty > 0 && qty <= MAX_QTY ? round2(qty) : null,
            rate: null,
            hsn: detection.classification === 'pipe_plastic' ? PLASTIC_PIPE_HSN : '',
            remarks: detection.remark || '',
            ref_rate: check.ref_rate,
            ref_amount: check.ref_amount,
            flags: check.flags,
            spec: {
                ...spec,
                boq_qty: qty,
                detection: {
                    classification: detection.classification,
                    confidence: detection.confidence,
                    reasons: detection.reasons,
                    composite: detection.composite,
                },
                source: {
                    page: provenance.page ?? null,
                    sheet: provenance.sheet ?? null,
                    table: provenance.table ?? null,
                    row: provenance.row ?? null,
                },
            },
        };
    });
    return { rows, integrity: integrity.summary };
}

// ─── Dates and numbering ──────────────────────────────────────

// Calendar date in India (IST, UTC+05:30, no DST) as YYYY-MM-DD.
function istDate(date = new Date()) {
    return new Date(date.getTime() + IST_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
}

function isValidIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Indian financial year (April to March): 2027-03-31 -> 2026-27,
// 2027-04-01 -> 2027-28. Date objects are read as IST calendar dates.
function fiscalYearFor(value = new Date()) {
    const iso = value instanceof Date ? istDate(value) : String(value);
    if (!isValidIsoDate(iso)) throw validationError('Quotation date must be a valid YYYY-MM-DD date.');
    const year = Number(iso.slice(0, 4));
    const month = Number(iso.slice(5, 7));
    const start = month >= 4 ? year : year - 1;
    return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function formatQuoteNumber(sequence, fiscalYear) {
    return `${QUOTE_PREFIX}/${fiscalYear}/${String(sequence).padStart(4, '0')}`;
}

// ─── Company, terms and placeholders ──────────────────────────

function companyFromSettings(values = {}) {
    const read = (key) => String(values[key] ?? '').trim();
    return {
        name: read('BUSINESS_NAME') || 'Sudarshan Pipes',
        address: read('COMPANY_ADDRESS'),
        state: read('COMPANY_STATE'),
        gstin: read('COMPANY_GSTIN'),
        phone: read('COMPANY_PHONE'),
        email: read('COMPANY_EMAIL'),
        bank: read('COMPANY_BANK_DETAILS'),
    };
}

function defaultTerms(company = {}) {
    const bank = String(company.bank || '').replace(/\s*\n\s*/g, ', ').trim();
    return [
        { key: 'scope', text: 'Scope: SUPPLY ONLY of pipes. Excavation, laying, jointing, testing, special fittings (saddle tee, stub ends, flanged sets, bends, reducers) and water for testing are excluded unless stated. Fittings quoted separately on request.' },
        { key: 'price_basis', text: 'Prices: [ex-works / delivered to site]. Freight and unloading as shown in the totals.' },
        { key: 'gst', text: 'GST: as applicable and shown above. Rates exclude any other taxes or levies.' },
        { key: 'payment', text: 'Payment terms: [to fill].' },
        { key: 'delivery', text: 'Delivery: [to fill] weeks from receipt of confirmed purchase order / site schedule.' },
        { key: 'validity', text: 'Validity: as stated in the header from the date of quotation.' },
        { key: 'test_certificates', text: 'Material conforms to the IS standards quoted in the description. Test certificates supplied with each lot.' },
        { key: 'bank', text: bank ? `Bank details: ${bank}` : 'Bank details: [Bank name, account name, account number, IFSC].' },
    ];
}

function normalizeTerms(terms) {
    if (!Array.isArray(terms)) throw validationError('Terms must be a list.');
    if (terms.length > 30) throw validationError('At most 30 terms are allowed.');
    return terms.map((term, index) => {
        const text = cleanText(typeof term === 'string' ? term : term?.text, 2000);
        if (!text) throw validationError(`Term ${index + 1} is empty. Remove it or enter text.`);
        const key = cleanText(typeof term === 'object' && term?.key ? term.key : `custom_${index + 1}`, 40).replace(/[^a-z0-9_]/gi, '_');
        return { key, text };
    });
}

function placeholdersIn(text) {
    return String(text || '').match(PLACEHOLDER_PATTERN) || [];
}

function findPlaceholders(quotation = {}, items = []) {
    const found = [];
    const check = (field, label, text) => {
        for (const placeholder of placeholdersIn(text)) found.push({ field, label, placeholder });
    };
    check('customer_name', 'Customer', quotation.customer_name);
    check('customer_address', 'Customer address', quotation.customer_address);
    check('project_name', 'Project', quotation.project_name);
    check('reference_text', 'Reference', quotation.reference_text);
    (Array.isArray(quotation.terms) ? quotation.terms : []).forEach((term, index) => {
        check(`terms.${index}`, `Term ${index + 1}`, term?.text);
    });
    for (const item of items.filter((row) => row.include)) {
        check(`items.${item.line_no}.description`, `Line ${item.line_no} description`, item.description);
        check(`items.${item.line_no}.remarks`, `Line ${item.line_no} remarks`, item.remarks);
    }
    return found;
}

// ─── Input validation ─────────────────────────────────────────

function normalizeQuotationPatch(body = {}) {
    const patch = {};
    for (const [field, max] of [['customer_name', 500], ['customer_address', 1000], ['project_name', 2000], ['reference_text', 2000]]) {
        if (body[field] !== undefined) patch[field] = cleanText(body[field], max);
    }
    if (body.customer_gstin !== undefined) {
        const gstin = cleanText(body.customer_gstin, 20).toUpperCase().replace(/\s+/g, '');
        if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) throw validationError('Customer GSTIN must be 15 letters/digits.');
        patch.customer_gstin = gstin;
    }
    if (body.quote_date !== undefined) {
        if (!isValidIsoDate(body.quote_date)) throw validationError('Quotation date must be a valid YYYY-MM-DD date.');
        patch.quote_date = body.quote_date;
    }
    if (body.validity_days !== undefined) {
        const days = parseNumberInput(body.validity_days, 'Validity (days)', { min: 1, max: 3650 });
        if (!Number.isInteger(days)) throw validationError('Validity (days) must be a whole number.');
        patch.validity_days = days;
    }
    if (body.supply_type !== undefined) {
        if (!SUPPLY_TYPES.includes(body.supply_type)) throw validationError('Supply type must be intra or inter.');
        patch.supply_type = body.supply_type;
    }
    if (body.gst_percent !== undefined) patch.gst_percent = parseNumberInput(body.gst_percent, 'GST %', { min: 0, max: 100 });
    if (body.discount_percent !== undefined) patch.discount_percent = parseNumberInput(body.discount_percent, 'Discount %', { min: 0, max: 100 });
    if (body.freight !== undefined) patch.freight = parseNumberInput(body.freight, 'Freight', { min: 0, max: MAX_RATE });
    if (body.terms !== undefined) patch.terms = normalizeTerms(body.terms);
    return patch;
}

const ITEM_EDITABLE = ['rate', 'qty', 'unit', 'description', 'include', 'section', 'remarks', 'hsn', 'size_mm'];

function normalizeItemPatch(input = {}, index = 0) {
    const label = `Line ${input.line_no ?? index + 1}`;
    if (input.id === undefined || input.id === null || input.id === '') throw validationError(`${label}: id is required.`);
    const patch = {};
    if (input.rate !== undefined) patch.rate = parseNumberInput(input.rate, `${label} rate`, { min: 0, max: MAX_RATE, allowNull: true });
    if (input.qty !== undefined) patch.qty = parseNumberInput(input.qty, `${label} qty`, { min: 0, max: MAX_QTY, exclusiveMin: true });
    if (input.size_mm !== undefined) patch.size_mm = parseNumberInput(input.size_mm, `${label} size`, { min: 0, max: 10000, allowNull: true, exclusiveMin: true });
    if (input.unit !== undefined) patch.unit = cleanText(input.unit, 20);
    if (input.hsn !== undefined) {
        const hsn = cleanText(input.hsn, 12);
        if (hsn && !/^\d{4,8}$/.test(hsn)) throw validationError(`${label} HSN must be 4 to 8 digits.`);
        patch.hsn = hsn;
    }
    if (input.description !== undefined) {
        const description = cleanText(input.description, 2000);
        if (!description) throw validationError(`${label} description cannot be empty.`);
        patch.description = description;
    }
    if (input.remarks !== undefined) patch.remarks = cleanText(input.remarks, 500);
    if (input.include !== undefined) {
        if (typeof input.include !== 'boolean') throw validationError(`${label} include must be true or false.`);
        patch.include = input.include;
    }
    if (input.section !== undefined) {
        if (!SECTIONS.includes(input.section)) throw validationError(`${label} section must be A or B.`);
        patch.section = input.section;
    }
    return { id: String(input.id), patch };
}

// ─── Totals (server is the only source of truth) ──────────────

function lineAmount(item) {
    if (item.rate === null || item.rate === undefined || item.qty === null || item.qty === undefined) return null;
    return round2(Number(item.qty) * Number(item.rate));
}

function lineWarnings(item) {
    const warnings = [];
    const rate = item.rate === null || item.rate === undefined ? null : Number(item.rate);
    const refRate = item.ref_rate === null || item.ref_rate === undefined ? null : Number(item.ref_rate);
    if (item.include && (rate === null || rate <= 0)) warnings.push({ code: 'unpriced', level: 'error', message: 'Rate not entered.' });
    if (item.include && !(Number(item.qty) > 0)) warnings.push({ code: 'qty_missing', level: 'error', message: 'Quantity must be greater than zero.' });
    if (rate !== null && rate > 0 && refRate !== null && rate > refRate) {
        warnings.push({ code: 'above_contract_rate', level: 'warning', message: `Above customer contract rate (${formatInr(refRate)}).` });
    }
    for (const flag of Array.isArray(item.flags) ? item.flags : []) warnings.push({ level: 'warning', ...flag });
    return warnings;
}

function calculateTotals(quotation = {}, items = []) {
    let subtotalPaise = 0;
    const unpriced = [];
    const lines = items.map((item) => {
        const amount = lineAmount(item);
        if (item.include) {
            if (amount !== null) subtotalPaise += toPaise(amount);
            if (item.rate === null || item.rate === undefined || Number(item.rate) <= 0) unpriced.push(item.line_no);
        }
        return { id: item.id, line_no: item.line_no, amount, warnings: lineWarnings(item) };
    });
    const subtotal = subtotalPaise / 100;
    const discountPercent = Number(quotation.discount_percent || 0);
    const gstPercent = Number(quotation.gst_percent ?? 18);
    const discountAmount = round2(subtotal * discountPercent / 100);
    const freight = round2(quotation.freight || 0);
    const taxable = round2(subtotal - discountAmount + freight);
    const intra = (quotation.supply_type || 'intra') === 'intra';
    const cgst = intra ? round2(taxable * (gstPercent / 100) / 2) : 0;
    const sgst = cgst;
    const igst = intra ? 0 : round2(taxable * (gstPercent / 100));
    const grandTotal = round2(taxable + cgst + sgst + igst);
    return {
        lines,
        subtotal,
        discount_percent: discountPercent,
        discount_amount: discountAmount,
        freight,
        taxable_value: taxable,
        supply_type: intra ? 'intra' : 'inter',
        gst_percent: gstPercent,
        cgst,
        sgst,
        igst,
        gst_total: round2(cgst + sgst + igst),
        grand_total: grandTotal,
        amount_in_words: amountInWordsIndian(grandTotal),
        included_lines: items.filter((item) => item.include).length,
        unpriced_lines: unpriced.length,
        unpriced_line_numbers: unpriced,
    };
}

function finalizeCheck(quotation = {}, items = [], company = {}) {
    const included = items.filter((item) => item.include);
    const blockers = [];
    const unpriced = included.filter((item) => item.rate === null || item.rate === undefined || Number(item.rate) <= 0)
        .map((item) => ({ id: item.id, line_no: item.line_no, description: item.description }));
    const qtyMissing = included.filter((item) => !(Number(item.qty) > 0)).map((item) => item.line_no);
    const placeholders = findPlaceholders(quotation, items);
    if (!included.length) blockers.push('Include at least one line.');
    if (unpriced.length) blockers.push(`${unpriced.length} included line(s) have no rate: ${unpriced.map((line) => line.line_no).join(', ')}.`);
    if (qtyMissing.length) blockers.push(`Quantity missing on line(s) ${qtyMissing.join(', ')}.`);
    if (placeholders.length) blockers.push(`Replace the [bracketed] placeholders: ${[...new Set(placeholders.map((entry) => entry.label))].join(', ')}.`);
    if (!cleanText(quotation.customer_name)) blockers.push('Enter the customer name.');
    if (!company.address || !company.gstin) blockers.push('Fill your company address and GSTIN in Settings.');
    return { ready: blockers.length === 0, blockers, unpriced_lines: unpriced, placeholders };
}

module.exports = {
    QUOTE_PREFIX,
    STATUSES,
    SUPPLY_TYPES,
    SECTIONS,
    SECTION_TITLES,
    AMOUNT_TOLERANCE,
    PLASTIC_PIPE_HSN,
    ITEM_EDITABLE,
    validationError,
    round2,
    parseAmount,
    parseNumberInput,
    refValues,
    parseBoqHeader,
    parsePrintedTotal,
    checkBoqIntegrity,
    buildDraftItems,
    istDate,
    isValidIsoDate,
    fiscalYearFor,
    formatQuoteNumber,
    companyFromSettings,
    defaultTerms,
    normalizeTerms,
    placeholdersIn,
    findPlaceholders,
    normalizeQuotationPatch,
    normalizeItemPatch,
    lineAmount,
    lineWarnings,
    calculateTotals,
    finalizeCheck,
    formatInr,
};
