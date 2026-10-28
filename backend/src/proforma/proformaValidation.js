'use strict';

// Proforma invoice input rules.
//
// sanitizeInvoice() reshapes any request body into the known invoice
// structure (unknown keys dropped, text capped, ids made unique) without
// judging the values, so an incomplete draft can still be saved.
// validateInvoice() is the export gate: it returns { field path: message }
// for every missing or invalid value. Missing commercial values are reported,
// never replaced with zero.

const { CURRENCIES, INCOTERMS, newId } = require('./proformaDefaults');
const calc = require('./proformaCalculation');

const MAX_ITEMS = 200;
const MAX_CHARGES = 20;
const MAX_TERMS = 40;
const SHORT = 300;
const LONG = 2000;

const SHAPE = {
    invoice: ['number', 'date', 'enquiry_ref', 'po_number', 'po_date', 'currency'],
    exporter: ['name', 'address', 'contact', 'gstin', 'iec', 'signatory_name'],
    consignee: ['name', 'address', 'country', 'tax_id', 'acid', 'email', 'phone'],
    buyer: ['name', 'address', 'country', 'tax_id', 'email', 'contact_person', 'phone', 'signatory_name'],
    shipping: ['pre_carriage', 'place_of_receipt', 'place_of_delivery', 'container_no', 'vessel_no', 'port_of_loading', 'port_of_discharge', 'origin_country', 'destination_country', 'incoterm', 'incoterm_place', 'delivery_terms'],
    bank: ['name', 'branch', 'account', 'swift', 'ifsc'],
    letterhead: ['footer_title', 'footer_address', 'footer_contact'],
};
const MULTILINE = new Set(['exporter.address', 'consignee.address', 'buyer.address', 'invoice.enquiry_ref']);
const ITEM_TEXT = ['description', 'size', 'specification', 'pressure', 'coupler', 'hsn'];
const ITEM_NUMBERS = ['length', 'qty', 'rate'];

