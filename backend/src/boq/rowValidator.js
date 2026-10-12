const Decimal = require('decimal.js');

const SMALL = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function wordsToNumber(text) {
    try {
        const words = String(text || '').toLowerCase().replace(/lakh\(s\)/g, 'lakhs').replace(/\b(?:rupees?|rs\.?|only|paise|and)\b/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
        if (!words.length) return null;
        let total = 0; let current = 0; let known = 0;
        for (const word of words) {
            if (Object.prototype.hasOwnProperty.call(SMALL, word)) { current += SMALL[word]; known++; }
            else if (word === 'hundred') { current = (current || 1) * 100; known++; }
            else if (word === 'thousand') { total += (current || 1) * 1000; current = 0; known++; }
            else if (/^lakhs?$/.test(word)) { total += (current || 1) * 100000; current = 0; known++; }
            else if (word === 'crore') { total += (current || 1) * 10000000; current = 0; known++; }
        }
        return known ? new Decimal(total + current) : null;
    } catch { return null; }
}
function decimal(value) {
    const raw = String(value ?? '').trim();
    if (!raw || /^\d+\s+\d+$/.test(raw)) return null;
    try { return new Decimal(raw.replace(/,/g, '')); } catch { return null; }
}
function checkRow({ qty, rate, amount, amountWords }) {
    const flags = []; const q = decimal(qty); const r = decimal(rate); const a = decimal(amount);
    for (const [field, value] of Object.entries({ qty, rate, amount })) {
        if (value === null || value === undefined || String(value).trim() === '') flags.push({ code: 'MISSING_FIELD', field });
        else if (!decimal(value)) flags.push({ code: 'NON_NUMERIC', field, suggested: /^\d+\s+\d+$/.test(String(value).trim()) ? String(value).trim().replace(/\s+/, '.') : null });
    }
    if (q && r && a && q.mul(r).minus(a).abs().gt(1)) flags.push({ code: 'AMOUNT_MISMATCH' });
    const words = wordsToNumber(amountWords);
    if (words && !((a && words.minus(a).abs().lte(1)) || (r && words.minus(r).abs().lte(1)))) flags.push({ code: 'WORDS_MISMATCH' });
    return flags;
}
function checkTotals(rows, declaredTotal) {
    const sum = (rows || []).reduce((n, row) => n.plus(decimal(row.amount) || 0), new Decimal(0));
    const declared = decimal(declaredTotal); const difference = declared ? sum.minus(declared) : null;
    return { sum, declared, difference, ok: !!declared && difference.abs().lte(1), rowsWithFlags: (rows || []).map(checkRow).filter((x) => x.length) };
}
module.exports = { Decimal, wordsToNumber, checkRow, checkTotals, decimal };
