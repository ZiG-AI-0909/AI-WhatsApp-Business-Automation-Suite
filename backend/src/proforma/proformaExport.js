'use strict';

// Proforma invoice -> Excel, replicating the supplied reference invoice
// (Alfatth_26-27/PI-03R5): same blocks, merged ranges, borders, column
// widths and fonts, with LIVE formulas for every amount and total, the
// amount in words, and the payment text that quotes the advance/balance.
//
// Column map (pixel widths measured from the reference, A..L = 806 px):
//   A Sl. No. | B size | C:E specification | F pressure | G coupler   <- "Description of Goods" B:G
//   H length  | I HSN  | J quantity | K unit price | L amount
// Column O row 3 holds the advance payment (outside the print area), so
// editing it in Excel updates the payment text and the balance.
//
// Merged ranges carry their border on the top-left cell: ExcelJS gives every
// cell of a merge the same style object, so the outline draws correctly.

const ExcelJS = require('exceljs');
const calc = require('./proformaCalculation');

const COLUMN_PX = [48, 40, 60, 32, 48, 87, 91, 66, 72, 86, 88, 88];
const FONT = 'Calibri';
const SIZE = 10;
const LINE = 12.75; // points per text line at Calibri 10
const THIN = { style: 'thin', color: { argb: 'FF000000' } };
const INPUT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
const ADVANCE_CELL = '$O$3';
const FOOTER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8732A' } };
let LOGO = null;
try { LOGO = require('fs').readFileSync(require('path').join(__dirname, 'assets', 'sudarshan-logo.png')); } catch { LOGO = null; }

const pxToWidth = (px) => Math.round(((px - 5) / 7) * 100) / 100;

function rangePx(fromCol, toCol) {
    return COLUMN_PX.slice(fromCol - 1, toCol).reduce((total, px) => total + px, 0);
}

// Calibri advance widths for ASCII 32-126 at 100 px (regular, bold), used to
// size wrapped rows: Excel never auto-fits merged cells, so a row that is
// too short hides the wrapped text. 3% is added as a safety margin.
const CALIBRI = '23,33,40,50,51,71,68,22,30,30,50,50,25,31,25,39,51,51,51,51,51,51,51,51,51,51,27,27,50,50,50,46,89,58,54,53,62,49,46,63,62,25,32,52,42,85,65,66,52,67,54,46,49,64,57,89,52,49,47,31,39,31,50,50,29,48,53,42,53,50,31,47,53,23,24,45,23,80,53,53,53,53,35,39,33,53,45,71,43,45,40,31,46,31,50'.split(',').map(Number);
const CALIBRI_BOLD = '23,33,44,50,51,73,70,23,31,31,50,50,26,31,27,43,51,51,51,51,51,51,51,51,51,51,28,28,50,50,50,46,90,61,56,53,63,49,46,64,63,27,33,55,42,87,66,68,53,69,56,47,50,65,59,91,55,52,48,32,43,32,50,50,30,49,54,42,54,50,32,47,54,25,26,48,25,81,54,54,54,54,36,40,35,54,47,75,46,47,40,34,48,34,50'.split(',').map(Number);
const PT_TO_PX = 4 / 3;

function textPx(text, size = SIZE, bold = false) {
    const table = bold ? CALIBRI_BOLD : CALIBRI;
    const units = Array.from(String(text)).reduce((total, char) => {
        const code = char.charCodeAt(0);
        return total + (code >= 32 && code < 127 ? table[code - 32] : 50);
    }, 0);
    return (units / 100) * size * PT_TO_PX * 1.03;
}

