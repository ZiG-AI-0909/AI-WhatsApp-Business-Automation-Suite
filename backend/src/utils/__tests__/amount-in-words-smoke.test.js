// Smoke test — Indian-system amount in words (crore / lakh, rupees and paise).
// Run: node backend/src/utils/__tests__/amount-in-words-smoke.test.js
'use strict';

const assert = require('node:assert/strict');
const { amountInWordsIndian } = require('../amountInWords');

const cases = [
    [12500000.5, 'Rupees One Crore Twenty-Five Lakh and Fifty Paise Only'],
    // The Belagavi BOQ's own printed total, worded exactly as the source.
    [428590237.37, 'Rupees Forty-Two Crore Eighty-Five Lakh Ninety Thousand Two Hundred Thirty-Seven and Thirty-Seven Paise Only'],
    [0, 'Rupees Zero Only'],
    [0.5, 'Rupees Zero and Fifty Paise Only'],
    [1, 'Rupees One Only'],
    [1.005, 'Rupees One and One Paise Only'],
    [100000, 'Rupees One Lakh Only'],
    [1000, 'Rupees One Thousand Only'],
    [99999.99, 'Rupees Ninety-Nine Thousand Nine Hundred Ninety-Nine and Ninety-Nine Paise Only'],
    [110, 'Rupees One Hundred Ten Only'],
    [12345678901, 'Rupees One Thousand Two Hundred Thirty-Four Crore Fifty-Six Lakh Seventy-Eight Thousand Nine Hundred One Only'],
    ['2500.10', 'Rupees Two Thousand Five Hundred and Ten Paise Only'],
];
for (const [value, expected] of cases) assert.equal(amountInWordsIndian(value), expected, `amount in words for ${value}`);
assert.throws(() => amountInWordsIndian('abc'), /finite/);

console.log('amount-in-words-smoke.test.js passed');
