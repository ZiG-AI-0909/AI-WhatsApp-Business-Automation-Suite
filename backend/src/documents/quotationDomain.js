'use strict';

const HEADER_ALIASES = {
    item_code: ['item code', 'item_code', 'code', 'sku', 'product code', 'material code'],
    name: ['description', 'item description', 'name', 'product', 'product name', 'material description'],
    category: ['category', 'product category', 'type'],
    size: ['size', 'diameter', 'nominal size', 'size mm'],
    pressure_class: ['pn', 'pressure class', 'pressure_class', 'class'],
    specification: ['specification', 'standard', 'specification standard', 'is standard'],
    unit: ['unit', 'uom', 'units'],
    rate: ['rate', 'price', 'unit rate', 'unit price'],
    hsn_code: ['hsn', 'hsn code', 'hsn_code'],
    gst_percent: ['gst', 'gst percent', 'gst_percent', 'tax percent'],
};

const normalizeText = (value) => String(value ?? '').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function parseFiniteNumber(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
    if ((value === '' || value === null || value === undefined) && nullable) return null;
    const number = Number(String(value ?? '').replace(/,/g, '').trim());
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new Error(`${label} must be a number between ${min} and ${max}.`);
    }
    return number;
}

function mapPriceListHeaders(headers) {
    const normalizedHeaders = headers.map((value) => normalizeText(value));
    const mapped = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
        const index = normalizedHeaders.findIndex((header) => aliases.some((alias) => normalizeText(alias) === header));
        if (index >= 0) mapped[field] = index;
    }
    return mapped;
}

function validatePriceListRow(values, mapped, rowNumber) {
    const get = (field) => mapped[field] === undefined ? '' : values[mapped[field]];
    const itemCode = String(get('item_code') ?? '').trim();
    const name = String(get('name') ?? '').trim();
    const unit = String(get('unit') ?? '').trim();
    const errors = [];
    if (!itemCode) errors.push('item code is required');
    if (!name) errors.push('description is required');
    if (!unit) errors.push('unit is required');
    let rate;
    let gstPercent;
    try { rate = parseFiniteNumber(get('rate'), 'Rate', { min: Number.EPSILON }); } catch (error) { errors.push(error.message); }
    try { gstPercent = parseFiniteNumber(get('gst_percent') || 18, 'GST', { min: 0, max: 100 }); } catch (error) { errors.push(error.message); }
    return {
        rowNumber,
        valid: errors.length === 0,
        errors,
        item: {
            item_code: itemCode,
            name,
            category: String(get('category') ?? '').trim() || null,
            size: String(get('size') ?? '').trim() || null,
            pressure_class: String(get('pressure_class') ?? '').trim() || null,
            specification: String(get('specification') ?? '').trim() || null,
            unit,
            rate,
            hsn_code: String(get('hsn_code') ?? '').trim() || null,
            gst_percent: gstPercent,
            active: true,
        },
    };
}