// Lines after Excel-style word wrap in a box widthPx wide.
function lineCount(text, widthPx, size = SIZE, bold = false) {
    const room = Math.max(20, widthPx - 5); // Excel's cell padding
    return String(text ?? '').split('\n').reduce((total, paragraph) => {
        let lines = 1;
        let used = 0;
        for (const word of paragraph.split(/(?<= )/)) {
            const width = textPx(word, size, bold);
            if (used > 0 && used + textPx(word.trimEnd(), size, bold) > room) {
                lines++;
                used = 0;
            }
            // A single word longer than the box breaks across lines.
            if (width > room) {
                lines += Math.floor(width / room);
                used = width % room;
            } else {
                used += width;
            }
        }
        return total + lines;
    }, 0);
}

// Item cells stay on one line as in the reference unless the text clearly
// cannot fit (no safety margin here, Excel's own padding only).
function fitsOneLine(text, widthPx, size = SIZE) {
    return !String(text || '').includes('\n') && textPx(text, size) / 1.03 <= widthPx - 3;
}

function borderOf(sides = '') {
    const border = {};
    if (sides.includes('t')) border.top = THIN;
    if (sides.includes('l')) border.left = THIN;
    if (sides.includes('b')) border.bottom = THIN;
    if (sides.includes('r')) border.right = THIN;
    return border;
}

function runs(segments, base = {}) {
    return segments.filter((segment) => segment.text).map((segment) => ({
        text: segment.text,
        font: { name: FONT, size: base.size || SIZE, bold: Boolean(segment.bold || base.bold), ...(segment.vertAlign ? { vertAlign: segment.vertAlign } : {}), ...(base.underline ? { underline: true } : {}) },
    }));
}

