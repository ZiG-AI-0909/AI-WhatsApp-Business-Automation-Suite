'use strict';

// Proforma invoice calculations: the one place that defines line amounts,
// totals, the balance after advance and the amount in words. The preview
// (POST /api/proforma/preview) and the cached results in the Excel file both
// come from here, and the Excel formulas in proformaExport.js compute the
// same thing (ROUND(qty*rate,2), sums, words via wordsFormula below).
//
// No database access; pure functions only.

const { round2 } = require('../documents/quotationDomain');
const { CURRENCIES } = require('./proformaDefaults');

const MAX_AMOUNT = 999999999.99; // the words formula covers up to 999 million

// '' / null -> null; numbers and numeric strings ("1,720", "10.00") -> number;
// anything else -> NaN so validation can say "must be a number".
function toNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    const text = String(value).replace(/,/g, '').trim();
    if (!text) return null;
    return /^-?(?:\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : NaN;
}

function amountOf(qty, rate) {
    const q = toNumber(qty);
    const r = toNumber(rate);
    if (q === null || r === null || Number.isNaN(q) || Number.isNaN(r)) return null;
    return round2(q * r);
}

function sum(values) {
    return round2(values.reduce((total, value) => total + (value ?? 0), 0));
}

function calculate(invoice) {
    const items = (invoice.items || []).map((item) => ({ id: item.id, amount: amountOf(item.qty, item.rate) }));
    const totalQty = round2((invoice.items || []).reduce((total, item) => {
        const qty = toNumber(item.qty);
        return total + (qty === null || Number.isNaN(qty) ? 0 : qty);
    }, 0));
    const exWorks = sum(items.map((item) => item.amount));
    const inland = invoice.inland_freight?.include ? amountOf(invoice.inland_freight.qty, invoice.inland_freight.rate) : null;
    const fob = round2(exWorks + (inland ?? 0));
    const ocean = invoice.ocean_freight?.include ? amountOf(invoice.ocean_freight.qty, invoice.ocean_freight.rate) : null;
    const other = (invoice.other_charges || []).map((charge) => ({
        id: charge.id,
        amount: amountOf(charge.qty, charge.rate),
        included: charge.include_in_total !== false,
    }));
    // Each charge is added once, and only when it is marked "include in total".
    const otherIncluded = sum(other.filter((charge) => charge.included).map((charge) => charge.amount));
    const grandTotal = round2(fob + (ocean ?? 0) + otherIncluded);
    const advance = toNumber(invoice.payment?.advance);
    const advanceValue = advance === null || Number.isNaN(advance) ? null : round2(advance);
    return {
        items,
        total_qty: totalQty,
        ex_works: exWorks,
        inland_freight: inland,
        fob,
        ocean_freight: ocean,
        other_charges: other,
        other_included: otherIncluded,
        grand_total: grandTotal,
        advance: advanceValue,
        balance: advanceValue === null ? null : round2(grandTotal - advanceValue),
        amount_in_words: Math.abs(grandTotal) <= MAX_AMOUNT ? amountInWords(grandTotal, invoice.invoice?.currency) : '',
    };
}

// ─── Amount in words (international system: thousand / million) ─────
// "United States Dollars Thirty Four Thousand Two Hundred Seventy Eight and
// Zero Cents only." — the reference invoice's wording and spacing.

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n) {
    if (n < 20) return ONES[n];
    return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '');
}

function threeDigits(n) {
    const hundreds = Math.floor(n / 100);
    return [hundreds ? `${ONES[hundreds]} Hundred` : '', twoDigits(n % 100)].filter(Boolean).join(' ');
}

function integerWords(n) {
    if (n === 0) return 'Zero';
    const millions = Math.floor(n / 1e6);
    const thousands = Math.floor(n / 1e3) % 1000;
    const rest = n % 1000;
    return [
        millions ? `${threeDigits(millions)} Million` : '',
        thousands ? `${threeDigits(thousands)} Thousand` : '',
        threeDigits(rest),
    ].filter(Boolean).join(' ');
}

function currencyInfo(code) {
    return CURRENCIES[code] || CURRENCIES.USD;
}

function amountInWords(value, currencyCode = 'USD') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('Amount must be a finite number.');
    const cents = Math.round(round2(Math.abs(number)) * 100);
    if (cents > MAX_AMOUNT * 100) throw new Error('Amount is too large to express in words.');
    const whole = Math.floor(cents / 100);
    const minor = cents % 100;
    const currency = currencyInfo(currencyCode);
    const sign = number < 0 && cents > 0 ? 'Minus ' : '';
    return `${sign}${currency.words} ${integerWords(whole)} and ${minor ? twoDigits(minor) : 'Zero'} ${currency.minor} only.`;
}

