'use strict';

// Uploaded proforma invoice (OCR text) -> form fields.
//
// Same pattern as documents/boqExtractor.js (prompt -> JSON -> clean), with a
// dedicated proforma schema. The result fills the SAME form the user types
// into; nothing is saved or exported. Every field the document did not
// clearly give is flagged ({ path: message }, paths as in validation), and
// numbers are parsed strictly: an unreadable number becomes null + a flag,
// never a guess and never zero.
//
// Pure functions only; the OCR and AI calls live in routes/proforma.js.

const { newId, CURRENCIES, INCOTERMS } = require('./proformaDefaults');
const { sanitizeInvoice } = require('./proformaValidation');
const calc = require('./proformaCalculation');

const MAX_PROMPT_CHARS = 20000;
const MIN_TEXT_CHARS = 40;

function buildExtractionPrompt(documentText) {
    return `You are reading the OCR text of an export PROFORMA INVOICE (for example from an Indian pipe manufacturer to an overseas buyer). Return ONLY valid JSON, no commentary.

Shape (use null for anything not plainly present; never invent or infer values):
{"is_proforma_invoice":true,
 "invoice":{"number":null,"date":null,"enquiry_ref":null,"po_number":null,"po_date":null,"currency":null},
 "exporter":{"name":null,"address":null,"contact_person":null,"phone":null,"gstin":null,"iec":null},
 "consignee":{"name":null,"address":null,"country":null,"tax_id":null,"acid":null,"email":null,"phone":null},
 "buyer":{"name":null,"address":null,"country":null,"tax_id":null,"email":null,"contact_person":null,"phone":null},
 "shipping":{"pre_carriage":null,"place_of_receipt":null,"place_of_delivery":null,"container_no":null,"vessel_no":null,"port_of_loading":null,"port_of_discharge":null,"origin_country":null,"destination_country":null,"incoterm":null,"incoterm_place":null},
 "payment":{"advance_amount":null,"text":null},
 "bank":{"name":null,"branch":null,"account":null,"swift":null,"ifsc":null},
 "items":[{"group":null,"size":null,"specification":null,"pressure":null,"coupler":null,"length_m":null,"hsn":null,"quantity":null,"unit_price":null,"amount":null}],
 "inland_freight":{"description":null,"unit":null,"quantity":null,"rate":null,"amount":null},
 "ocean_freight":{"description":null,"unit":null,"quantity":null,"rate":null,"amount":null},
 "other_charges":[{"description":null,"unit":null,"quantity":null,"rate":null,"amount":null}],
 "totals":{"ex_works":null,"fob":null,"grand_total":null,"value_in_figures":null},
 "terms":[{"title":null,"text":null}],
 "uncertain":[]}

Rules:
- is_proforma_invoice: false if the text is not a proforma/commercial invoice.
- Dates as YYYY-MM-DD ("26th October 2026" -> "2026-10-26"). currency as an ISO code (USD, EUR, GBP, AED).
- Every quantity, price, rate, amount, length and advance is a JSON NUMBER without currency symbols, units or thousands separators ("1,16,621.00" -> 116621, "3.0 Mtr." -> 3). Use null if a number is unreadable.
- items: one entry per product row, in order. "group" is the bold heading above the rows (e.g. "PVC Pipes - uPVC Column Pipes"). size e.g. 3", specification e.g. "Super Deluxe / Standard" or "Heavy", pressure e.g. "17 kgf/cm²", coupler without brackets e.g. "Standard Coupler". Do not confuse unit price with amount.
- inland_freight is the freight to the port of loading (often "Inland Freight (Ex Works ...)"); ocean_freight is the sea freight under "Freight Charges"; set either to null if absent.
- incoterm is the code only (CFR, FOB, CIF, EXW ...); incoterm_place the named port/place after it.
- payment.advance_amount is the advance in the payment terms; payment.text is the payment sentence under "Terms of Delivery and Payment" copied verbatim.
- terms: every numbered term and condition, title and full text copied verbatim (keep spelling; join wrapped lines with spaces).
- Addresses: keep line breaks as "\\n".
- uncertain: dotted paths of fields you filled but could not read with confidence, e.g. "consignee.tax_id", "items.2.unit_price" (0-based item index).

OCR TEXT:
${String(documentText).slice(0, MAX_PROMPT_CHARS)}`;
}

