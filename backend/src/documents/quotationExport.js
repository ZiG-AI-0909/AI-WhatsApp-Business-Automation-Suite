'use strict';

// Quotation exports.
//
// Excel replicates the hand-built reference workbook
// (BOQ_Quotation_Pipes_Belagavi_MGNVY2.xlsx): same header block, item table,
// section rows, LIVE formulas for amounts/tax/total, yellow input cells with
// blue text, and an optional "Internal - do not send" sheet with the
// customer's BOQ contract rates (only with ?internal=1).
//
// The PDF is customer-facing: it never contains ref_rate or the internal
// sheet. pdfkit with the built-in Helvetica keeps memory low on Render.

const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const domain = require('./quotationDomain');

const COLORS = {
    inputFill: 'FFFFF2CC',
    inputText: 'FF0000FF',
    headerFill: 'FFD9E1F2',
    sectionFill: 'FFEDEDED',
    internalTitle: 'FFC00000',
    border: 'FFBFBFBF',
};
const MONEY = '#,##0.00';
const AMOUNT_IN_WORDS_PLACEHOLDER = '[type the grand total in words once rates are filled]';
const INTERNAL_SHEET = 'Internal - do not send';

function fill(argb) {
    return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

const THIN = { style: 'thin', color: { argb: COLORS.border } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

function companyLine(company = {}) {
    return [
        company.address ? company.address.replace(/\s*\n\s*/g, ', ') : '[Registered office address]',
        `GSTIN: ${company.gstin || '[to fill]'}`,
        `Phone: ${company.phone || '[to fill]'}`,
        `Email: ${company.email || '[to fill]'}`,
    ].join('  |  ');
}

// Labels used both in the data-validation list and the CGST/IGST formulas;
// quotes and commas would break either, so they are stripped.
function supplyLabels(company = {}) {
    const state = String(company.state || '').replace(/["',]/g, '').trim().slice(0, 40);
    return { intra: state ? `Intra-state (${state})` : 'Intra-state', inter: 'Inter-state' };
}

function customerBlock(quotation) {
    return [
        quotation.customer_name,
        quotation.customer_address,
        quotation.customer_gstin ? `GSTIN: ${quotation.customer_gstin}` : '',
    ].filter(Boolean).join('\n');
}

function quoteNumberLabel(quotation) {
    if (quotation.quote_number) return quotation.quote_number;
    const fiscalYear = domain.fiscalYearFor(quotation.quote_date || domain.istDate());
    return `${domain.QUOTE_PREFIX}/${fiscalYear}/____ (assigned on finalize)`;
}

function exportGroups(items) {
    const included = items.filter((item) => item.include)
        .sort((a, b) => a.section.localeCompare(b.section) || a.line_no - b.line_no);
    return domain.SECTIONS
        .map((section) => ({ section, title: domain.SECTION_TITLES[section], lines: included.filter((item) => item.section === section) }))
        .filter((group) => group.lines.length);
}

function parseLogo(logo) {
    const match = String(logo || '').match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) return null;
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 1024 * 1024) return null;
    return { buffer, extension: match[1].toLowerCase().startsWith('jp') ? 'jpeg' : 'png' };
}

function estimateRowHeight(texts, charsPerLine, lineHeight = 13, min = 15) {
    const lines = Math.max(...texts.map((text) => String(text || '').split('\n')
        .reduce((total, part) => total + Math.max(1, Math.ceil(part.length / charsPerLine)), 0)));
    return Math.min(409, Math.max(min, lines * lineHeight + 4));
}

// ─── Excel ────────────────────────────────────────────────────

async function buildQuotationWorkbook({ quotation, items, totals, company = {}, logo = '', internal = false }) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = company.name || 'Quotation';
    workbook.created = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;
    const sheet = workbook.addWorksheet('Quotation', {
        views: [{ state: 'frozen', ySplit: 10, topLeftCell: 'A11', activeCell: 'A1' }],
        pageSetup: {
            paperSize: 9,
            orientation: 'landscape',
            fitToPage: true,
            fitToWidth: 1,
            fitToHeight: 0,
            printTitlesRow: '10:10',
            margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
        },
        headerFooter: { oddFooter: '&LQuotation &R Page &P of &N' },
    });
    // 9.1 not 9: ExcelJS drops widths equal to its default and Excel would fall back to 8.43.
    sheet.columns = [6, 9.1, 11, 52, 9.1, 8, 13, 13, 15, 9.1, 34].map((width) => ({ width }));
    const labels = supplyLabels(company);
    const input = (cell, numFmt) => {
        cell.fill = fill(COLORS.inputFill);
        cell.font = { color: { argb: COLORS.inputText }, size: 10 };
        if (numFmt) cell.numFmt = numFmt;
    };
    const merged = (range, value, { bold = false, size = 10, fillColor, align = 'left', wrap = true } = {}) => {
        sheet.mergeCells(range);
        const cell = sheet.getCell(range.split(':')[0]);
        cell.value = value;
        cell.font = { bold, size };
        cell.alignment = { horizontal: align, vertical: 'middle', wrapText: wrap };
        if (fillColor) cell.fill = fill(fillColor);
        return cell;
    };

    const image = parseLogo(logo);
    if (image) {
        const imageId = workbook.addImage({ buffer: image.buffer, extension: image.extension });
        sheet.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 60, height: 40 } });
    }
    merged('A1:K1', company.name || 'Quotation', { bold: true, size: 16, align: 'center' });
    sheet.getRow(1).height = 20;
    merged('A2:K2', companyLine(company), { align: 'center' });
    merged('A3:K3', quotation.status === 'draft' ? 'QUOTATION (DRAFT)' : 'QUOTATION', { bold: true, size: 13, fillColor: COLORS.headerFill, align: 'center' });

    const pair = (row, label, value, rightLabel, rightValue, rightFormat) => {
        merged(`A${row}:B${row}`, label, { bold: true });
        merged(`C${row}:G${row}`, value);
        merged(`H${row}:I${row}`, rightLabel, { bold: true });
        const cell = merged(`J${row}:K${row}`, rightValue);
        input(cell, rightFormat);
        return cell;
    };
    const quoteDate = quotation.quote_date ? new Date(`${quotation.quote_date}T00:00:00Z`) : new Date();
    pair(5, 'Quotation No.', quoteNumberLabel(quotation), 'Date', quoteDate, 'dd-mmm-yyyy');
    pair(6, 'To', customerBlock(quotation), 'Valid for (days)', Number(quotation.validity_days || 30));
    const supplyCell = pair(7, 'Project', quotation.project_name || '', 'Supply type', quotation.supply_type === 'inter' ? labels.inter : labels.intra);
    supplyCell.dataValidation = {
        type: 'list',
        allowBlank: false,
        formulae: [`"${labels.intra},${labels.inter}"`],
        showErrorMessage: true,
        errorTitle: 'Supply type',
        error: `Choose ${labels.intra} or ${labels.inter}.`,
    };
    const gstPercent = Number(quotation.gst_percent ?? 18);
    pair(8, 'Reference', quotation.reference_text || '', 'GST %', gstPercent / 100, Number.isInteger(gstPercent) ? '0%' : '0.00%');
    for (const row of [6, 7, 8]) {
        sheet.getRow(row).height = Math.max(30, estimateRowHeight([sheet.getCell(`C${row}`).value], 60));
    }

    const headers = ['S.No', 'BOQ Item No.', 'BOQ Item Code', 'Description (as per BOQ)', 'Size (mm)', 'Unit', 'Qty', 'Rate (Rs/unit)', 'Amount (Rs)', 'HSN', 'Remarks / check before sending'];
    const headerRow = sheet.getRow(10);
    headers.forEach((header, index) => {
        const cell = headerRow.getCell(index + 1);
        cell.value = header;
        cell.font = { bold: true, size: 10 };
        cell.fill = fill(COLORS.headerFill);
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = BORDER;
    });
    headerRow.height = 30;

    const quotationRows = new Map();
    let rowNumber = 11;
    let serial = 0;
    const groups = exportGroups(items);
    for (const group of groups) {
        merged(`A${rowNumber}:K${rowNumber}`, group.title, { bold: true, fillColor: COLORS.sectionFill, wrap: false });
        rowNumber++;
        for (const item of group.lines) {
            serial++;
            const row = sheet.getRow(rowNumber);
            const values = [
                serial,
                item.boq_item_no || '',
                item.boq_item_code || '',
                item.description || '',
                item.size_mm === null || item.size_mm === undefined ? '' : Number(item.size_mm),
                item.unit || '',
                item.qty === null || item.qty === undefined ? null : Number(item.qty),
                item.rate === null || item.rate === undefined ? null : Number(item.rate),
                null,
                item.hsn || '',
                item.remarks || '',
            ];
            values.forEach((value, index) => {
                const cell = row.getCell(index + 1);
                cell.value = value;
                cell.font = { size: 10 };
                cell.border = BORDER;
                cell.alignment = { vertical: 'top', wrapText: [3, 10].includes(index) };
            });
            row.getCell(7).numFmt = MONEY;
            input(row.getCell(8), MONEY);
            const amount = domain.lineAmount(item);
            row.getCell(9).value = {
                formula: `IF(H${rowNumber}="","",ROUND(G${rowNumber}*H${rowNumber},2))`,
                result: amount === null || amount === undefined ? '' : amount,
            };
            row.getCell(9).numFmt = MONEY;
            row.height = estimateRowHeight([item.description, item.remarks], 50);
            quotationRows.set(item.line_no, rowNumber);
            rowNumber++;
        }
    }
    if (!groups.length) {
        merged(`A${rowNumber}:K${rowNumber}`, 'No lines are included in this quotation.', { wrap: false });
        rowNumber++;
    }
    const lastItemRow = rowNumber - 1;

    rowNumber++;
    const totalRow = (label, value, { bold = false, format = MONEY, isInput = false, highlight = false } = {}) => {
        merged(`A${rowNumber}:H${rowNumber}`, label, { bold, align: 'right', wrap: false });
        const cell = sheet.getCell(`I${rowNumber}`);
        cell.value = value;
        cell.numFmt = format;
        cell.font = { bold, size: 10 };
        cell.border = BORDER;
        if (isInput) input(cell, format);
        if (highlight) cell.fill = fill(COLORS.headerFill);
        return rowNumber++;
    };
    const sub = totalRow('Sub-total', { formula: `SUM(I11:I${lastItemRow})`, result: totals.subtotal });
    const discountPct = totalRow('Discount % (optional)', Number(quotation.discount_percent || 0) / 100, { format: '0.0%', isInput: true });
    const discount = totalRow('Discount amount', { formula: `ROUND(I${sub}*I${discountPct},2)`, result: totals.discount_amount });
    const freight = totalRow('Freight / loading (optional)', Number(quotation.freight || 0), { isInput: true });
    const taxable = totalRow('Taxable value', { formula: `ROUND(I${sub}-I${discount}+I${freight},2)`, result: totals.taxable_value }, { bold: true });
    const cgst = totalRow('CGST', { formula: `IF($J$7="${labels.intra}",ROUND(I${taxable}*$J$8/2,2),0)`, result: totals.cgst });
    const sgst = totalRow('SGST', { formula: `IF($J$7="${labels.intra}",ROUND(I${taxable}*$J$8/2,2),0)`, result: totals.sgst });
    const igst = totalRow('IGST', { formula: `IF($J$7="${labels.inter}",ROUND(I${taxable}*$J$8,2),0)`, result: totals.igst });
    totalRow('GRAND TOTAL (Rs)', { formula: `ROUND(I${taxable}+I${cgst}+I${sgst}+I${igst},2)`, result: totals.grand_total }, { bold: true, highlight: true });

    rowNumber++;
    const allPriced = totals.included_lines > 0 && totals.unpriced_lines === 0;
    merged(`A${rowNumber}:B${rowNumber}`, 'Amount in words:', { bold: true, wrap: false });
    const words = merged(`C${rowNumber}:K${rowNumber}`, allPriced ? totals.amount_in_words : AMOUNT_IN_WORDS_PLACEHOLDER);
    if (!allPriced) input(words);
    rowNumber += 2;

    sheet.getCell(`A${rowNumber}`).value = 'Terms & conditions';
    sheet.getCell(`A${rowNumber}`).font = { bold: true, size: 10 };
    rowNumber++;
    for (const term of Array.isArray(quotation.terms) ? quotation.terms : []) {
        merged(`A${rowNumber}:K${rowNumber}`, `• ${term.text}`);
        sheet.getRow(rowNumber).height = estimateRowHeight([term.text], 150, 13, 15);
        rowNumber++;
    }
    rowNumber++;
    sheet.getCell(`A${rowNumber}`).value = `For ${String(company.name || '').toUpperCase()}`;
    sheet.getCell(`A${rowNumber}`).font = { bold: true, size: 10 };
    rowNumber += 3;
    sheet.getCell(`A${rowNumber}`).value = 'Authorised signatory';
    rowNumber += 2;
    merged(`A${rowNumber}:K${rowNumber}`, 'Legend: yellow cells with blue text are inputs. Enter Rate (column H); amounts, tax and total calculate automatically. Delete any row you will not quote. Rates are intentionally blank until typed.');
    sheet.getRow(rowNumber).height = 28;

    if (internal) addInternalSheet(workbook, { quotation, groups, quotationRows });
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

