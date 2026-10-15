'use strict';

// Indian-system amount in words (crore / lakh / thousand), rupees and paise.
// 1,25,00,000.50 -> "Rupees One Crore Twenty-Five Lakh and Fifty Paise Only".

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n) {
    if (n < 20) return ONES[n];
    return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
}

function belowThousand(n) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

// Crores repeat the lakh/thousand grouping, so 1,234 crore reads
// "One Thousand Two Hundred Thirty-Four Crore".
function integerWords(n) {
    if (n === 0) return 'Zero';
    const parts = [];
    const crore = Math.floor(n / 10000000);
    let rest = n % 10000000;
    if (crore) parts.push(`${integerWords(crore)} Crore`);
    const lakh = Math.floor(rest / 100000);
    rest %= 100000;
    if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
    const thousand = Math.floor(rest / 1000);
    rest %= 1000;
    if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
    if (rest) parts.push(belowThousand(rest));
    return parts.join(' ');
}

function amountInWordsIndian(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('Amount must be a finite number.');
    // Work in integer paise. Shifting via the decimal string ("1.005e2")
    // rounds half-up on the written value; Math.round(1.005 * 100) gives 100
    // because 1.005 is stored as 1.00499...
    const abs = Math.abs(number);
    const text = String(abs);
    const totalPaise = Math.round(text.includes('e') ? abs * 100 : Number(`${text}e2`));
    if (!Number.isSafeInteger(totalPaise)) throw new Error('Amount is too large to express in words.');
    const rupees = Math.floor(totalPaise / 100);
    const paise = totalPaise % 100;
    const sign = number < 0 && totalPaise > 0 ? 'Minus ' : '';
    if (rupees === 0 && paise > 0) return `${sign}Rupees Zero and ${belowHundred(paise)} Paise Only`;
    const words = `${sign}Rupees ${integerWords(rupees)}`;
    return paise ? `${words} and ${belowHundred(paise)} Paise Only` : `${words} Only`;
}

module.exports = { amountInWordsIndian, integerWords };