function text(value, max = SHORT, multiline = false) {
    if (value === null || value === undefined) return '';
    let result = String(value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
    if (!multiline) result = result.replace(/\s*\n\s*/g, ' ');
    return result.slice(0, max);
}

// Keep what was typed (number or string) so validation can name a bad value.
function numberField(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number') return Number.isFinite(value) ? value : '';
    return text(value, 40).trim();
}

function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function uniqueId(raw, used, prefix) {
    let id = /^[A-Za-z0-9_-]{1,40}$/.test(String(raw || '')) ? String(raw) : newId(prefix);
    while (used.has(id)) id = newId(prefix);
    used.add(id);
    return id;
}

function sanitizeInvoice(body) {
    const source = object(body);
    const result = {};
    for (const [section, fields] of Object.entries(SHAPE)) {
        const input = object(source[section]);
        result[section] = Object.fromEntries(fields.map((field) => [field, text(input[field], MULTILINE.has(`${section}.${field}`) ? LONG : SHORT, MULTILINE.has(`${section}.${field}`))]));
    }
    result.invoice.currency = CURRENCIES[result.invoice.currency] ? result.invoice.currency : (result.invoice.currency || 'USD');
    result.buyer.same_as_consignee = object(source.buyer).same_as_consignee === true;
    result.letterhead.show_logo = object(source.letterhead).show_logo !== false;
    const payment = object(source.payment);
    result.payment = { advance: numberField(payment.advance), summary: text(payment.summary, LONG, true) };

    const used = new Set();
    result.items = (Array.isArray(source.items) ? source.items : []).slice(0, MAX_ITEMS).map((raw) => {
        const item = object(raw);
        return {
            id: uniqueId(item.id, used, 'i'),
            ...Object.fromEntries(ITEM_TEXT.map((field) => [field, text(item[field], field === 'description' ? 500 : SHORT, field === 'description')])),
            ...Object.fromEntries(ITEM_NUMBERS.map((field) => [field, numberField(item[field])])),
        };
    });
    for (const key of ['inland_freight', 'ocean_freight']) {
        const freight = object(source[key]);
        result[key] = { include: freight.include !== false, description: text(freight.description), unit: text(freight.unit, 60), qty: numberField(freight.qty), rate: numberField(freight.rate) };
    }
    result.other_charges = (Array.isArray(source.other_charges) ? source.other_charges : []).slice(0, MAX_CHARGES).map((raw) => {
        const charge = object(raw);
        return {
            id: uniqueId(charge.id, used, 'c'),
            description: text(charge.description),
            unit: text(charge.unit, 60),
            qty: numberField(charge.qty),
            rate: numberField(charge.rate),
            include_in_total: charge.include_in_total !== false,
        };
    });
    result.terms = (Array.isArray(source.terms) ? source.terms : []).slice(0, MAX_TERMS).map((raw) => {
        const term = object(raw);
        return { id: uniqueId(term.id, used, 't'), title: text(term.title, 120), text: text(term.text, LONG, true) };
    });
    // "Same as consignee" copies the consignee into the buyer block.
    if (result.buyer.same_as_consignee) {
        for (const field of ['name', 'address', 'country', 'tax_id', 'email', 'phone']) result.buyer[field] = result.consignee[field];
    }
    return result;
}

function isDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function validateInvoice(invoice) {
    const errors = {};
    const fail = (path, message) => { if (!errors[path]) errors[path] = message; };
    const required = (path, label) => {
        const [section, field] = path.split('.');
        if (!String(invoice[section]?.[field] || '').trim()) fail(path, `${label} is required.`);
    };
    const number = (path, value, label, { required: isRequired = true, min = 0, exclusive = true, allowNegative = false } = {}) => {
        const parsed = calc.toNumber(value);
        if (parsed === null) {
            if (isRequired) fail(path, `${label} is required.`);
            return null;
        }
        if (Number.isNaN(parsed)) return fail(path, `${label} must be a number.`), null;
        if (!allowNegative && (exclusive ? parsed <= min : parsed < min)) return fail(path, `${label} must be ${exclusive ? 'greater than' : 'at least'} ${min}.`), null;
        if (Math.abs(parsed) > 1e9) return fail(path, `${label} is too large.`), null;
        return parsed;
    };

    required('invoice.number', 'Proforma invoice number');
    if (!isDate(invoice.invoice.date)) fail('invoice.date', 'Enter a valid invoice date.');
    if (invoice.invoice.po_date && !isDate(invoice.invoice.po_date)) fail('invoice.po_date', 'Enter a valid purchase order date.');
    if (!CURRENCIES[invoice.invoice.currency]) fail('invoice.currency', `Currency must be one of ${Object.keys(CURRENCIES).join(', ')}.`);

    required('exporter.name', 'Exporter name');
    required('exporter.address', 'Exporter address');
    required('consignee.name', 'Consignee name');
    required('consignee.address', 'Consignee address');
    if (!invoice.buyer.same_as_consignee) {
        const anyBuyer = ['name', 'address', 'country', 'tax_id', 'email', 'contact_person', 'phone'].some((field) => invoice.buyer[field].trim());
        if (anyBuyer) {
            required('buyer.name', 'Buyer / notifying party name');
            required('buyer.address', 'Buyer / notifying party address');
        }
    }
    for (const path of ['consignee.email', 'buyer.email']) {
        const [section, field] = path.split('.');
        const value = invoice[section][field].trim();
        if (value && !EMAIL.test(value)) fail(path, 'Enter a valid email address.');
    }

    if (!INCOTERMS.includes(invoice.shipping.incoterm)) fail('shipping.incoterm', 'Choose the Incoterm.');
    required('shipping.incoterm_place', 'Incoterm place (named port or place)');
    required('shipping.port_of_loading', 'Port of loading');
    required('shipping.port_of_discharge', 'Port of discharge');
    required('shipping.origin_country', 'Country of origin');
    required('shipping.destination_country', 'Country of final destination');

    if (!invoice.items.length) fail('items', 'Add at least one product.');
    for (const item of invoice.items) {
        const prefix = `items.${item.id}`;
        if (!item.size.trim() && !item.specification.trim()) fail(`${prefix}.specification`, 'Enter the pipe size or specification.');
        number(`${prefix}.qty`, item.qty, 'Quantity');
        number(`${prefix}.rate`, item.rate, 'Unit price');
        number(`${prefix}.length`, item.length, 'Length per pipe', { required: false });
        if (item.hsn && !/^\d{4,10}$/.test(item.hsn.trim())) fail(`${prefix}.hsn`, 'HSN code must be 4 to 10 digits.');
    }
    for (const key of ['inland_freight', 'ocean_freight']) {
        const freight = invoice[key];
        if (!freight.include) continue;
        const label = key === 'inland_freight' ? 'Inland freight' : 'Ocean freight';
        if (!freight.description.trim()) fail(`${key}.description`, `${label} description is required.`);
        number(`${key}.qty`, freight.qty, `${label} quantity`);
        number(`${key}.rate`, freight.rate, `${label} rate`, { min: 0, exclusive: false });
    }
    for (const charge of invoice.other_charges) {
        const prefix = `other_charges.${charge.id}`;
        if (!charge.description.trim()) fail(`${prefix}.description`, 'Charge description is required.');
        number(`${prefix}.qty`, charge.qty, 'Quantity');
        // Negative rates are allowed here: adjustments and discounts.
        number(`${prefix}.rate`, charge.rate, 'Rate', { allowNegative: true });
    }

    const totals = calc.calculate(invoice);
    if (Math.abs(totals.grand_total) > calc.MAX_AMOUNT) fail('totals', 'The grand total is too large.');
    if (totals.grand_total < 0) fail('totals', 'The grand total cannot be negative.');

    // The advance is needed only when some text prints {advance} or {balance}.
    const texts = [invoice.payment.summary, ...invoice.terms.map((term) => term.text)];
    const needsAdvance = texts.some((value) => calc.usedTokens(value).some((token) => token === 'advance' || token === 'balance'));
    const advance = number('payment.advance', invoice.payment.advance, 'Advance amount', { required: needsAdvance, min: 0, exclusive: false });
    if (advance !== null && advance > totals.grand_total) fail('payment.advance', 'The advance cannot be more than the grand total.');
    for (const [index, value] of texts.entries()) {
        const unknown = calc.usedTokens(value).filter((token) => !calc.TOKENS.includes(token));
        if (unknown.length) fail(index === 0 ? 'payment.summary' : `terms.${invoice.terms[index - 1].id}.text`, `Unknown placeholder {${unknown[0]}}.`);
    }
    for (const term of invoice.terms) {
        if (!term.title.trim() && term.text.trim()) fail(`terms.${term.id}.title`, 'Give this term a title.');
    }
    return errors;
}

// The saved exporter profile: company, bank, shipping defaults, terms and
// numbering. Same shape as proformaDefaults.DEFAULT_PROFILE.
function sanitizeProfile(body) {
    const source = object(body);
    const pick = (value, fields, multiline = []) => {
        const input = object(value);
        return Object.fromEntries(fields.map((field) => [field, text(input[field], multiline.includes(field) ? LONG : SHORT, multiline.includes(field))]));
    };
    const numbering = object(source.numbering);
    const digits = Number(numbering.seq_digits);
    return {
        exporter: pick(source.exporter, SHAPE.exporter, ['address']),
        letterhead: { ...pick(source.letterhead, SHAPE.letterhead), show_logo: object(source.letterhead).show_logo !== false },
        bank: pick(source.bank, SHAPE.bank),
        shipping: pick(source.shipping, ['pre_carriage', 'place_of_receipt', 'port_of_loading', 'origin_country', 'incoterm']),
        inland_freight: pick(source.inland_freight, ['description', 'unit']),
        ocean_freight_unit: text(source.ocean_freight_unit, 60),
        payment_summary: text(source.payment_summary, LONG, true),
        enquiry_ref: text(source.enquiry_ref, LONG, true),
        product_group: text(source.product_group, 500, true),
        terms: (Array.isArray(source.terms) ? source.terms : []).slice(0, MAX_TERMS)
            .map((raw) => ({ title: text(object(raw).title, 120), text: text(object(raw).text, LONG, true) }))
            .filter((term) => term.title.trim() || term.text.trim()),
        numbering: {
            pattern: /\{seq\}/.test(String(numbering.pattern || '')) ? text(numbering.pattern, 80) : '{prefix}_{fy}/PI-{seq}',
            prefix: text(numbering.prefix, 40),
            seq_digits: Number.isInteger(digits) && digits >= 1 && digits <= 6 ? digits : 2,
        },
    };
}

module.exports = {
    MAX_ITEMS,
    MAX_CHARGES,
    sanitizeInvoice,
    sanitizeProfile,
    validateInvoice,
    isDate,
};