// Same tolerance as boqExtractor.normalizeResponse: <think> preambles,
// ```json fences and stray prose around the object.
function parseJsonObject(content) {
    if (content && typeof content === 'object' && !Array.isArray(content)) return content;
    let text = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
    const unterminated = text.search(/<think>/i);
    if (unterminated >= 0) text = text.slice(0, unterminated);
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
    const attempt = (input) => {
        try { return JSON.parse(input); } catch { return null; }
    };
    let parsed = attempt(fenced.trim());
    if (parsed === null) {
        const start = fenced.indexOf('{');
        const end = fenced.lastIndexOf('}');
        if (start >= 0 && end > start) parsed = attempt(fenced.slice(start, end + 1));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The AI did not return structured invoice data. Try again.');
    return parsed;
}

// Strict number: 116621, "1,16,621.00", "USD 10,000.00", "3.0 Mtr." -> number;
// anything ambiguous -> null (the caller flags it).
function parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value)
        .replace(/(?:usd|us\$|inr|rs\.?|aed|eur|gbp|mtrs?\.?|meters?|metres?|pcs\.?|pieces?|nos\.?)/gi, '')
        .replace(/[$₹€£\s]/g, '')
        .replace(/,/g, '')
        .replace(/^\((.*)\)$/, '-$1');
    return /^-?(?:\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : null;
}

function str(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\r\n?/g, '\n').trim();
}

