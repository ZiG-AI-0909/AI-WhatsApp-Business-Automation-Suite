'use strict';

// Plain review state for BOQ rows, for the "Check" step.
//
// Every row gets ONE severity, derived from its current numbers and the
// flags row repair already recorded (boqRowRepair.js is not changed):
//   error  - a number is wrong or missing: qty x rate does not match the
//            amount, or qty / rate / amount is missing or impossible. It must
//            be fixed (numbers become consistent) or explicitly accepted with
//            a reason before the BOQ can be confirmed.
//   glance - a value was guessed and nothing independent confirms it
//            (unit inferred for a non-pipe item, odd item code, AI check
//            timed out, ...). One click "Looks fine", or bulk accept.
//   ok     - nothing to look at. Repairs that something independent
//            confirms count as ok: an S.No taken from the unbroken S.No
//            sequence, numbers confirmed by qty x rate = amount (or a rebuilt
//            amount whose rate the rate-in-words confirms), "m" for a pipe
//            line, a standard pipe size. They stay listed in corrections.
//
// Acceptance is stamped by the server only (who / when / reason) and is
// withdrawn when the row's quantity, rate, amount or unit change later.

const detector = require('./pipeLineDetector');
const { TOLERANCE, naiveNumber } = require('./boqRowRepair');

const NUMBER_CHECKS = new Set(['amount_mismatch', 'quantity_missing', 'quantity_unreadable', 'rate_missing', 'amount_unreadable']);
const AI_REVIEW_WARNING = /AI batch review required|AI enrichment could not be matched|cancelled before this source batch/i;
const EDIT_FIELDS = ['quantity', 'rate', 'amount', 'unit'];
const GLANCE_CHECKS = {
    item_code_suspicious: 'code_unclear',
    unit_missing: 'unit_missing',
    unit_ambiguous: 'unit_unclear',
    unit_unknown: 'unit_unclear',
    size_not_standard: 'size_unclear',
    rate_words_mismatch: 'rate_words',
};

const list = (value) => (Array.isArray(value) ? value : []);

function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    return naiveNumber(value);
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

/** True when the document has rate/amount columns (a priced BOQ). */
function hasPriceColumns(items = []) {
    return list(items).some((item) => toNumber(item.rate) !== null || toNumber(item.amount) !== null
        || String(item.ocr?.rate || '').trim() || String(item.ocr?.amount || '').trim());
}

/** Lines that go to the quotation: pipes and stoneware (anything not "not_pipe"). */
function quotationLineOf(item) {
    const detection = detector.classifyBoqItem({ description: item.description || item.rawDescription || item.product || '' });
    return { forQuotation: detection.classification !== 'not_pipe', lineClass: detection.classification };
}

function isBlankText(value) {
    return !String(value ?? '').trim();
}

/** The numbers problem of a row, or null when its numbers are consistent. */
function numberProblem(item, priced) {
    const quantity = toNumber(item.quantity);
    const rate = toNumber(item.rate);
    const amount = toNumber(item.amount);
    if (quantity === null && rate === null && amount === null
        && ['quantity', 'rate', 'amount'].every((field) => isBlankText(item.ocr?.[field]))) {
        return null; // a heading line with no numbers at all (handled as glance)
    }
    if (quantity === null) return { code: 'quantity_missing' };
    if (quantity <= 0) return { code: 'quantity_impossible', quantity };
    if (!priced) return null;
    if (rate === null && amount === null) return { code: 'rate_amount_missing', quantity };
    if (rate === null) return { code: 'rate_missing', quantity, amount };
    if (amount === null) return { code: 'amount_missing', quantity, rate, computed: round2(quantity * rate) };
    if (rate <= 0 || amount <= 0) return { code: 'value_impossible', quantity, rate, amount };
    const computed = round2(quantity * rate);
    if (Math.abs(computed - amount) > TOLERANCE) return { code: 'amount_mismatch', quantity, rate, amount, computed, difference: round2(amount - computed) };
    return null;
}

/**
 * Severity of one row plus short machine-readable notes the UI turns into
 * plain words. context.priced: the document has rate/amount columns.
 */