// The same words as an Excel formula over a cell, so the text follows the
// total when quantities or prices are edited in Excel. Pure arithmetic
// (CHOOSE, IF, TRIM, INT, MOD, ROUND, ABS): no TEXT() format strings, whose
// decimal separator depends on the Excel locale. Works in LibreOffice too.
function excelString(text) {
    // A string constant inside a formula is limited to 255 characters:
    // 120 raw characters stay under it even when every one is a doubled quote.
    const raw = Array.from(String(text));
    const parts = [];
    for (let index = 0; index < raw.length || !parts.length; index += 120) {
        parts.push(`"${raw.slice(index, index + 120).join('').replace(/"/g, '""')}"`);
    }
    return parts.join('&');
}

function chooseList(words) {
    return words.map((word) => `"${word}"`).join(',');
}

function wordsFormula(cellRef, currencyCode = 'USD') {
    const currency = currencyInfo(currencyCode);
    const n = `ROUND(ABS(${cellRef}),2)`;
    const group = (scale) => `MOD(INT(${n}/${scale}),1000)`;
    // Words for a 0-99 expression, "" for 0.
    const two = (v) => `IF(${v}=0,"",IF(${v}<20,CHOOSE(${v},${chooseList(ONES.slice(1))}),`
        + `CHOOSE(INT(${v}/10)-1,${chooseList(TENS.slice(2))})&IF(MOD(${v},10)>0," "&CHOOSE(MOD(${v},10),${chooseList(ONES.slice(1, 10))}),"")))`;
    const three = (g) => `IF(INT(${g}/100)>0,CHOOSE(INT(${g}/100),${chooseList(ONES.slice(1, 10))})&" Hundred ","")&${two(`MOD(${g},100)`)}`;
    const whole = `TRIM(IF(${group(1000000)}>0,${three(group(1000000))}&" Million ","")`
        + `&IF(${group(1000)}>0,${three(group(1000))}&" Thousand ","")&${three(group(1))})`;
    const cents = `ROUND((${n}-INT(${n}))*100,0)`;
    const sign = `IF(ROUND(${cellRef},2)<0,"Minus ","")`;
    return `${sign}&${excelString(`${currency.words} `)}&IF(INT(${n})=0,"Zero",${whole})`
        + `&" and "&IF(${cents}=0,"Zero",${two(cents)})&${excelString(` ${currency.minor} only.`)}`;
}

// ─── Text templates: **bold** and {tokens} ───────────────────────────
// Static tokens are replaced with invoice values. Amount tokens depend on
// the totals, so text that uses them becomes an Excel formula (the amounts
// then follow edits made in Excel; formula text cannot carry bold).

const AMOUNT_TOKENS = ['advance', 'balance', 'grand_total'];
const STATIC_TOKENS = ['currency', 'incoterm', 'incoterm_place', 'bank_name', 'bank_branch', 'bank_account', 'bank_swift', 'bank_ifsc'];
const TOKENS = [...STATIC_TOKENS, ...AMOUNT_TOKENS];

function formatMoney(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function staticValues(invoice) {
    return {
        currency: invoice.invoice?.currency || 'USD',
        incoterm: invoice.shipping?.incoterm || '',
        incoterm_place: invoice.shipping?.incoterm_place || '',
        bank_name: invoice.bank?.name || '',
        bank_branch: invoice.bank?.branch || '',
        bank_account: invoice.bank?.account || '',
        bank_swift: invoice.bank?.swift || '',
        bank_ifsc: invoice.bank?.ifsc || '',
    };
}

// -> [{ text, bold } | { amount: 'advance'|'balance'|'grand_total', bold, value }]
function parseTemplate(text, invoice, totals) {
    const values = staticValues(invoice);
    const segments = [];
    String(text || '').split(/(\*\*)/).reduce((bold, part) => {
        if (part === '**') return !bold;
        for (const piece of part.split(/(\{[a-z_]+\})/)) {
            if (!piece) continue;
            const token = piece.match(/^\{([a-z_]+)\}$/)?.[1];
            if (token && AMOUNT_TOKENS.includes(token)) {
                segments.push({ amount: token, bold, value: totals ? totals[token] ?? null : null });
            } else {
                segments.push({ text: token && STATIC_TOKENS.includes(token) ? values[token] : piece, bold });
            }
        }
        return bold;
    }, false);
    return segments;
}

function usedTokens(text) {
    return [...String(text || '').matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]);
}

function segmentsToText(segments) {
    return segments.map((segment) => (segment.amount ? formatMoney(segment.value) : segment.text)).join('');
}

function isDynamic(segments) {
    return segments.some((segment) => segment.amount);
}

module.exports = {
    MAX_AMOUNT,
    TOKENS,
    AMOUNT_TOKENS,
    STATIC_TOKENS,
    toNumber,
    amountOf,
    calculate,
    amountInWords,
    integerWords,
    wordsFormula,
    excelString,
    parseTemplate,
    usedTokens,
    segmentsToText,
    isDynamic,
    formatMoney,
    currencyInfo,
};