function ordinal(day) {
    if (day % 100 >= 11 && day % 100 <= 13) return 'th';
    return { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th';
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "Dated: 26th October 2026" with a superscript ordinal, as in the reference.
function datedSegments(isoDate) {
    const [year, month, day] = String(isoDate || '').split('-').map(Number);
    if (!year || !month || !day) return [{ text: 'Dated: ' }];
    return [{ text: `Dated: ${day}` }, { text: ordinal(day), vertAlign: 'superscript' }, { text: ` ${MONTHS[month - 1]} ${year}` }];
}

function formatDate(isoDate) {
    const [year, month, day] = String(isoDate || '').split('-').map(Number);
    return year && month && day ? `${String(day).padStart(2, '0')}-${MONTHS[month - 1].slice(0, 3)}-${year}` : '';
}

function joinParts(parts, separator = ', ') {
    return parts.map((part) => String(part || '').trim()).filter(Boolean).join(separator);
}

// Address followed by the country unless the address already ends with it.
function withCountry(address, country) {
    const text = String(address || '').trim();
    const name = String(country || '').trim();
    if (!name || text.toLowerCase().replace(/[\s.]+$/, '').endsWith(name.toLowerCase())) return text;
    return text ? `${text}, ${name}` : name;
}

function addressLines(address, count) {
    const lines = String(address || '').split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length <= count) return [...lines, ...Array(count - lines.length).fill('')];
    return [...lines.slice(0, count - 1), lines.slice(count - 1).join(', ')];
}

function coupler(value) {
    const text = String(value || '').trim();
    return !text || /^\(.*\)$/.test(text) ? text : `(${text})`;
}

function numericOrBlank(value) {
    const number = calc.toNumber(value);
    return number === null || Number.isNaN(number) ? null : number;
}

// A text that quotes {advance}/{balance}/{grand_total} becomes a formula
// so it follows edits made in Excel; other text becomes rich text (bold).
function templateValue(segments, refs) {
    if (!calc.isDynamic(segments)) return { richText: runs(segments) };
    const parts = [];
    let literal = '';
    for (const segment of segments) {
        if (!segment.amount) {
            literal += segment.text || '';
            continue;
        }
        if (literal) parts.push(calc.excelString(literal));
        literal = '';
        const expression = { advance: refs.advance, balance: `${refs.grand}-${refs.advance}`, grand_total: refs.grand }[segment.amount];
        parts.push(`FIXED(${expression},2)`);
    }
    if (literal) parts.push(calc.excelString(literal));
    return { formula: parts.join('&'), result: calc.segmentsToText(segments) };
}

async function buildProformaWorkbook(invoice, { totals = calc.calculate(invoice) } = {}) {
    const currency = calc.currencyInfo(invoice.invoice.currency);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = invoice.exporter.signatory_name || invoice.exporter.name || 'Proforma Invoice';
    workbook.created = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;
    const sheet = workbook.addWorksheet('Proforma Invoice', {
        properties: { defaultRowHeight: LINE },
        pageSetup: {
            paperSize: 9,
            orientation: 'portrait',
            horizontalCentered: true,
            margins: { left: 0.35, right: 0.35, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
        },
    });
    sheet.columns = [...COLUMN_PX.map((px) => ({ width: pxToWidth(px) })), { width: 2.5 }, { width: 30 }, { width: 14 }];

    const heights = new Map();
    const needHeight = (row, points) => heights.set(row, Math.max(heights.get(row) || LINE, Math.min(409, points)));
    const fitText = (row, rows, text, fromCol, toCol, size = SIZE, bold = false) => {
        const needed = lineCount(text, rangePx(fromCol, toCol), size, bold) * LINE * (size / SIZE) + 2;
        const have = (rows - 1) * LINE;
        if (needed > have + LINE) needHeight(row + rows - 1, needed - have);
    };

    // One box = one cell or merged range with its own outline.
    const put = (range, value, { bold = false, size = SIZE, align = 'left', valign = 'middle', wrap = true, border = '', numFmt, underline = false, fill } = {}) => {
        const [from, to] = range.split(':');
        if (to && to !== from) sheet.mergeCells(range);
        const cell = sheet.getCell(from);
        cell.value = value === undefined || value === '' ? null : value;
        cell.font = { name: FONT, size, bold, ...(underline ? { underline: true } : {}) };
        cell.alignment = { horizontal: align, vertical: valign, wrapText: wrap };
        cell.border = borderOf(border);
        if (numFmt) cell.numFmt = numFmt;
        if (fill) cell.fill = fill;
        return cell;
    };
    const textOf = (text) => (text ? String(text) : null);

    // Rich text with bold labels: [['Label: ', true], ['value', false], ...]
    const labelled = (parts) => {
        const kept = parts.filter(([text]) => text);
        return kept.length ? { richText: runs(kept.map(([text, bold]) => ({ text, bold }))) } : null;
    };
    const pairs = (...entries) => entries.filter(([, value]) => String(value || '').trim())
        .flatMap(([label, value], index) => [[index ? ' | ' : '', false], [label, true], [String(value).trim(), false]]);

    // ── Letterhead logo and title ───────────────────────────
    const letterhead = invoice.letterhead || {};
    let row = 1;
    if (letterhead.show_logo !== false && LOGO) {
        const logoId = workbook.addImage({ buffer: LOGO, extension: 'png' });
        sheet.addImage(logoId, { tl: { col: 0.15, row: 0.15 }, ext: { width: 236, height: 60 }, editAs: 'oneCell' });
        needHeight(row, 50);
        row++;
    }
    const titleRow = row++;
    put(`A${titleRow}:L${titleRow}`, 'PROFORMA INVOICE', { bold: true, size: 11, align: 'center', border: 'b' });
    needHeight(titleRow, 16);

    // ── Exporter (left) / number, date, enquiry (right): 6 rows ──
    const exporter = invoice.exporter;
    const [address1, address2] = addressLines(exporter.address, 2);
    const top = row;
    const left = (offset, value, options = {}) => put(`A${top + offset}:G${top + offset}`, value, options);
    left(0, 'Manufacturer & Exporter:', { bold: true, border: 'tl' });
    left(1, textOf(exporter.name), { bold: true, border: 'l' });
    left(2, textOf(address1), { border: 'l' });
    left(3, textOf(address2), { border: 'l' });
    left(4, labelled(pairs(['GSTIN: ', exporter.gstin], ['IEC: ', exporter.iec])), { border: 'l' });
    left(5, exporter.contact ? labelled([['Contact: ', true], [exporter.contact, false]]) : null, { border: 'lb' });
    fitText(top + 5, 1, `Contact: ${exporter.contact}`, 1, 7);
    put(`H${top}:L${top}`, 'Proforma Invoice No. & Date', { bold: true, border: 'tlr' });
    put(`H${top + 1}:L${top + 1}`, textOf(invoice.invoice.number), { border: 'lr' });
    put(`H${top + 2}:L${top + 3}`, { richText: runs(datedSegments(invoice.invoice.date), { bold: true }) }, { valign: 'top', border: 'lrb' });
    put(`H${top + 4}:L${top + 4}`, "Buyer's Enquiry / Purchase Order No. & Date", { bold: true, border: 'lr' });
    const enquiry = joinParts([
        invoice.invoice.enquiry_ref.replace(/\s*\n\s*/g, ' '),
        invoice.invoice.po_number ? `PO No. ${invoice.invoice.po_number}${invoice.invoice.po_date ? ` dated ${formatDate(invoice.invoice.po_date)}` : ''}` : '',
    ], '; ');
    put(`H${top + 5}:L${top + 5}`, textOf(enquiry), { size: 8, border: 'lrb' });
    fitText(top + 5, 1, enquiry, 8, 12, 8);

    // ── Consignee (left) / buyer (right): 6 rows ────────────
    const parties = top + 6;
    const consignee = invoice.consignee;
    const buyer = invoice.buyer;
    const consigneeAddress = withCountry(consignee.address, consignee.country).replace(/\s*\n\s*/g, ', ');
    const [buyer1, buyer2] = addressLines(withCountry(buyer.address, buyer.country), 2);
    const partyRows = [
        ['Consignee:', 'Buyer / Notifying Party: (If other than Consignee)', true],
        [textOf(consignee.name), textOf(buyer.name), true],
        [textOf(consigneeAddress), textOf(buyer1), false],
        [labelled(pairs(['Tax Registration Number: ', consignee.tax_id])), textOf(buyer2), false],
        [labelled(pairs(['ACID No.: ', consignee.acid])), labelled(pairs(['Tax Registration Number: ', buyer.tax_id])), false],
        [labelled(pairs(['Email ID: ', consignee.email], ['Tel. ', consignee.phone])), labelled(pairs(['Attn: ', buyer.contact_person], ['Emailid: ', buyer.email], ['Tel. ', buyer.phone])), false],
    ];
    partyRows.forEach(([leftValue, rightValue, bold], offset) => {
        const at = parties + offset;
        const last = offset === partyRows.length - 1;
        put(`A${at}:G${at}`, leftValue, { bold, border: last ? 'lb' : 'l' });
        put(`H${at}:L${at}`, rightValue, { bold, border: last ? 'lrb' : 'lr' });
    });
    fitText(parties + 2, 1, consigneeAddress, 1, 7);
    const plain = (value) => (value?.richText ? value.richText.map((run) => run.text).join('') : String(value || ''));
    fitText(parties + 5, 1, plain(partyRows[5][0]), 1, 7);
    fitText(parties + 5, 1, plain(partyRows[5][1]), 8, 12);
    fitText(parties + 4, 1, plain(partyRows[4][0]), 1, 7);

    // ── Pre-carriage and countries: 2 rows ──────────────────
    const shipping = invoice.shipping;
    const carriage = parties + 6;
    put(`A${carriage}:C${carriage}`, 'Pre - Carriage by', { bold: true, border: 'l' });
    put(`D${carriage}:G${carriage}`, 'Place of Receipt by Pre - Carrier', { bold: true, border: 'l' });
    put(`H${carriage}:J${carriage}`, 'Country of Origin of Goods', { bold: true, border: 'l' });
    put(`K${carriage}:L${carriage}`, 'Country of Final Destination', { bold: true, border: 'lr' });
    put(`A${carriage + 1}:C${carriage + 1}`, textOf(shipping.pre_carriage), { border: 'lb' });
    put(`D${carriage + 1}:G${carriage + 1}`, textOf(shipping.place_of_receipt), { border: 'lb' });
    put(`H${carriage + 1}:J${carriage + 1}`, textOf(shipping.origin_country), { align: 'center', border: 'lb' });
    put(`K${carriage + 1}:L${carriage + 1}`, textOf(shipping.destination_country), { align: 'center', border: 'lrb' });
    fitText(carriage + 1, 1, shipping.place_of_receipt, 4, 7);

    // ── Container, ports (left) / delivery, payment, bank (right): 7 rows
    const ports = carriage + 2;
    const deliveryTerms = shipping.delivery_terms.trim() || joinParts([shipping.incoterm, shipping.incoterm_place], ' ');
    put(`A${ports}:C${ports}`, 'Container No.', { bold: true, border: 'l' });
    put(`A${ports + 1}:C${ports + 1}`, textOf(shipping.container_no), { border: 'l' });
    put(`A${ports + 2}:C${ports + 2}`, labelled([['Vessel / Flight No.', true], [shipping.vessel_no ? ` ${shipping.vessel_no}` : '', false]]), { border: 'lb' });
    put(`D${ports}:G${ports}`, 'Port of Loading', { bold: true, border: 'l' });
    put(`D${ports + 1}:G${ports + 2}`, textOf(shipping.port_of_loading), { valign: 'bottom', border: 'lb' });
    put(`A${ports + 3}:C${ports + 3}`, 'Port of Discharge', { bold: true, border: 'l' });
    put(`D${ports + 3}:G${ports + 3}`, 'Final Destination', { bold: true, border: 'l' });
    put(`A${ports + 4}:C${ports + 6}`, textOf(shipping.port_of_discharge), { border: 'lb' });
    put(`D${ports + 4}:G${ports + 6}`, textOf(shipping.place_of_delivery), { border: 'lb' });
    put(`H${ports}:L${ports}`, 'Terms of Delivery and Payment:', { bold: true, border: 'lr' });
    put(`H${ports + 1}:L${ports + 1}`, labelled([['Delivery: ', true], [deliveryTerms, false]]), { border: 'lr' });
    const refs = { advance: ADVANCE_CELL, grand: null };
    const paymentRow = ports + 2;
    const paymentCell = put(`H${paymentRow}:L${paymentRow + 1}`, null, { valign: 'top', border: 'lr' });
    put(`H${ports + 4}:L${ports + 4}`, 'Payment to be made to our bank account:', { bold: true, underline: true, border: 'lr' });
    const bank = invoice.bank;
    put(`H${ports + 5}:L${ports + 5}`, joinParts([bank.name, bank.branch]) || null, { border: 'lr' });
    put(`H${ports + 6}:L${ports + 6}`, labelled([
        [bank.account ? 'A/c No.: ' : '', false], [bank.account, true],
        [bank.swift ? ' SWIFT Code: ' : '', false], [bank.swift, true],
        [bank.ifsc ? ` IFSC: ${bank.ifsc}` : '', false],
    ]), { border: 'lrb' });

    // ── Product table ───────────────────────────────────────
    const headerRow = ports + 7;
    const headers = [
        ['A', 'Sl. No.'], ['B:G', 'Description of Goods'], ['H', 'Length per Piece'], ['I', 'H S Code'],
        ['J', 'Quantity (Pieces)'], ['K', `Unit Price (${currency.code} / Piece)`], ['L', `Amount (${currency.code})`],
    ];
    for (const [columns, label] of headers) {
        const [from, to] = columns.split(':');
        put(to ? `${from}${headerRow}:${to}${headerRow}` : `${from}${headerRow}`, label, { bold: true, align: 'center', border: 'tlbr' });
    }
    needHeight(headerRow, 2 * LINE + 2);

    row = headerRow + 1;
    // Seven table boxes per row; `full` adds the top/bottom rule.
    const tableRow = (values, { full = false, bold = false } = {}) => {
        const sides = full ? 'tlbr' : 'lr';
        const at = (column) => `${column}${row}`;
        put(at('A'), values.A ?? null, { bold, align: 'center', border: sides });
        put(`B${row}:G${row}`, values.B ?? null, { bold, border: sides });
        put(at('H'), values.H ?? null, { align: 'center', border: sides });
        put(at('I'), values.I ?? null, { align: 'center', border: sides });
        put(at('J'), values.J ?? null, { bold, align: 'right', border: sides, numFmt: '#,##0' });
        put(at('K'), values.K ?? null, { align: 'right', border: sides, numFmt: '#,##0.00' });
        put(at('L'), values.L ?? null, { bold, align: 'right', border: sides, numFmt: '#,##0.00' });
        if (typeof values.B === 'string') fitText(row, 1, values.B, 2, 7, SIZE, bold);
        return row++;
    };
    const amountFormula = (r, result) => ({ formula: `IF(OR(J${r}="",K${r}=""),"",ROUND(J${r}*K${r},2))`, result: result ?? '' });

    const amounts = new Map(totals.items.map((item) => [item.id, item.amount]));
    const firstItemRow = row;
    let serial = 0;
    let group = null;
    for (const item of invoice.items) {
        const heading = item.description.trim();
        if (heading && heading !== group) tableRow({ B: heading }, { bold: true });
        group = heading || group;
        serial++;
        // Item rows split "Description of Goods" into size / spec / pressure / coupler.
        put(`A${row}`, serial, { align: 'center', border: 'lr' });
        const cells = [
            ['B', null, item.size, SIZE, 'l'],
            ['C', 'E', item.specification, SIZE, ''],
            ['F', null, item.pressure, SIZE, ''],
            ['G', null, coupler(item.coupler), 7.5, 'r'],
        ];
        for (const [from, to, value, size, border] of cells) {
            const width = rangePx(from.charCodeAt(0) - 64, (to || from).charCodeAt(0) - 64);
            const single = fitsOneLine(value, width, size);
            put(to ? `${from}${row}:${to}${row}` : `${from}${row}`, textOf(value), { size, border, wrap: !single });
            if (!single) fitText(row, 1, value, from.charCodeAt(0) - 64, (to || from).charCodeAt(0) - 64, size);
        }
        const length = numericOrBlank(item.length);
        put(`H${row}`, length, { align: 'center', border: 'lr', numFmt: '0.0" Mtr."' });
        put(`I${row}`, textOf(item.hsn), { align: 'center', border: 'lr' });
        put(`J${row}`, numericOrBlank(item.qty), { align: 'right', border: 'lr', numFmt: '#,##0' });
        put(`K${row}`, numericOrBlank(item.rate), { align: 'right', border: 'lr', numFmt: '#,##0.00' });
        put(`L${row}`, amountFormula(row, amounts.get(item.id)), { align: 'right', border: 'lr', numFmt: '#,##0.00' });
        row++;
    }
    const lastItemRow = row - 1;

    const exWorksRow = tableRow({
        A: 'I',
        B: 'Total - Ex-Works',
        J: { formula: `SUM(J${firstItemRow}:J${lastItemRow})`, result: totals.total_qty },
        L: { formula: `SUM(L${firstItemRow}:L${lastItemRow})`, result: totals.ex_works },
    }, { full: true, bold: true });
    const freightRow = (freight, amount) => tableRow({
        B: freight.description,
        H: textOf(freight.unit),
        J: numericOrBlank(freight.qty),
        K: numericOrBlank(freight.rate),
        L: amountFormula(row, amount),
    }, { full: true });
    const inlandRow = invoice.inland_freight.include ? freightRow(invoice.inland_freight, totals.inland_freight) : null;
    const fobRow = tableRow({
        A: 'II',
        B: 'Total - FOB Value',
        L: { formula: inlandRow ? `SUM(L${exWorksRow},L${inlandRow})` : `L${exWorksRow}`, result: totals.fob },
    }, { full: true, bold: true });
    const addRows = [`L${fobRow}`];
    let oceanRow = null;
    if (invoice.ocean_freight.include) {
        tableRow({ B: 'Freight Charges #' }, { full: true, bold: true });
        oceanRow = freightRow(invoice.ocean_freight, totals.ocean_freight);
        addRows.push(`L${oceanRow}`);
    }
    const otherRows = [];
    for (const charge of invoice.other_charges) {
        const result = totals.other_charges.find((entry) => entry.id === charge.id);
        const chargeRow = tableRow({
            B: charge.include_in_total ? charge.description : `${charge.description} (not included in Grand Total)`,
            H: textOf(charge.unit),
            J: numericOrBlank(charge.qty),
            K: numericOrBlank(charge.rate),
            L: amountFormula(row, result?.amount),
        }, { full: true });
        otherRows.push(chargeRow);
        if (charge.include_in_total) addRows.push(`L${chargeRow}`);
    }
    const grandRow = tableRow({
        A: 'III',
        B: `Total - ${joinParts([shipping.incoterm, 'Value'], ' ')}`,
        L: { formula: addRows.length > 1 ? `SUM(${addRows.join(',')})` : addRows[0], result: totals.grand_total },
    }, { full: true, bold: true });
    refs.grand = `$L$${grandRow}`;

    // ── Amount in words (follows the total by formula) ──────
    const wordsRow = row++;
    put(`A${wordsRow}:D${wordsRow}`, 'Amount in Words:', { bold: true, border: 'tlbr' });
    put(`E${wordsRow}:L${wordsRow}`, { formula: calc.wordsFormula(refs.grand, invoice.invoice.currency), result: totals.amount_in_words }, { border: 'tlbr' });
    fitText(wordsRow, 1, totals.amount_in_words, 5, 12);

    // ── Terms & conditions ──────────────────────────────────
    const termsLabelRow = row++;
    put(`A${termsLabelRow}:L${termsLabelRow}`, 'TERMS & CONDITIONS:', { bold: true, border: 'tlbr' });
    const termRows = [];
    invoice.terms.filter((term) => term.title.trim() || term.text.trim()).forEach((term, index) => {
        const segments = calc.parseTemplate(term.text, invoice, totals);
        put(`A${row}`, index + 1, { bold: true, align: 'center', border: 'tlbr' });
        put(`B${row}:D${row}`, textOf(term.title), { bold: true, border: 'tlbr' });
        put(`E${row}:L${row}`, templateValue(segments, refs), { border: 'tlbr' });
        const termText = calc.segmentsToText(segments);
        needHeight(row, Math.max(lineCount(termText, rangePx(5, 12)), lineCount(term.title, rangePx(2, 4), SIZE, true)) * LINE + 2);
        termRows.push(row++);
    });

    // ── Acceptance and signatures ───────────────────────────
    const buyerName = (buyer.signatory_name || (buyer.name || consignee.name || '').toUpperCase()).trim();
    const signRow = row;
    put(`A${row}:G${row}`, 'Accepted By Buyer', { bold: true, align: 'center', border: 'tl' });
    put(`H${row}:L${row}`, null, { border: 'tr' });
    row++;
    put(`A${row}:G${row}`, buyerName ? `For ${buyerName}` : 'For Buyer', { bold: true, align: 'center', border: 'l' });
    put(`H${row}:L${row}`, `For ${exporter.signatory_name || exporter.name}`, { bold: true, align: 'center', border: 'r' });
    row++;
    for (let blank = 0; blank < 4; blank++, row++) {
        put(`A${row}:G${row}`, null, { border: 'l' });
        put(`H${row}:L${row}`, null, { border: 'r' });
    }
    put(`A${row}:G${row}`, 'Authorised Signatory', { bold: true, align: 'center', border: 'lb' });
    put(`H${row}:L${row}`, 'Authorised Signatory', { bold: true, align: 'center', border: 'rb' });
    let lastRow = row;

    // ── Letterhead footer band ──────────────────────────────
    const footer = [
        [letterhead.footer_title, 14, 'FF1F2F7A', 22],
        [letterhead.footer_address, 11, 'FFFFFFFF', 17],
        [letterhead.footer_contact, 11, 'FFFFFFFF', 17],
    ].filter(([text]) => String(text || '').trim());
    if (footer.length) lastRow++;
    for (const [text, size, color, height] of footer) {
        lastRow++;
        const cell = put(`A${lastRow}:L${lastRow}`, String(text).trim(), { align: 'center', fill: FOOTER_FILL, wrap: false });
        cell.font = { name: FONT, size, bold: true, color: { argb: color } };
        needHeight(lastRow, height);
    }

    // Payment text needs the grand total row, so it is written last.
    const paymentSegments = calc.parseTemplate(invoice.payment.summary, invoice, totals);
    paymentCell.value = templateValue(paymentSegments, refs);
    fitText(paymentRow, 2, calc.segmentsToText(paymentSegments), 8, 12);

    // ── Excel-only input (outside the print area) ───────────
    put('N2:O2', 'Excel inputs (not printed)', { bold: true, wrap: false });
    put('N3', `Advance payment (${currency.code})`, { wrap: false });
    const advanceCell = put('O3', numericOrBlank(invoice.payment.advance), { align: 'right', numFmt: '#,##0.00', border: 'tlbr', fill: INPUT_FILL });
    advanceCell.font = { name: FONT, size: SIZE, color: { argb: 'FF0000FF' } };
    put('N4:O5', 'Used by the payment text and the balance. Edit quantities and prices in columns J and K; totals recalculate.', { size: 8, valign: 'top' });

    for (const [rowNumber, height] of heights) sheet.getRow(rowNumber).height = height;
    for (let blank = signRow + 2; blank < lastRow; blank++) sheet.getRow(blank).height = 15;

    const rowsUsed = lastRow;
    // ExcelJS prefixes "$" to each end, so this is written as $A$1:$L$n.
    sheet.pageSetup.printArea = `A$1:L$${lastRow}`;
    sheet.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;
    sheet.pageSetup.fitToPage = true;
    sheet.pageSetup.fitToWidth = 1;
    // One page while that stays legible; longer invoices flow onto more
    // pages with the table header repeated.
    sheet.pageSetup.fitToHeight = rowsUsed <= 80 ? 1 : 0;
    sheet.headerFooter = { oddFooter: rowsUsed <= 80 ? '' : '&R&8Page &P of &N' };

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
        buffer,
        layout: {
            headerRow, firstItemRow, lastItemRow, exWorksRow, inlandRow, fobRow, oceanRow, otherRows, grandRow,
            titleRow, top, parties, carriage, ports, wordsRow, termsLabelRow, termRows, signRow, lastRow, advanceCell: ADVANCE_CELL.replace(/\$/g, ''), paymentCell: `H${paymentRow}`,
        },
    };
}

// Proforma_Invoice_PI-03R5_2026-10-26.xlsx (the part after the last "/").
function exportFileName(invoice) {
    const number = String(invoice.invoice.number || 'draft').split('/').pop();
    const safe = number.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'draft';
    return `Proforma_Invoice_${safe}_${invoice.invoice.date || 'undated'}.xlsx`;
}

module.exports = {
    COLUMN_PX,
    buildProformaWorkbook,
    exportFileName,
};