function rowReview(item, { priced = true } = {}) {
    const notes = [];
    const problem = numberProblem(item, priced);
    if (problem) notes.push({ severity: 'error', ...problem });

    const noNumbers = !problem && toNumber(item.quantity) === null && toNumber(item.rate) === null && toNumber(item.amount) === null;
    if (noNumbers) notes.push({ severity: 'glance', code: 'no_numbers' });

    const { forQuotation } = quotationLineOf(item);
    for (const entry of list(item.corrections)) {
        if (entry.level === 'info') continue;
        if (entry.field === 'serialNumber' || entry.field === 'size') continue; // sequence / standard size confirm them
        if (['quantity', 'rate', 'amount'].includes(entry.field)) {
            // Proven when the row's numbers are consistent on a priced BOQ.
            if (priced) continue;
            notes.push({ severity: 'glance', code: 'number_guessed', field: entry.field, original: entry.original, corrected: entry.corrected });
            continue;
        }
        if (entry.field === 'unit') {
            if (String(item.unit ?? '') !== String(entry.corrected ?? '')) continue; // the unit was changed since
            if (forQuotation && entry.corrected === 'm') continue; // pipes are billed per metre
            notes.push({ severity: 'glance', code: 'unit_guessed', original: entry.original, corrected: entry.corrected });
            continue;
        }
        if (entry.field === 'description') continue; // display text only; the raw OCR text is kept
        notes.push({ severity: 'glance', code: 'value_guessed', field: entry.field, original: entry.original, corrected: entry.corrected });
    }
    for (const check of list(item.checks)) {
        if (check.level === 'info' || NUMBER_CHECKS.has(check.code)) continue; // numbers are re-checked above
        notes.push({ severity: 'glance', code: GLANCE_CHECKS[check.code] || 'other_check', check: check.code });
    }
    if (list(item.warnings).some((warning) => AI_REVIEW_WARNING.test(String(warning)))) {
        notes.push({ severity: 'glance', code: 'ai_timeout' });
    }
    const severity = notes.some((note) => note.severity === 'error') ? 'error'
        : notes.length ? 'glance' : 'ok';
    return { severity, notes };
}

function numbersChanged(previous, item) {
    return Boolean(previous) && EDIT_FIELDS.some((field) => String(toNumberOrText(previous[field])) !== String(toNumberOrText(item[field])));
}

function toNumberOrText(value) {
    if (value === null || value === undefined || value === '') return '';
    const number = toNumber(value);
    return number === null ? String(value).trim() : number;
}

/**
 * Attach severity, review notes, quotation-line flags and the derived
 * review status to every row. Pure: never trusts client review fields;
 * callers pass rows whose acceptance / fixed fields were set server-side.
 */
function annotateItems(items = []) {
    const priced = hasPriceColumns(items);
    return list(items).map((input) => {
        const item = { ...input };
        const { severity, notes } = rowReview(item, { priced });
        const line = quotationLineOf(item);
        item.severity = severity;
        item.reviewNotes = notes;
        item.forQuotation = line.forQuotation;
        item.lineClass = line.lineClass;
        item.initialSeverity = item.initialSeverity || severity;
        item.acceptance = item.acceptance || null;
        item.fixed = item.fixed || null;
        item.reviewConfirmed = Boolean(item.acceptance);
        return item;
    });
}

/**
 * Merge an edited row list (from the client) with the stored rows:
 * acceptance and "fixed by" stamps come from the STORED rows only; a change
 * to quantity / rate / amount / unit withdraws the acceptance and records
 * who changed it.
 */
function mergeReviewState(items = [], previousItems = [], actor = 'user', now = new Date().toISOString()) {
    const previousById = new Map(list(previousItems).filter((item) => item?.lineItemId).map((item) => [item.lineItemId, item]));
    return list(items).map((input) => {
        const item = { ...input };
        delete item.acceptance;
        delete item.fixed;
        delete item.initialSeverity;
        const previous = item.lineItemId ? previousById.get(item.lineItemId) : null;
        if (previous) {
            item.initialSeverity = previous.initialSeverity || previous.severity || undefined;
            item.fixed = previous.fixed || null;
            item.acceptance = previous.acceptance || null;
            if (numbersChanged(previous, item)) {
                // Remember the values from before the first change, so an
                // undo back to them clears "fixed by".
                const original = previous.fixed?.original
                    || Object.fromEntries(EDIT_FIELDS.map((field) => [field, previous[field] ?? null]));
                item.fixed = numbersChanged(original, item) ? { by: actor, at: now, original } : null;
                item.acceptance = null;
            }
        } else {
            item.fixed = { by: actor, at: now, added: true };
            item.acceptance = null;
        }
        return item;
    });
}

