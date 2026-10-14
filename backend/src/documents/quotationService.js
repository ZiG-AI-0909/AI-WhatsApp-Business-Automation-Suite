'use strict';

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { supabase } = require('../database/supabaseClient');
const domain = require('./quotationDomain');

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function validateQuoteItems(items) {
    if (!Array.isArray(items) || !items.length) throw new Error('A quotation needs at least one line item.');
    for (const [index, item] of items.entries()) {
        if (!['matched', 'manual', 'unmatched'].includes(item.match_status)) {
            throw new Error(`Line ${index + 1} has an invalid match status.`);
        }
        if (item.match_status === 'unmatched') {
            throw new Error(`Line ${index + 1} is unmatched. Select a catalogue item or enter a manual price.`);
        }
        if (domain.parseFiniteNumber(item.quantity, `Line ${index + 1} quantity`, { min: 0 }) <= 0) {
            throw new Error(`Line ${index + 1} quantity must be greater than zero.`);
        }
        if (domain.parseFiniteNumber(item.rate, `Line ${index + 1} rate`, { min: 0 }) <= 0) {
            throw new Error(`Line ${index + 1} rate must be greater than zero.`);
        }
    }
}

async function selectOwned(table, id, userId) {
    const { data, error } = await supabase.from(table).select('*')
        .eq('id', id).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data;
}

async function getItems(quotationId, userId) {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabase.from('quotation_items').select('*')
            .eq('quotation_id', quotationId).eq('user_id', userId)
            .order('line_no', { ascending: true }).range(offset, offset + 499);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < 500) break;
    }
    return rows;
}

async function getSettings(userId) {
    const { data, error } = await supabase.from('app_settings').select('key,value')
        .eq('user_id', userId).limit(200);
    if (error) throw error;
    const values = {};
    for (const row of data || []) values[row.key] = row.value;
    return {
        name: values.BUSINESS_NAME || 'Sudarshan Pipes',
        address: values.COMPANY_ADDRESS || '',
        state: values.COMPANY_STATE || '',
        gstin: values.COMPANY_GSTIN || '',
        phone: values.COMPANY_PHONE || '',
        email: values.COMPANY_EMAIL || '',
        logo: values.COMPANY_LOGO || '',
        bank: values.COMPANY_BANK_DETAILS || '',
    };
}

function quoteItemFromBoq(item, lineNo, match) {
    const matched = match.priceListItem;
    return {
        line_no: lineNo,
        boq_item_ref: {
            itemCode: item.itemCode || item.item_code || '',
            source: item.provenance || {},
            original: item,
        },
        price_list_item_id: matched?.id || null,
        description: matched?.name || item.product || item.description || '',
        size: matched?.size || item.size || '',
        unit: matched?.unit || item.unit || '',
        quantity: Number(item.quantity) || 0,
        rate: matched ? Number(matched.rate) : null,
        discount_percent: 0,
        gst_percent: matched ? Number(matched.gst_percent) : 0,
        hsn_code: matched?.hsn_code || '',
        amount: 0,
        match_status: matched ? 'matched' : 'unmatched',
    };
}

async function getPriceList(userId, { activeOnly = true, search = '', limit = 5000 } = {}) {
    const rows = [];
    const pageSize = 500;
    for (let offset = 0; offset < limit; offset += pageSize) {
        let query = supabase.from('price_list_items').select('*').eq('user_id', userId)
            .order('item_code', { ascending: true }).range(offset, offset + Math.min(pageSize, limit - offset) - 1);
        if (activeOnly) query = query.eq('active', true);
        if (search) {
            const term = `%${search.replace(/[%(),]/g, ' ').trim()}%`;
            query = query.or(`item_code.ilike.${term},name.ilike.${term},category.ilike.${term},size.ilike.${term}`);
        }
        const { data, error } = await query;
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < pageSize) break;
    }
    return rows;
}

async function matchBoqItems(userId, items) {
    const catalogue = await getPriceList(userId);
    return items.map((item, index) => ({
        line: index + 1,
        boqItem: item,
        ...domain.matchPriceListItem(item, catalogue),
    }));
}