function isoDate(value) {
    const text = str(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const date = new Date(`${text}T00:00:00Z`);
        if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text) return text;
    }
    return '';
}

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Payment wording quotes amounts. Exact copies of the advance and the
// balance become {advance}/{balance}, so the printed amounts are formulas
// that follow the totals instead of numbers frozen from the old document.
function templatizeAmounts(text, advance, currency) {
    let result = str(text);
    let changed = false;
    if (!result || advance === null) return { text: result, changed, documentBalance: null };
    const variants = [
        advance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        advance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        advance.toLocaleString('en-US'),
        String(advance),
    ];
    for (const variant of [...new Set(variants)]) {
        const pattern = new RegExp(`(?<![\\d,.])${variant.replace(/[.,]/g, (char) => `\\${char}`)}(?![\\d])`, 'g');
        if (pattern.test(result)) {
            result = result.replace(pattern, '{advance}');
            changed = true;
            break;
        }
    }
    let documentBalance = null;
    result = result.replace(/(balance[^0-9{]{0,40}?)([\d][\d,]*(?:\.\d{1,2})?)/i, (match, lead, amount) => {
        documentBalance = parseNumber(amount);
        changed = true;
        return `${lead}{balance}`;
    });
    if (changed && currency) result = result.replace(new RegExp(`\\b${currency}\\s+(?=\\{(?:advance|balance)\\})`, 'g'), '{currency} ');
    return { text: result, changed, documentBalance };
}

const NOT_FOUND = 'Not found in the uploaded document. Fill this in.';
const UNSURE = 'Read with low confidence. Check against the document.';
const KEPT = 'Not in the uploaded document: kept from your saved company details. Check it.';

// parsed AI JSON + the user's blank invoice (profile defaults) ->
// { invoice, flags, recognized, warnings }
function mapExtraction(raw, blank) {
    const data = object(raw);
    const flags = {};
    const warnings = [];
    const flag = (path, message) => { if (!flags[path]) flags[path] = message; };
    const uncertain = new Set((Array.isArray(data.uncertain) ? data.uncertain : []).map((path) => String(path)));

    const invoice = JSON.parse(JSON.stringify(blank));
    let recognized = 0;
    const take = (section, field, value, { required = false, keepDefault = false } = {}) => {
        const text = str(value);
        const path = `${section}.${field}`;
        if (text) {
            invoice[section][field] = text;
            recognized++;
            if (uncertain.has(path)) flag(path, UNSURE);
        } else if (keepDefault && str(invoice[section][field])) {
            flag(path, KEPT);
        } else {
            invoice[section][field] = '';
            if (required) flag(path, NOT_FOUND);
        }
    };

    const source = {
        invoice: object(data.invoice), exporter: object(data.exporter), consignee: object(data.consignee),
        buyer: object(data.buyer), shipping: object(data.shipping), bank: object(data.bank), payment: object(data.payment),
    };
    take('invoice', 'number', source.invoice.number, { required: true });
    const date = isoDate(source.invoice.date);
    if (date) {
        invoice.invoice.date = date;
        recognized++;
        if (uncertain.has('invoice.date')) flag('invoice.date', UNSURE);
    } else {
        flag('invoice.date', source.invoice.date ? `Could not read the date "${str(source.invoice.date)}". Enter it.` : 'Not found in the uploaded document: today\'s date was kept. Check it.');
    }
    take('invoice', 'enquiry_ref', source.invoice.enquiry_ref, { keepDefault: true });
    take('invoice', 'po_number', source.invoice.po_number);
    const poDate = isoDate(source.invoice.po_date);
    invoice.invoice.po_date = poDate;
    if (source.invoice.po_date && !poDate) flag('invoice.po_date', `Could not read the PO date "${str(source.invoice.po_date)}".`);
    const currency = str(source.invoice.currency).toUpperCase();
    if (CURRENCIES[currency]) {
        invoice.invoice.currency = currency;
    } else {
        flag('invoice.currency', currency ? `The document's currency "${currency}" is not supported; ${invoice.invoice.currency} was kept.` : `Currency not stated: ${invoice.invoice.currency} was kept. Check it.`);
    }

    for (const field of ['name', 'address', 'contact_person', 'phone', 'gstin', 'iec']) {
        take('exporter', field, source.exporter[field], { required: ['name', 'address'].includes(field), keepDefault: true });
    }
    for (const field of ['name', 'address', 'country', 'tax_id', 'acid', 'email', 'phone']) {
        take('consignee', field, source.consignee[field], { required: ['name', 'address'].includes(field) });
    }
    for (const field of ['name', 'address', 'country', 'tax_id', 'email', 'contact_person', 'phone']) {
        take('buyer', field, source.buyer[field]);
    }
    invoice.buyer.same_as_consignee = false;
    for (const field of ['pre_carriage', 'place_of_receipt', 'place_of_delivery', 'container_no', 'vessel_no']) {
        take('shipping', field, source.shipping[field], { keepDefault: ['pre_carriage', 'place_of_receipt'].includes(field) });
    }
    for (const field of ['port_of_loading', 'port_of_discharge', 'origin_country', 'destination_country', 'incoterm_place']) {
        take('shipping', field, source.shipping[field], { required: true, keepDefault: ['port_of_loading', 'origin_country'].includes(field) });
    }
    const incoterm = str(source.shipping.incoterm).toUpperCase();
    if (INCOTERMS.includes(incoterm)) {
        invoice.shipping.incoterm = incoterm;
        recognized++;
    } else {
        flag('shipping.incoterm', incoterm ? `Unrecognised Incoterm "${incoterm}": ${invoice.shipping.incoterm} was kept.` : `Incoterm not found: ${invoice.shipping.incoterm} was kept. Check it.`);
    }
    for (const field of ['name', 'branch', 'account', 'swift', 'ifsc']) {
        take('bank', field, source.bank[field], { keepDefault: true });
    }

    // ── Products ───────────────────────────────────────────
    const rows = (Array.isArray(data.items) ? data.items : []).map(object)
        .filter((row) => ['size', 'specification', 'quantity', 'unit_price', 'amount'].some((key) => str(row[key])));
    let group = '';
    invoice.items = rows.map((row, index) => {
        const id = newId('i');
        group = str(row.group) || group;
        const qty = parseNumber(row.quantity);
        const rate = parseNumber(row.unit_price);
        const length = parseNumber(row.length_m);
        const printed = parseNumber(row.amount);
        const item = {
            id,
            description: group,
            size: str(row.size),
            specification: str(row.specification),
            pressure: str(row.pressure),
            coupler: str(row.coupler).replace(/^\((.*)\)$/, '$1'),
            length: length ?? '',
            hsn: str(row.hsn).replace(/\s+/g, ''),
            qty: qty ?? '',
            rate: rate ?? '',
        };
        const at = (field) => `items.${id}.${field}`;
        if (!item.size && !item.specification) flag(at('specification'), NOT_FOUND);
        if (qty === null) flag(at('qty'), str(row.quantity) ? `Could not read the quantity "${str(row.quantity)}".` : NOT_FOUND);
        if (rate === null) flag(at('rate'), str(row.unit_price) ? `Could not read the unit price "${str(row.unit_price)}".` : NOT_FOUND);
        if (str(row.length_m) && length === null) flag(at('length'), `Could not read the length "${str(row.length_m)}".`);
        for (const [key, field] of [['quantity', 'qty'], ['unit_price', 'rate'], ['size', 'size'], ['specification', 'specification'], ['hsn', 'hsn'], ['length_m', 'length']]) {
            if (uncertain.has(`items.${index}.${key}`)) flag(at(field), UNSURE);
        }
        // The document's own amount checks the quantity and price reading.
        if (qty !== null && rate !== null && printed !== null && Math.abs(calc.amountOf(qty, rate) - printed) > 0.01) {
            const message = `Quantity × price = ${calc.formatMoney(calc.amountOf(qty, rate))}, but the document shows ${calc.formatMoney(printed)} for this row. Check both.`;
            flag(at('qty'), message);
            flag(at('rate'), message);
        }
        return item;
    });
    if (!invoice.items.length) {
        invoice.items = [{ ...blank.items[0], id: newId('i') }];
        flag('items', 'No product rows were found in the document. Add them manually.');
    }
    recognized += rows.length;

    // ── Freight and other charges ──────────────────────────
    const freight = (key, value) => {
        const row = value && typeof value === 'object' ? value : null;
        const present = row && ['description', 'quantity', 'rate', 'amount'].some((field) => str(row[field]));
        if (!present) {
            invoice[key] = { ...invoice[key], include: false, qty: '', rate: '' };
            return;
        }
        const qty = parseNumber(row.quantity);
        const rate = parseNumber(row.rate);
        const printed = parseNumber(row.amount);
        invoice[key] = { include: true, description: str(row.description) || invoice[key].description, unit: str(row.unit) || invoice[key].unit, qty: qty ?? '', rate: rate ?? '' };
        recognized++;
        if (!str(row.description)) flag(`${key}.description`, NOT_FOUND);
        if (qty === null) flag(`${key}.qty`, str(row.quantity) ? `Could not read the quantity "${str(row.quantity)}".` : NOT_FOUND);
        if (rate === null) flag(`${key}.rate`, str(row.rate) ? `Could not read the rate "${str(row.rate)}".` : NOT_FOUND);
        if (qty !== null && rate !== null && printed !== null && Math.abs(calc.amountOf(qty, rate) - printed) > 0.01) {
            flag(`${key}.rate`, `Quantity × rate = ${calc.formatMoney(calc.amountOf(qty, rate))}, but the document shows ${calc.formatMoney(printed)}. Check both.`);
        }
    };
    freight('inland_freight', data.inland_freight);
    freight('ocean_freight', data.ocean_freight);
    invoice.other_charges = (Array.isArray(data.other_charges) ? data.other_charges : []).map(object)
        .filter((row) => str(row.description) || str(row.amount))
        .map((row) => {
            const id = newId('c');
            const qty = parseNumber(row.quantity) ?? (parseNumber(row.rate) === null && parseNumber(row.amount) !== null ? 1 : null);
            const rate = parseNumber(row.rate) ?? (qty === 1 ? parseNumber(row.amount) : null);
            if (qty === null) flag(`other_charges.${id}.qty`, NOT_FOUND);
            if (rate === null) flag(`other_charges.${id}.rate`, NOT_FOUND);
            return { id, description: str(row.description), unit: str(row.unit) || 'Lot', qty: qty ?? '', rate: rate ?? '', include_in_total: true };
        });

    // ── Payment and terms ──────────────────────────────────
    const advance = parseNumber(source.payment.advance_amount);
    invoice.payment.advance = advance ?? '';
    if (advance !== null) recognized++;
    else flag('payment.advance', str(source.payment.advance_amount) ? `Could not read the advance "${str(source.payment.advance_amount)}".` : 'Advance amount not found in the document. Enter it (the payment text uses it).');
    const balances = [];
    if (str(source.payment.text)) {
        const payment = templatizeAmounts(source.payment.text, advance, invoice.invoice.currency);
        invoice.payment.summary = payment.text;
        if (payment.changed) flag('payment.summary', 'Amounts from the document were replaced by live {advance}/{balance} values. Check the wording.');
        if (payment.documentBalance !== null) balances.push(payment.documentBalance);
    } else {
        flag('payment.summary', KEPT);
    }
    const terms = (Array.isArray(data.terms) ? data.terms : []).map(object)
        .filter((term) => str(term.title) || str(term.text))
        .map((term) => {
            const id = newId('t');
            const amounts = templatizeAmounts(term.text, advance, invoice.invoice.currency);
            if (amounts.changed) flag(`terms.${id}.text`, 'Amounts from the document were replaced by live {advance}/{balance} values. Check the wording.');
            if (amounts.documentBalance !== null) balances.push(amounts.documentBalance);
            return { id, title: str(term.title).replace(/\s*:\s*$/, ''), text: amounts.text };
        });
    if (terms.length) {
        invoice.terms = terms;
        recognized++;
    } else {
        flag('terms', 'No terms were found in the document: your standard terms were kept.');
    }

    // ── Cross-check the document's own totals ──────────────
    const result = sanitizeInvoice(invoice);
    const totals = calc.calculate(result);
    const printedTotals = object(data.totals);
    const compare = (label, printed, computed) => {
        const value = parseNumber(printed);
        if (value !== null && computed !== null && Math.abs(value - computed) > 0.01) {
            warnings.push(`The document's ${label} is ${calc.formatMoney(value)}, but the extracted rows add up to ${calc.formatMoney(computed)}.`);
        }
    };
    compare('Total Ex-Works', printedTotals.ex_works, totals.ex_works);
    compare('Total FOB', printedTotals.fob, totals.fob);
    compare('Grand Total', printedTotals.grand_total, totals.grand_total);
    compare('value in figures', printedTotals.value_in_figures, totals.grand_total);
    for (const balance of balances) {
        if (totals.balance !== null && Math.abs(balance - totals.balance) > 0.01) {
            warnings.push(`The document's payment balance is ${calc.formatMoney(balance)}, but Grand Total − advance is ${calc.formatMoney(totals.balance)}. The new invoice prints the calculated balance.`);
            break;
        }
    }
    // The printed totals let the form re-check live as fields are corrected.
    const documentTotals = {
        ex_works: parseNumber(printedTotals.ex_works),
        fob: parseNumber(printedTotals.fob),
        grand_total: parseNumber(printedTotals.grand_total),
        value_in_figures: parseNumber(printedTotals.value_in_figures),
        balance: balances[0] ?? null,
    };

    // Flags must point at the sanitized ids (they are kept when valid).
    return { invoice: result, flags, recognized, warnings, document_totals: documentTotals, looks_like_invoice: data.is_proforma_invoice !== false };
}

// Enough of a proforma invoice to be worth filling the form with?
function isUsableExtraction({ recognized, looks_like_invoice, invoice }) {
    const core = [invoice.invoice.number, invoice.consignee.name, invoice.buyer.name, invoice.shipping.port_of_loading, invoice.shipping.port_of_discharge]
        .filter((value) => String(value || '').trim()).length;
    const hasItems = invoice.items.some((item) => item.size || item.specification || item.qty !== '');
    return looks_like_invoice && recognized >= 4 && (hasItems || core >= 3);
}

function hasReadableText(text) {
    return String(text || '').replace(/\s+/g, '').length >= MIN_TEXT_CHARS;
}

module.exports = {
    MAX_PROMPT_CHARS,
    buildExtractionPrompt,
    parseJsonObject,
    parseNumber,
    templatizeAmounts,
    mapExtraction,
    isUsableExtraction,
    hasReadableText,
};