class ReviewRequestError extends Error {
    constructor(message, status = 400, extra = {}) {
        super(message);
        this.status = status;
        Object.assign(this, extra);
    }
}

/**
 * Explicit acceptance of rows (annotated items). requests: [{ lineItemId,
 * reason }]. bulk: one click for many rows - only "glance" rows may be
 * bulk-accepted; an "error" row is accepted one at a time with a reason.
 */
function acceptRows(items, requests, { actor = 'user', bulk = false, now = new Date().toISOString() } = {}) {
    const wanted = list(requests).filter((request) => request && request.lineItemId);
    if (!wanted.length) throw new ReviewRequestError('Choose at least one row to accept.');
    const byId = new Map(items.map((item, index) => [item.lineItemId, index]));
    const missing = wanted.filter((request) => !byId.has(request.lineItemId));
    if (missing.length) throw new ReviewRequestError(`${missing.length} row(s) were not found in this BOQ. Reload and try again.`);
    const errorRows = wanted.filter((request) => items[byId.get(request.lineItemId)].severity === 'error');
    if (bulk && errorRows.length) {
        throw new ReviewRequestError(`${errorRows.length} of these rows have wrong numbers. Those must be fixed or accepted one by one with a reason, so nothing was accepted.`, 409, {
            errorRows: errorRows.map((request) => byId.get(request.lineItemId)),
        });
    }
    const withoutReason = errorRows.filter((request) => !String(request.reason || '').trim());
    if (withoutReason.length) throw new ReviewRequestError('Say why you are keeping a row with wrong numbers (for example "Matches the printed BOQ").');
    const next = items.map((item) => ({ ...item }));
    for (const request of wanted) {
        const index = byId.get(request.lineItemId);
        const item = next[index];
        if (item.severity === 'ok') continue;
        item.acceptance = {
            by: actor,
            at: now,
            reason: String(request.reason || '').trim().slice(0, 300) || 'Looks fine',
            severity: item.severity,
        };
        item.reviewConfirmed = true;
    }
    return next;
}

/** Withdraw acceptances (the "Undo" of a "Looks fine" / "Keep as is"). */
function unacceptRows(items, lineItemIds = []) {
    const ids = new Set(list(lineItemIds).map(String));
    return items.map((item) => (ids.has(String(item.lineItemId))
        ? { ...item, acceptance: null, reviewConfirmed: false }
        : item));
}

/** Rows that block confirmation: wrong numbers, neither fixed nor accepted. */
function blockingRows(items = []) {
    return list(items).map((item, index) => ({ item, index }))
        .filter(({ item }) => item.severity === 'error' && !item.acceptance);
}

function reviewCounts(items = []) {
    const rows = list(items);
    return {
        total: rows.length,
        error: rows.filter((item) => item.severity === 'error' && !item.acceptance).length,
        glance: rows.filter((item) => item.severity === 'glance' && !item.acceptance).length,
        ok: rows.filter((item) => item.severity === 'ok').length,
        accepted: rows.filter((item) => item.acceptance).length,
        fixed: rows.filter((item) => item.fixed).length,
        forQuotation: rows.filter((item) => item.forQuotation).length,
        aiTimeout: rows.filter((item) => list(item.reviewNotes).some((note) => note.code === 'ai_timeout')).length,
    };
}

module.exports = {
    AI_REVIEW_WARNING,
    hasPriceColumns,
    numberProblem,
    rowReview,
    annotateItems,
    mergeReviewState,
    acceptRows,
    unacceptRows,
    blockingRows,
    reviewCounts,
    ReviewRequestError,
};