async function calculateAndPersist(quotation, items, userId) {
    const settings = await getSettings(userId);
    const totals = domain.calculateQuotation(items, quotation, settings.state);
    const persistedItems = totals.items.filter((item) => item.id).map((item) => ({
        id: item.id,
        quotation_id: quotation.id,
        user_id: userId,
        amount: item.amount,
        updated_at: new Date().toISOString(),
    }));
    for (let offset = 0; offset < persistedItems.length; offset += 500) {
        const { error: itemError } = await supabase.from('quotation_items')
            .upsert(persistedItems.slice(offset, offset + 500), { onConflict: 'id' });
        if (itemError) throw itemError;
    }
    const { data, error } = await supabase.from('quotations').update({
        subtotal: totals.subtotal,
        tax_total: totals.tax_total,
        grand_total: totals.grand_total,
        updated_at: new Date().toISOString(),
    }).eq('id', quotation.id).eq('user_id', userId).select('*').single();
    if (error) throw error;
    return {
        ...data,
        items: totals.items,
        totals,
        amount_in_words: amountInWordsIndian(totals.grand_total),
    };
}

function amountInWordsIndian(value) {
    const amount = Math.max(0, Number(value) || 0);
    const n = Math.floor(amount);
    let paise = Math.round((amount - n) * 100);
    let rupees = n;
    if (paise === 100) { rupees++; paise = 0; }
    if (rupees === 0 && paise === 0) return 'Zero rupees only';
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
        'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const underThousand = (number) => {
        const parts = [];
        if (number >= 100) parts.push(`${ones[Math.floor(number / 100)]} Hundred`);
        const remainder = number % 100;
        if (remainder >= 20) parts.push(`${tens[Math.floor(remainder / 10)]}${remainder % 10 ? ` ${ones[remainder % 10]}` : ''}`);
        else if (remainder) parts.push(ones[remainder]);
        return parts.join(' ');
    };
    let rest = rupees;
    const parts = [];
    for (const [base, label] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]) {
        if (rest >= base) {
            parts.push(`${underThousand(Math.floor(rest / base))} ${label}`);
            rest %= base;
        }
    }
    if (rest) parts.push(underThousand(rest));
    const rupeeWords = `${parts.length ? parts.join(' ') : 'Zero'} rupees`;
    return paise ? `${rupeeWords} and ${underThousand(paise)} paise only` : `${rupeeWords} only`;
}