function matchPriceListItem(boqItem, priceItems) {
    const itemCode = normalizeText(boqItem?.itemCode || boqItem?.item_code);
    const product = normalizeText(boqItem?.product || boqItem?.description);
    const size = normalizeText(boqItem?.size);
    const pressureSource = String(boqItem?.pressureClass || boqItem?.pressure_class || boqItem?.specification || '');
    const pressureClass = normalizeText(pressureSource.match(/\b(?:pn|class)\s*[-:]?\s*[\w-]+/i)?.[0] || '');
    const unit = normalizeText(boqItem?.unit);
    const active = priceItems.filter((item) => item.active !== false);
    const ranked = active.map((item) => {
        const codeMatch = itemCode && normalizeText(item.item_code) === itemCode;
        const itemName = normalizeText(item.name);
        const itemSize = normalizeText(item.size);
        const itemPressure = normalizeText(item.pressure_class).replace(/\s+/g, '');
        const boqPressure = pressureClass.replace(/\s+/g, '');
        const itemUnit = normalizeText(item.unit);
        const exactProduct = product && itemName === product;
        const sizeMatch = size && itemSize === size;
        const pressureMatch = boqPressure && itemPressure === boqPressure;
        const unitMatch = unit && itemUnit === unit;
        const unitWarning = unit && itemUnit && !unitMatch;
        const tokens = new Set(product.split(' ').filter(Boolean));
        const itemTokens = new Set(itemName.split(' ').filter(Boolean));
        const overlap = [...tokens].filter((token) => itemTokens.has(token)).length;
        const fuzzy = tokens.size ? overlap / Math.max(tokens.size, itemTokens.size) : 0;
        let confidence = 0;
        let reason = 'fuzzy description match';
        if (codeMatch) { confidence = 1; reason = 'exact item code'; }
        else if (exactProduct && sizeMatch && pressureMatch && unitMatch) {
            confidence = 0.98;
            reason = 'exact product, size, pressure class, and unit';
        } else if ((exactProduct || fuzzy >= 0.6) && sizeMatch && pressureMatch && unitMatch) {
            confidence = Math.max(0.85, 0.9 * fuzzy);
            reason = 'product, size, pressure class, and unit match';
        } else {
            confidence = Math.min(0.79, fuzzy * 0.75 + (sizeMatch ? 0.12 : 0) + (pressureMatch ? 0.08 : 0));
        }
        return { item, confidence: Number(confidence.toFixed(2)), reason, unitWarning: !!unitWarning };
    }).filter((candidate) => candidate.confidence > 0)
        .sort((a, b) => b.confidence - a.confidence || String(a.item.item_code).localeCompare(String(b.item.item_code)))
        .slice(0, 3);
    const best = ranked[0];
    return {
        status: best && best.confidence >= 0.85 && !best.unitWarning ? 'matched' : 'unmatched',
        priceListItem: best && best.confidence >= 0.85 && !best.unitWarning ? best.item : null,
        candidates: ranked,
        reason: best?.unitWarning ? 'unit conversion required; verify and price manually' : best?.reason || 'no confident price-list match',
    };
}

function roundCurrency(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function calculateQuotation(items, quote, companyState = '') {
    let subtotal = 0;
    let taxTotal = 0;
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    const sameState = normalizeText(companyState) !== ''
        && normalizeText(companyState) === normalizeText(quote.customer_state);
    const calculatedItems = items.map((item) => {
        const quantity = parseFiniteNumber(item.quantity, 'Quantity', { min: 0 });
        const rate = parseFiniteNumber(item.rate, 'Rate', { min: 0, nullable: true });
        const itemDiscount = parseFiniteNumber(item.discount_percent ?? 0, 'Line discount', { min: 0, max: 100 });
        const gstPercent = parseFiniteNumber(item.gst_percent ?? 0, 'GST', { min: 0, max: 100 });
        const amount = rate === null ? 0 : roundCurrency(quantity * rate * (1 - itemDiscount / 100));
        const taxableAmount = roundCurrency(amount * (1 - Number(quote.discount_percent || 0) / 100));
        const tax = roundCurrency(taxableAmount * gstPercent / 100);
        subtotal += amount;
        taxTotal += tax;
        if (sameState) {
            cgst += roundCurrency(tax / 2);
            sgst += roundCurrency(tax - roundCurrency(tax / 2));
        } else {
            igst += tax;
        }
        return { ...item, quantity, rate, discount_percent: itemDiscount, gst_percent: gstPercent, amount };
    });
    subtotal = roundCurrency(subtotal);
    const discountAmount = roundCurrency(subtotal * Number(quote.discount_percent || 0) / 100);
    const freight = parseFiniteNumber(quote.freight ?? 0, 'Freight', { min: 0 });
    taxTotal = roundCurrency(taxTotal);
    return {
        items: calculatedItems,
        subtotal,
        discount_amount: discountAmount,
        freight,
        tax_total: taxTotal,
        cgst: roundCurrency(cgst),
        sgst: roundCurrency(sgst),
        igst: roundCurrency(igst),
        grand_total: roundCurrency(subtotal - discountAmount + freight + taxTotal),
    };
}

function fiscalYearFor(date = new Date()) {
    const year = date.getUTCFullYear();
    const startYear = date.getUTCMonth() >= 3 ? year : year - 1;
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function formatQuoteNumber(sequence, date = new Date()) {
    return `SP/${fiscalYearFor(date)}/${String(sequence).padStart(4, '0')}`;
}

module.exports = {
    HEADER_ALIASES,
    normalizeText,
    parseFiniteNumber,
    mapPriceListHeaders,
    validatePriceListRow,
    matchPriceListItem,
    roundCurrency,
    calculateQuotation,
    fiscalYearFor,
    formatQuoteNumber,
};