function addInternalSheet(workbook, { quotation, groups, quotationRows }) {
    const sheet = workbook.addWorksheet(INTERNAL_SHEET, { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    sheet.columns = [10, 11, 8, 13, 14, 18, 16, 12, 16, 26, 40, 60].map((width) => ({ width }));
    const title = sheet.getCell('A1');
    title.value = 'INTERNAL REFERENCE: contract rates from the BOQ (the contractor\'s rates for supply + laying + jointing + testing). NEVER use as our rate. Do not send this sheet.';
    title.font = { bold: true, size: 10, color: { argb: COLORS.internalTitle } };
    const headers = ['BOQ S.No', 'Item Code', 'Unit', 'Qty (BOQ)', 'Contract rate (ref)', 'Contract amount (BOQ)', 'Qty x rate (check)', 'Difference', 'Our rate (from Quotation)', 'Our rate vs contract rate', 'Integrity check', 'Full BOQ description'];
    const header = sheet.getRow(3);
    headers.forEach((label, index) => {
        const cell = header.getCell(index + 1);
        cell.value = label;
        cell.font = { bold: true, size: 10 };
        cell.fill = fill(COLORS.headerFill);
        cell.alignment = { wrapText: true, vertical: 'middle' };
        cell.border = BORDER;
    });
    header.height = 42;
    let rowNumber = 4;
    const pages = new Set();
    for (const group of groups) {
        for (const item of group.lines) {
            const source = item.spec?.source || {};
            if (source.page) pages.add(source.page);
            const quoteRow = quotationRows.get(item.line_no);
            const boqQty = item.spec?.boq_qty ?? item.qty;
            const row = sheet.getRow(rowNumber);
            row.getCell(1).value = item.boq_item_no || '';
            row.getCell(2).value = item.boq_item_code || '';
            row.getCell(3).value = item.unit || '';
            row.getCell(4).value = boqQty === null || boqQty === undefined ? null : Number(boqQty);
            row.getCell(5).value = item.ref_rate === null || item.ref_rate === undefined ? null : Number(item.ref_rate);
            row.getCell(6).value = item.ref_amount === null || item.ref_amount === undefined ? null : Number(item.ref_amount);
            row.getCell(7).value = { formula: `IF(OR(D${rowNumber}="",E${rowNumber}=""),"",ROUND(D${rowNumber}*E${rowNumber},2))` };
            row.getCell(8).value = { formula: `IF(OR(F${rowNumber}="",G${rowNumber}=""),"",ROUND(F${rowNumber}-G${rowNumber},2))` };
            row.getCell(9).value = { formula: `IF(Quotation!H${quoteRow}="","",Quotation!H${quoteRow})` };
            row.getCell(10).value = { formula: `IF(OR(I${rowNumber}="",E${rowNumber}=""),"",IF(I${rowNumber}>E${rowNumber},"ABOVE contract rate: check","OK"))` };
            row.getCell(11).value = (item.flags || []).map((flag) => flag.message).join('\n') || 'OK';
            row.getCell(12).value = item.boq_description || '';
            for (let column = 1; column <= 12; column++) {
                const cell = row.getCell(column);
                cell.font = { size: 10, color: { argb: [5, 6].includes(column) ? COLORS.inputText : 'FF000000' } };
                cell.border = BORDER;
                cell.alignment = { vertical: 'top', wrapText: [11, 12].includes(column) };
                if ([4, 5, 6, 7, 8, 9].includes(column)) cell.numFmt = MONEY;
            }
            row.height = estimateRowHeight([row.getCell(12).value, row.getCell(11).value], 70);
            rowNumber++;
        }
    }
    rowNumber++;
    const integrity = quotation.integrity || {};
    const notes = [
        `Source: BOQ page(s) ${[...pages].sort((a, b) => a - b).join(', ') || 'not recorded'} (rate and amount as extracted). Difference should be 0 (tolerance Rs ${domain.AMOUNT_TOLERANCE}); blue = read from the BOQ.`,
        'Contract rate includes laying, jointing, testing and the contractor\'s margin, so it is only a rough ceiling for a supply-only price.',
    ];
    if (integrity.boq_amount_sum !== null && integrity.boq_amount_sum !== undefined) {
        notes.push(`Sum of all BOQ amounts: ${domain.formatInr(integrity.boq_amount_sum)}; printed total: ${integrity.printed_total === null || integrity.printed_total === undefined ? 'not found' : domain.formatInr(integrity.printed_total)}${integrity.difference ? `; difference ${domain.formatInr(integrity.difference)}: verify against the scan` : ''}.`);
    }
    for (const note of notes) {
        sheet.getCell(`A${rowNumber}`).value = note;
        sheet.getCell(`A${rowNumber}`).font = { size: 10 };
        rowNumber++;
    }
}

// ─── PDF ──────────────────────────────────────────────────────

// Built-in PDF fonts are WinAnsi: keep Latin-1 plus common punctuation,
// replace anything else so a stray glyph can never break the layout.
function pdfText(value) {
    return String(value ?? '')
        .replace(/₹/g, 'Rs.')
        .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g, '?');
}

function money(value) {
    return value === null || value === undefined || value === '' ? '' : domain.formatInr(value);
}

const PDF_COLUMNS = [
    { key: 'serial', label: 'S.No', width: 26, align: 'center' },
    { key: 'boq_item_no', label: 'BOQ Item No.', width: 40, align: 'center' },
    { key: 'boq_item_code', label: 'BOQ Item Code', width: 52, align: 'center' },
    { key: 'description', label: 'Description', width: 231, align: 'left' },
    { key: 'size_mm', label: 'Size (mm)', width: 40, align: 'center' },
    { key: 'unit', label: 'Unit', width: 32, align: 'center' },
    { key: 'qty', label: 'Qty', width: 62, align: 'right' },
    { key: 'rate', label: 'Rate (Rs)', width: 64, align: 'right' },
    { key: 'amount', label: 'Amount (Rs)', width: 80, align: 'right' },
    { key: 'hsn', label: 'HSN', width: 38, align: 'center' },
    { key: 'remarks', label: 'Remarks', width: 104, align: 'left' },
];

async function renderQuotationPdf({ quotation, items, totals, company = {}, logo = '' }) {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, info: { Title: `Quotation ${quotation.quote_number || 'draft'}`, Author: company.name || '' } });
    const chunks = [];
    const done = new Promise((resolve, reject) => {
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 18; // room for the footer
    const pad = 3;
    const isDraft = quotation.status === 'draft';
    const ensureSpace = (height) => {
        if (doc.y + height > bottom()) {
            doc.addPage();
            return true;
        }
        return false;
    };

    // Header block
    const image = parseLogo(logo);
    if (image) {
        try { doc.image(image.buffer, left, 30, { fit: [70, 45] }); } catch (error) {
            console.warn('[quotations] company logo could not be embedded:', error.message);
        }
    }
    doc.font('Helvetica-Bold').fontSize(16).text(pdfText(company.name || 'Quotation'), left, 36, { width, align: 'center' });
    doc.font('Helvetica').fontSize(8.5).text(pdfText(companyLine(company)), left, doc.y + 2, { width, align: 'center' });
    const bannerY = doc.y + 6;
    doc.rect(left, bannerY, width, 20).fill('#D9E1F2');
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(12)
        .text(isDraft ? 'QUOTATION (DRAFT - not valid until finalized)' : 'QUOTATION', left, bannerY + 5, { width, align: 'center' });
    doc.y = bannerY + 28;

    // Info grid: To / Project / Reference on the left, numbers on the right.
    const labelWidth = 62;
    const rightWidth = 250;
    const leftWidth = width - rightWidth - 16;
    const rightX = left + leftWidth + 16;
    const infoTop = doc.y;
    const writePairs = (pairs, x, columnWidth) => {
        let y = infoTop;
        for (const [label, value] of pairs) {
            const text = pdfText(value || '-');
            doc.font('Helvetica').fontSize(8.5);
            const height = Math.min(70, doc.heightOfString(text, { width: columnWidth - labelWidth }));
            doc.font('Helvetica-Bold').text(label, x, y, { width: labelWidth });
            doc.font('Helvetica').text(text, x + labelWidth, y, { width: columnWidth - labelWidth, height, ellipsis: true });
            y += height + 4;
        }
        return y;
    };
    const supply = supplyLabels(company);
    const leftBottom = writePairs([
        ['To', customerBlock(quotation)],
        ['Project', quotation.project_name],
        ['Reference', quotation.reference_text],
    ], left, leftWidth);
    const rightBottom = writePairs([
        ['Quotation No.', quoteNumberLabel(quotation)],
        ['Date', quotation.quote_date ? new Date(`${quotation.quote_date}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''],
        ['Valid for', `${quotation.validity_days || 30} days`],
        ['Supply type', quotation.supply_type === 'inter' ? supply.inter : supply.intra],
        ['GST', `${Number(quotation.gst_percent ?? 18)}%`],
    ], rightX, rightWidth);
    doc.y = Math.max(leftBottom, rightBottom) + 6;

    // Item table
    const drawTableHeader = () => {
        const y = doc.y;
        doc.font('Helvetica-Bold').fontSize(7.5);
        const height = Math.max(...PDF_COLUMNS.map((column) => doc.heightOfString(column.label, { width: column.width - pad * 2 }))) + pad * 2;
        doc.rect(left, y, width, height).fill('#D9E1F2');
        doc.fillColor('#000000');
        let x = left;
        for (const column of PDF_COLUMNS) {
            doc.text(column.label, x + pad, y + pad, { width: column.width - pad * 2, align: 'center' });
            x += column.width;
        }
        doc.rect(left, y, width, height).lineWidth(0.5).strokeColor('#999999').stroke();
        doc.y = y + height;
    };
    // Very long rows are clipped with an ellipsis at this height, so no row can
    // run off the page; the full BOQ text stays in the app and internal Excel.
    const maxRowHeight = 260;
    const rowHeight = (values) => {
        doc.font('Helvetica').fontSize(7.5);
        const measured = Math.max(...PDF_COLUMNS.map((column) => doc.heightOfString(values[column.key] || ' ', { width: column.width - pad * 2 })));
        return Math.min(maxRowHeight, measured + pad * 2);
    };
    const rowValues = (item, serial) => ({
        serial: String(serial),
        boq_item_no: pdfText(item.boq_item_no),
        boq_item_code: pdfText(item.boq_item_code),
        description: pdfText(item.description),
        size_mm: item.size_mm === null || item.size_mm === undefined ? '' : String(Number(item.size_mm)),
        unit: pdfText(item.unit),
        qty: money(item.qty),
        rate: money(item.rate),
        amount: money(domain.lineAmount(item)),
        hsn: pdfText(item.hsn),
        remarks: pdfText(item.remarks),
    });
    const drawRow = (values) => {
        const height = rowHeight(values);
        if (ensureSpace(height)) drawTableHeader();
        const y = doc.y;
        let x = left;
        doc.font('Helvetica').fontSize(7.5).fillColor('#000000');
        for (const column of PDF_COLUMNS) {
            doc.text(values[column.key] || '', x + pad, y + pad, { width: column.width - pad * 2, height: height - pad * 2, align: column.align, ellipsis: true });
            x += column.width;
        }
        doc.lineWidth(0.3).strokeColor('#CCCCCC').moveTo(left, y + height).lineTo(left + width, y + height).stroke();
        doc.y = y + height;
    };
    drawTableHeader();
    let serial = 0;
    const groups = exportGroups(items);
    for (const group of groups) {
        // Keep the section title together with its first row.
        if (ensureSpace(14 + rowHeight(rowValues(group.lines[0], serial + 1)))) drawTableHeader();
        const y = doc.y;
        doc.rect(left, y, width, 14).fill('#EDEDED');
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(8).text(pdfText(group.title), left + pad, y + 3, { width: width - pad * 2, lineBreak: false, ellipsis: true });
        doc.y = y + 14;
        for (const item of group.lines) {
            serial++;
            drawRow(rowValues(item, serial));
        }
    }
    if (!groups.length) drawRow({ description: 'No lines are included in this quotation.' });

    // Totals
    const intra = quotation.supply_type !== 'inter';
    const gst = Number(quotation.gst_percent ?? 18);
    const totalLines = [
        ['Sub-total', totals.subtotal],
        [`Discount (${Number(quotation.discount_percent || 0)}%)`, totals.discount_amount],
        ['Freight / loading', totals.freight],
        ['Taxable value', totals.taxable_value, true],
        ...(intra ? [[`CGST (${gst / 2}%)`, totals.cgst], [`SGST (${gst / 2}%)`, totals.sgst]] : [[`IGST (${gst}%)`, totals.igst]]),
        ['GRAND TOTAL (Rs)', totals.grand_total, true],
    ];
    const totalsWidth = 300;
    const totalsX = left + width - totalsWidth;
    ensureSpace(totalLines.length * 14 + 50);
    doc.y += 8;
    for (const [label, value, bold] of totalLines) {
        const y = doc.y;
        if (label.startsWith('GRAND')) doc.rect(totalsX, y - 2, totalsWidth, 15).fill('#D9E1F2').fillColor('#000000');
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
        doc.text(label, totalsX + 4, y, { width: 180 });
        doc.text(money(value), totalsX + 184, y, { width: totalsWidth - 188, align: 'right' });
        doc.y = y + 14;
    }
    if (totals.unpriced_lines) {
        doc.font('Helvetica-Oblique').fontSize(8).fillColor('#B00000')
            .text(`${totals.unpriced_lines} included line(s) are not priced yet; their amounts are not in the totals.`, totalsX, doc.y, { width: totalsWidth, align: 'right' });
        doc.fillColor('#000000');
    }
    doc.y += 6;
    const allPriced = totals.included_lines > 0 && totals.unpriced_lines === 0;
    ensureSpace(30);
    doc.font('Helvetica-Bold').fontSize(8.5).text('Amount in words: ', left, doc.y, { continued: true })
        .font('Helvetica').text(allPriced ? totals.amount_in_words : AMOUNT_IN_WORDS_PLACEHOLDER, { width });

    // Terms, signature
    doc.y += 8;
    ensureSpace(40);
    doc.font('Helvetica-Bold').fontSize(9).text('Terms & conditions', left, doc.y, { width });
    doc.font('Helvetica').fontSize(8);
    for (const term of Array.isArray(quotation.terms) ? quotation.terms : []) {
        const text = pdfText(term.text);
        ensureSpace(doc.heightOfString(text, { width: width - 12 }) + 4);
        const y = doc.y + 2;
        doc.text('•', left, y, { width: 10 });
        doc.text(text, left + 12, y, { width: width - 12 });
    }
    ensureSpace(70);
    doc.y += 14;
    doc.font('Helvetica-Bold').fontSize(9).text(`For ${pdfText(String(company.name || '').toUpperCase())}`, left, doc.y, { width });
    doc.y += 30;
    doc.font('Helvetica').fontSize(9).text('Authorised signatory', left, doc.y, { width });

    // Footer with page numbers on every page. The bottom margin is lifted
    // while writing so pdfkit does not start a new page for the footer.
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index++) {
        doc.switchToPage(index);
        const margin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font('Helvetica').fontSize(7.5).fillColor('#555555')
            .text(`${pdfText(quotation.quote_number || 'Draft quotation')}  |  Page ${index + 1} of ${range.count}`, left, doc.page.height - 24, { width, align: 'center', lineBreak: false });
        doc.page.margins.bottom = margin;
    }
    doc.fillColor('#000000');
    doc.end();
    return done;
}

module.exports = {
    INTERNAL_SHEET,
    AMOUNT_IN_WORDS_PLACEHOLDER,
    buildQuotationWorkbook,
    renderQuotationPdf,
    supplyLabels,
    pdfText,
};