async function renderPdf(quotation, items, company) {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const chunks = [];
    const completion = new Promise((resolve, reject) => {
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });
    if (company.logo) {
        const logo = String(company.logo).match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i);
        if (logo) {
            const imageBuffer = Buffer.from(logo[2], 'base64');
            if (imageBuffer.length <= 1024 * 1024) {
                try { doc.image(imageBuffer, 42, 35, { fit: [70, 50] }); } catch (error) {
                    console.warn('[quotations] configured company logo could not be embedded:', error.message);
                }
            }
        }
    }
    doc.fontSize(18).font('Helvetica-Bold').text(company.name || 'Quotation', { align: 'center' });
    doc.moveDown(0.25).fontSize(9).font('Helvetica').text(
        [company.address, company.phone && `Phone: ${company.phone}`, company.email && `Email: ${company.email}`, company.gstin && `GSTIN: ${company.gstin}`]
            .filter(Boolean).join(' | '), { align: 'center' });
    doc.moveDown().fontSize(15).font('Helvetica-Bold').text('TAX QUOTATION', { align: 'center' });
    doc.moveDown().fontSize(9).font('Helvetica');
    doc.text(`Quotation: ${quotation.quote_number}     Date: ${new Date(quotation.created_at).toLocaleDateString('en-IN')}`);
    doc.text(`Valid for: ${quotation.validity_days} days     Project: ${quotation.project_name || '-'}`);
    doc.moveDown(0.5).font('Helvetica-Bold').text('Customer');
    doc.font('Helvetica').text(`${quotation.customer_name || '-'}${quotation.customer_phone ? ` | ${quotation.customer_phone}` : ''}`);
    doc.text(`${quotation.customer_address || ''}${quotation.customer_state ? `, ${quotation.customer_state}` : ''}`);
    if (quotation.customer_gstin) doc.text(`GSTIN: ${quotation.customer_gstin}`);
    doc.moveDown();
    const columns = [36, 188, 264, 308, 344, 386, 438, 490];
    const drawHeader = () => {
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(8);
        ['#', 'Description', 'Size', 'HSN', 'Qty', 'Unit', 'Rate', 'Amount'].forEach((label, i) => doc.text(label, columns[i], y, { width: (columns[i + 1] || 560) - columns[i] - 4 }));
        doc.moveTo(36, y + 14).lineTo(560, y + 14).stroke();
        doc.y = y + 20;
        doc.font('Helvetica').fontSize(8);
    };
    drawHeader();
    for (const item of items) {
        const description = item.description || '';
        const height = Math.max(19, doc.heightOfString(description, { width: 148 }) + 4);
        if (doc.y + height > 730) { doc.addPage(); drawHeader(); }
        const y = doc.y;
        const values = [item.line_no, description, item.size || '', item.hsn_code || '', item.quantity, item.unit || '', item.rate ?? '', item.amount || 0];
        values.forEach((value, i) => doc.text(String(value), columns[i], y, { width: (columns[i + 1] || 560) - columns[i] - 4, height, ellipsis: true }));
        doc.y = y + height;
        doc.moveTo(36, doc.y).lineTo(560, doc.y).strokeColor('#dddddd').stroke().strokeColor('#000000');
    }
    const totals = domain.calculateQuotation(items, quotation, company.state);
    doc.moveDown();
    doc.font('Helvetica-Bold').text(`Subtotal: INR ${totals.subtotal.toFixed(2)}`, { align: 'right' });
    doc.font('Helvetica').text(`Discount: INR ${totals.discount_amount.toFixed(2)}`, { align: 'right' });
    if (totals.igst) doc.text(`IGST: INR ${totals.igst.toFixed(2)}`, { align: 'right' });
    else {
        doc.text(`CGST: INR ${totals.cgst.toFixed(2)}`, { align: 'right' });
        doc.text(`SGST: INR ${totals.sgst.toFixed(2)}`, { align: 'right' });
    }
    doc.text(`Freight: INR ${totals.freight.toFixed(2)}`, { align: 'right' });
    doc.font('Helvetica-Bold').text(`Grand total: INR ${totals.grand_total.toFixed(2)}`, { align: 'right' });
    doc.font('Helvetica').moveDown(0.4).text(`Amount in words: ${amountInWordsIndian(totals.grand_total)}`);
    for (const [label, value] of [['Payment terms', quotation.payment_terms], ['Delivery terms', quotation.delivery_terms], ['Notes', quotation.notes], ['Bank details', company.bank]]) {
        if (value) doc.moveDown(0.3).font('Helvetica-Bold').text(`${label}: `, { continued: true }).font('Helvetica').text(value);
    }
    doc.moveDown(1.5).text('Authorized signatory: ___________________________', { align: 'right' });
    const pages = doc.bufferedPageRange();
    for (let index = pages.start; index < pages.start + pages.count; index++) {
        doc.switchToPage(index);
        doc.fontSize(8).text(`Page ${index + 1} of ${pages.count}`, 42, 800, { align: 'center', width: 510 });
    }
    doc.end();
    return completion;
}

async function renderExcel(quotation, items, company) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Quotation', { views: [{ state: 'frozen', ySplit: 7 }] });
    const logo = String(company.logo || '').match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i);
    if (logo) {
        const imageBuffer = Buffer.from(logo[2], 'base64');
        if (imageBuffer.length <= 1024 * 1024) {
            const imageId = workbook.addImage({ buffer: imageBuffer, extension: logo[1].toLowerCase().startsWith('jp') ? 'jpeg' : 'png' });
            sheet.addImage(imageId, { tl: { col: 0, row: 0 }, br: { col: 1, row: 2 } });
        }
    }
    sheet.mergeCells('A1:J1');
    sheet.getCell('A1').value = company.name || 'Quotation';
    sheet.getCell('A1').font = { bold: true, size: 18 };
    sheet.mergeCells('A2:J2');
    sheet.getCell('A2').value = [company.address, company.gstin && `GSTIN: ${company.gstin}`, company.phone, company.email].filter(Boolean).join(' | ');
    sheet.addRow([`Quotation ${quotation.quote_number}`, 'Date', new Date(quotation.created_at)]);
    sheet.addRow(['Customer', quotation.customer_name || '', 'Phone', quotation.customer_phone || '']);
    sheet.addRow(['Project', quotation.project_name || '', 'GSTIN', quotation.customer_gstin || '']);
    sheet.addRow([]);
    sheet.addRow(['#', 'Description', 'Size', 'HSN', 'Quantity', 'Unit', 'Rate', 'Discount %', 'GST %', 'Amount']);
    const headerRow = 7;
    sheet.getRow(headerRow).font = { bold: true };
    items.forEach((item) => {
        const row = sheet.addRow([item.line_no, item.description, item.size, item.hsn_code, Number(item.quantity), item.unit, Number(item.rate) || 0, Number(item.discount_percent) || 0, Number(item.gst_percent) || 0]);
        row.getCell(10).value = { formula: `ROUND(E${row.number}*G${row.number}*(1-H${row.number}/100),2)` };
    });
    const firstLine = headerRow + 1;
    const lastLine = headerRow + items.length;
    const totalRow = lastLine + 2;
    sheet.getCell(`I${totalRow}`).value = 'Subtotal';
    sheet.getCell(`J${totalRow}`).value = { formula: `ROUND(SUM(J${firstLine}:J${lastLine}),2)` };
    sheet.getCell(`I${totalRow + 1}`).value = 'Discount %';
    sheet.getCell(`J${totalRow + 1}`).value = Number(quotation.discount_percent || 0);
    const gstBaseFormula = `SUMPRODUCT(J${firstLine}:J${lastLine},I${firstLine}:I${lastLine})/100*(1-J${totalRow + 1}/100)`;
    const gstFormula = `ROUND(${gstBaseFormula},2)`;
    const sameState = domain.normalizeText(company.state) && domain.normalizeText(company.state) === domain.normalizeText(quotation.customer_state);
    if (sameState) {
        sheet.getCell(`I${totalRow + 2}`).value = 'CGST';
        sheet.getCell(`J${totalRow + 2}`).value = { formula: `ROUND(${gstBaseFormula}/2,2)` };
        sheet.getCell(`I${totalRow + 3}`).value = 'SGST';
        sheet.getCell(`J${totalRow + 3}`).value = { formula: `ROUND(${gstBaseFormula}-J${totalRow + 2},2)` };
    } else {
        sheet.getCell(`I${totalRow + 2}`).value = 'IGST';
        sheet.getCell(`J${totalRow + 2}`).value = { formula: gstFormula };
    }
    const gstRows = sameState ? 2 : 1;
    const freightRow = totalRow + 2 + gstRows;
    const grandTotalRow = freightRow + 1;
    sheet.getCell(`I${freightRow}`).value = 'Freight';
    sheet.getCell(`J${freightRow}`).value = Number(quotation.freight || 0);
    sheet.getCell(`I${grandTotalRow}`).value = 'Grand Total';
    const taxFormula = sameState ? `J${totalRow + 2}+J${totalRow + 3}` : `J${totalRow + 2}`;
    sheet.getCell(`J${grandTotalRow}`).value = { formula: `ROUND(J${totalRow}-J${totalRow}*J${totalRow + 1}/100+${taxFormula}+J${freightRow},2)` };
    sheet.getRow(grandTotalRow).font = { bold: true };
    let termsRow = grandTotalRow + 2;
    for (const [label, value] of [['Payment terms', quotation.payment_terms], ['Delivery terms', quotation.delivery_terms], ['Notes', quotation.notes], ['Bank details', company.bank]]) {
        if (!value) continue;
        sheet.mergeCells(`A${termsRow}:J${termsRow}`);
        sheet.getCell(`A${termsRow}`).value = `${label}: ${value}`;
        termsRow++;
    }
    sheet.columns = [{ width: 7 }, { width: 38 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 13 }, { width: 10 }, { width: 16 }];
    sheet.getColumn(5).numFmt = '#,##0.000';
    for (const column of [7, 10]) sheet.getColumn(column).numFmt = '#,##0.00';
    for (const column of [8, 9]) sheet.getColumn(column).numFmt = '0.00';
    return workbook.xlsx.writeBuffer();
}

module.exports = {
    getPriceList,
    matchBoqItems,
    quoteItemFromBoq,
    validateQuoteItems,
    selectOwned,
    getItems,
    getSettings,
    calculateAndPersist,
    amountInWordsIndian,
    renderPdf,
    renderExcel,
    parseJsonArray,
    supabase,
};
