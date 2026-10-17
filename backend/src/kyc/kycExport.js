'use strict';

// Vendor KYC exports — same libraries as the quotation exports
// (documents/quotationExport.js): pdfkit with built-in Helvetica, exceljs.
//
// PDF: rebuilds the 2-page paper "KYC Registration Form" filled with one
// submission, §7 included. The paper "Signature & Company Seal" box has no
// digital equivalent: it carries a note pointing to the uploaded signed &
// sealed declaration page (§5) and the online confirmation.
// §3 ticks the categories from category_selections and lists the picked
// items in an extra "Items Selected" row.
// Excel: one row per submission, one column per field; each category gets
// a Yes/No column and an items column.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { pdfText } = require('../documents/quotationExport');
const schema = require('./kycSchema');

const LOGO_PATH = path.join(__dirname, 'assets', 'sudarshan-logo.png');

const C = {
    blue: '#1F4E9A',
    labelFill: '#EDF3FB',
    headFill: '#E6EDF7',
    border: '#B9C8DD',
    text: '#1A1A1A',
    muted: '#6B7280',
    orange: '#EC8211',
};

let logoCache;
function logo() {
    if (logoCache === undefined) {
        try { logoCache = fs.readFileSync(LOGO_PATH); } catch { logoCache = null; }
    }
    return logoCache;
}

const IST_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });

/** dd-mm-yyyy for a date (yyyy-mm-dd) or timestamp; '' when empty. */
function formatDate(value) {
    if (!value) return '';
    const text = String(value);
    const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (plain) return `${plain[3]}-${plain[2]}-${plain[1]}`;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? '' : IST_DATE.format(date).replace(/\//g, '-');
}

/** category_selections as an array (jsonb may arrive as text from older drivers). */
function selectionsOf(row) {
    let value = row?.category_selections;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { value = []; }
    }
    return Array.isArray(value) ? value : [];
}

const CHECK_LABELS = { verified: 'Verified', pending: 'Pending', na: 'N/A' };
const DECISION_LABELS = { approved: 'Approved', rejected: 'Rejected', info_required: 'Further information required' };
const STATUS_LABELS = { pending: 'Pending', verified: 'Verified', approved: 'Approved', rejected: 'Rejected', info_required: 'Info required' };

// ── PDF ───────────────────────────────────────────────────────────────

/**
 * @param {object} submission  a kyc_submissions row
 * @param {object} options
 * @param {string} options.reference  e.g. KYC-1A2B3C4D
 */
async function renderKycPdf(submission, { reference = '' } = {}) {
    const s = submission;
    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 36, bottom: 20, left: 40, right: 40 },
        bufferPages: true,
        info: { Title: `KYC Registration Form - ${pdfText(s.legal_name || '')}`, Author: 'Sudarshan Extrusions Pvt. Ltd.' },
    });
    const chunks = [];
    const done = new Promise((resolve, reject) => {
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const limit = () => doc.page.height - 58; // keep clear of the footer
    const LABEL_W = 118;
    const VALUE_W = width / 2 - LABEL_W;
    const PAD = 5;
    let y = doc.page.margins.top;

    const pageCount = () => doc.bufferedPageRange().count;
    const newPage = () => { doc.addPage(); y = doc.page.margins.top; };
    const ensure = (height) => { if (y + height > limit()) newPage(); };

    const textHeight = (text, w, font = 'Helvetica', size = 8.5) =>
        doc.font(font).fontSize(size).heightOfString(pdfText(text) || ' ', { width: w });

    const cell = (x, top, w, h, fillColor) => {
        doc.lineWidth(0.6);
        if (fillColor) doc.rect(x, top, w, h).fillAndStroke(fillColor, C.border);
        else doc.rect(x, top, w, h).stroke(C.border);
    };
    const write = (text, x, top, w, h, { font = 'Helvetica', size = 8.5, color = C.text, align = 'left' } = {}) => {
        const value = pdfText(text);
        if (!value) return;
        const th = textHeight(value, w - PAD * 2, font, size);
        doc.font(font).fontSize(size).fillColor(color)
            .text(value, x + PAD, top + Math.max(PAD - 1, (h - th) / 2), { width: w - PAD * 2, height: h - 4, align, ellipsis: true });
    };
    const checkbox = (x, top, checked, label, size = 8) => {
        doc.lineWidth(0.8).rect(x, top, 8, 8).stroke('#4B5563');
        if (checked) {
            doc.lineWidth(1.4).strokeColor(C.blue)
                .moveTo(x + 1.6, top + 4.2).lineTo(x + 3.5, top + 6.5).lineTo(x + 7, top + 1.4).stroke();
        }
        doc.font('Helvetica').fontSize(size).fillColor(C.text).text(label, x + 12, top - 0.5, { lineBreak: false });
        return x + 12 + doc.widthOfString(label) + 14;
    };

    const heading = (title) => {
        ensure(60);
        y += 8;
        doc.font('Helvetica-Bold').fontSize(11).fillColor(C.blue).text(title, left, y, { width });
        y += 16;
    };
    // Two label/value pairs per row, as on the paper form.
    const pairRow = (a, b, minH = 23) => {
        const vh = (value) => textHeight(value, VALUE_W - PAD * 2) + PAD * 2;
        const lh = (label) => textHeight(label, LABEL_W - PAD * 2, 'Helvetica-Bold') + PAD * 2;
        const h = Math.max(minH, lh(a[0]), vh(a[1]), b ? lh(b[0]) : 0, b ? vh(b[1]) : 0);
        ensure(h);
        let x = left;
        for (const [label, value] of [a, b || ['', '']]) {
            cell(x, y, LABEL_W, h, C.labelFill);
            write(label, x, y, LABEL_W, h, { font: 'Helvetica-Bold' });
            cell(x + LABEL_W, y, VALUE_W, h);
            write(value, x + LABEL_W, y, VALUE_W, h);
            x += LABEL_W + VALUE_W;
        }
        y += h;
    };
    // One label with a full-width value.
    const wideRow = (label, value, minH = 23) => {
        const h = Math.max(minH, textHeight(value, width - LABEL_W - PAD * 2) + PAD * 2, textHeight(label, LABEL_W - PAD * 2, 'Helvetica-Bold') + PAD * 2);
        ensure(h);
        cell(left, y, LABEL_W, h, C.labelFill);
        write(label, left, y, LABEL_W, h, { font: 'Helvetica-Bold' });
        cell(left + LABEL_W, y, width - LABEL_W, h);
        write(value, left + LABEL_W, y, width - LABEL_W, h);
        y += h;
    };
    const tableHead = (columns) => {
        ensure(24);
        let x = left;
        for (const [label, w] of columns) {
            cell(x, y, w, 22, C.headFill);
            write(label, x, y, w, 22, { font: 'Helvetica-Bold' });
            x += w;
        }
        y += 22;
    };

    // ── Page 1 ──
    const image = logo();
    if (image) {
        doc.image(image, left + (width - 190) / 2, y, { fit: [190, 36], align: 'center' });
    } else {
        doc.font('Helvetica-Bold').fontSize(20).fillColor(C.blue).text('SUDARSHAN', left, y, { width, align: 'center' });
    }
    y += 44;
    doc.font('Helvetica-Bold').fontSize(18).fillColor(C.blue).text('KYC REGISTRATION FORM', left, y, { width, align: 'center' });
    y += 22;
    doc.font('Helvetica').fontSize(9).fillColor(C.muted).text('Sudarshan Extrusions Pvt. Ltd. | Pipes & Fittings', left, y, { width, align: 'center' });
    y += 18;
    pairRow(['Vendor Code (Internal Use)', s.vendor_code || ''], ['Date', formatDate(s.submitted_at)], 26);

    heading('1. VENDOR / BUSINESS DETAILS');
    pairRow(['Legal Business / Vendor Name', s.legal_name], ['Business Type', s.business_type]);
    pairRow(['Trade Name (if different)', s.trade_name], ['PAN', s.pan]);
    pairRow(['GSTIN (if applicable)', s.gstin], ['Udyam / MSME No. (if applicable)', s.udyam_number]);
    pairRow(['Registered Address', s.registered_address], ['PIN Code', s.registered_pin]);
    pairRow(['Factory / Warehouse Address', s.factory_address], ['State', s.state]);
    pairRow(['Website', s.website], ['Years in Business', s.years_in_business ?? '']);

    heading('2. CONTACT DETAILS');
    pairRow(['Primary Contact Person', s.contact_name], ['Designation', s.contact_designation]);
    pairRow(['Mobile Number', s.contact_mobile], ['Official Email', s.contact_email]);
    pairRow(['Alternate Contact', s.alternate_contact], ['Landline (if any)', s.landline]);

    heading('3. VENDOR CATEGORY & SUPPLY DETAILS');
    {
        const h = 44;
        ensure(h);
        cell(left, y, LABEL_W, h, C.labelFill);
        write('Category (tick all applicable)', left, y, LABEL_W, h, { font: 'Helvetica-Bold' });
        cell(left + LABEL_W, y, width - LABEL_W, h);
        const chosen = new Set(selectionsOf(s).map((selection) => selection.category));
        const colW = (width - LABEL_W - 16) / 4;
        schema.CATEGORY_OPTIONS.forEach((category, index) => {
            const x = left + LABEL_W + 10 + (index % 4) * colW;
            const top = y + 10 + Math.floor(index / 4) * 16;
            checkbox(x, top, chosen.has(category.label), category.label, 7.5);
        });
        y += h;
    }
    wideRow('Items Selected', selectionsOf(s).map((selection) => `${selection.category}: ${schema.describeSelection(selection)}`).join(String.fromCharCode(10)));
    wideRow('Products / Services Offered', s.products_offered);
    wideRow('Brands / Make / Specifications', s.brands_specs);
    wideRow('Manufacturing / Supply Capacity', s.supply_capacity);
    wideRow('Delivery Locations / Lead Time', s.delivery_lead_time);

    heading('4. BANK & PAYMENT DETAILS');
    pairRow(['Account Holder Name', s.bank_account_holder], ['Bank Name', s.bank_name]);
    pairRow(['Account Number', s.bank_account_number], ['IFSC', s.bank_ifsc]);
    pairRow(['Branch', s.bank_branch], ['Account Type', s.bank_account_type]);
    pairRow(['Payment Terms Requested', s.payment_terms], ['Currency', s.currency || 'INR']);

    // ── Page 2 ── (the paper form starts §5 on a new page)
    if (pageCount() === 1) newPage();
    heading('5. DOCUMENT CHECKLIST');
    {
        const docW = 272;
        const attW = 120;
        const verW = width - docW - attW;
        tableHead([['Document', docW], ['Attached', attW], ['Verified by Company', verW]]);
        for (const document of schema.DOCUMENTS) {
            const file = s.documents?.[document.key];
            const h = file ? 30 : 24;
            const labelW = document.mandatory ? docW - 84 : docW - PAD * 2;
            ensure(h);
            cell(left, y, docW, h);
            cell(left + docW, y, attW, h);
            cell(left + docW + attW, y, verW, h);
            doc.font('Helvetica').fontSize(8.5).fillColor(C.text)
                .text(document.label, left + PAD, y + (file ? 6 : 7), { width: labelW, height: 11, ellipsis: true });
            if (file) {
                doc.font('Helvetica').fontSize(6.8).fillColor(C.muted)
                    .text(pdfText(file.file_name || ''), left + PAD, y + 18, { width: labelW, height: 11, ellipsis: true });
            }
            if (document.mandatory) {
                const tagX = left + docW - 70;
                doc.lineWidth(0.8).roundedRect(tagX, y + h / 2 - 6, 62, 12, 3).stroke(C.blue);
                doc.font('Helvetica-Bold').fontSize(6.5).fillColor(C.blue).text('MANDATORY', tagX, y + h / 2 - 3.4, { width: 62, align: 'center', lineBreak: false });
            }
            const boxTop = y + h / 2 - 4;
            const next = checkbox(left + docW + 12, boxTop, Boolean(file), 'Yes');
            checkbox(next, boxTop, !file, 'N/A');
            const verified = s.documents_verified?.[document.key];
            const vNext = checkbox(left + docW + attW + 12, boxTop, file && verified === 'yes', 'Yes');
            checkbox(vNext, boxTop, file && verified !== 'yes', 'Pending');
            y += h;
        }
    }

    heading('6. VENDOR DECLARATION');
    {
        const th = textHeight(schema.DECLARATION_TEXT, width, 'Helvetica', 8.5);
        ensure(th + 8);
        doc.font('Helvetica').fontSize(8.5).fillColor(C.text).text(schema.DECLARATION_TEXT, left, y, { width, lineGap: 1.5 });
        y = doc.y + 8;
    }
    pairRow(['Authorized Person Name', s.authorized_person_name], ['Designation', s.authorized_person_designation]);
    {
        const declaration = s.documents?.signed_declaration;
        const note = [
            declaration
                ? `See the uploaded "Signed & Sealed Declaration Page" in section 5${declaration.file_name ? ` (${pdfText(declaration.file_name)})` : ''}.`
                : 'No signed & sealed declaration page on file.',
            s.declaration_accepted ? `Confirmed online by ${pdfText(s.authorized_person_name)} on ${formatDate(s.declaration_date)}.` : '',
        ].filter(Boolean).join('\n');
        const noteH = textHeight(note, VALUE_W - PAD * 2, 'Helvetica-Oblique', 7.5) + note.split('\n').length * 1.5;
        const h = Math.max(46, noteH + 16);
        ensure(h);
        cell(left, y, LABEL_W, h, C.labelFill);
        write('Signature & Company Seal', left, y, LABEL_W, h, { font: 'Helvetica-Bold' });
        cell(left + LABEL_W, y, VALUE_W, h);
        doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(C.muted)
            .text(note, left + LABEL_W + PAD, y + 8, { width: VALUE_W - PAD * 2, lineGap: 1.5 });
        const dateX = left + LABEL_W + VALUE_W;
        cell(dateX, y, LABEL_W, h, C.labelFill);
        write('Date', dateX, y, LABEL_W, h, { font: 'Helvetica-Bold' });
        cell(dateX + LABEL_W, y, VALUE_W, h);
        write(formatDate(s.declaration_date), dateX + LABEL_W, y, VALUE_W, h);
        y += h;
    }

    heading('7. INTERNAL VERIFICATION & APPROVAL (SUDARSHAN USE ONLY)');
    {
        const checkW = 222;
        const statusW = 150;
        const remarksW = width - checkW - statusW;
        tableHead([['Check', checkW], ['Status', statusW], ['Remarks / Reference', remarksW]]);
        for (const check of schema.INTERNAL_CHECKS) {
            const status = s[`check_${check.key}`] || 'pending';
            const remarks = s[`check_${check.key}_remarks`] || '';
            const h = Math.max(24, textHeight(remarks, remarksW - PAD * 2) + PAD * 2);
            ensure(h);
            cell(left, y, checkW, h);
            write(check.label, left, y, checkW, h);
            cell(left + checkW, y, statusW, h);
            let x = left + checkW + 10;
            for (const option of schema.CHECK_STATUSES) x = checkbox(x, y + h / 2 - 4, status === option, CHECK_LABELS[option]);
            cell(left + checkW + statusW, y, remarksW, h);
            write(remarks, left + checkW + statusW, y, remarksW, h);
            y += h;
        }
    }
    y += 10;
    pairRow(['Procurement Reviewer', s.procurement_reviewer], ['Date', formatDate(s.procurement_reviewed_on)]);
    pairRow(['Accounts / Finance Reviewer', s.finance_reviewer], ['Date', formatDate(s.finance_reviewed_on)]);
    pairRow(['Final Approver', s.final_approver], ['Date', formatDate(s.final_approved_on)]);
    {
        const h = 40;
        ensure(h);
        cell(left, y, LABEL_W, h, C.labelFill);
        write('Final Decision', left, y, LABEL_W, h, { font: 'Helvetica-Bold' });
        cell(left + LABEL_W, y, VALUE_W, h);
        const next = checkbox(left + LABEL_W + 10, y + 9, s.final_decision === 'approved', 'Approved');
        checkbox(next, y + 9, s.final_decision === 'rejected', 'Rejected');
        checkbox(left + LABEL_W + 10, y + 24, s.final_decision === 'info_required', 'Further information required');
        const codeX = left + LABEL_W + VALUE_W;
        cell(codeX, y, LABEL_W, h, C.headFill);
        write('Vendor Code', codeX, y, LABEL_W, h, { font: 'Helvetica-Bold' });
        cell(codeX + LABEL_W, y, VALUE_W, h);
        write(s.vendor_code, codeX + LABEL_W, y, VALUE_W, h, { font: 'Helvetica-Bold' });
        y += h;
    }
    if (s.decision_remarks) wideRow('Decision Remarks', s.decision_remarks);

    {
        const note = 'Collect and handle PAN, bank and other business documents only through approved company channels. Verify bank-detail changes independently before processing payments. Apply document requirements according to the vendor\'s legal structure and applicable law.';
        y += 10;
        // Small print may use the slack above the footer rule rather than
        // start a page of its own.
        if (y + textHeight(`Important: ${note}`, width, 'Helvetica', 7.5) > doc.page.height - 50) newPage();
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.orange).text('Important: ', left, y, { width, continued: true })
            .font('Helvetica').fillColor(C.muted).text(note, { lineGap: 1 });
        y = doc.y;
    }

    // Footer on every page — drawn with the bottom margin lifted so pdfkit
    // does not start a new page for it (same approach as quotationExport).
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index++) {
        doc.switchToPage(index);
        const margin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const footerY = doc.page.height - 44;
        doc.lineWidth(1.2).moveTo(left, footerY).lineTo(left + width, footerY).stroke(C.orange);
        doc.font('Helvetica').fontSize(7.5).fillColor(C.muted)
            .text('Sudarshan Extrusions Pvt. Ltd. | Vendor onboarding', left, footerY + 8, { width: width / 2, lineBreak: false })
            .text(reference ? `Online submission ${reference}` : '', left + width / 4, footerY + 8, { width: width / 2, align: 'center', lineBreak: false })
            .text(`Page ${index + 1} of ${range.count}`, left + width / 2, footerY + 8, { width: width / 2, align: 'right', lineBreak: false });
        doc.page.margins.bottom = margin;
    }
    doc.fillColor('#000000');
    doc.end();
    return done;
}

// ── Excel ─────────────────────────────────────────────────────────────

const yesNo = (value) => (value ? 'Yes' : 'No');

function excelColumns() {
    const field = (key) => schema.FIELDS.find((item) => item.key === key);
    const fromField = (key, header, width = 22) => ({ header: header || field(key).label, key, width, value: (row) => row[key] ?? '' });
    return [
        { header: 'Reference', key: 'reference', width: 14, value: (row) => `KYC-${String(row.id).replace(/-/g, '').slice(0, 8).toUpperCase()}` },
        { header: 'Submitted (IST)', key: 'submitted_at', width: 14, value: (row) => formatDate(row.submitted_at) },
        { header: 'Status', key: 'status', width: 14, value: (row) => STATUS_LABELS[row.status] || row.status },
        fromField('vendor_code', 'Vendor Code', 14),
        ...schema.FIELDS.filter((item) => item.section === 1).map((item) => fromField(item.key, null, item.kind === 'multiline' ? 40 : 22)),
        ...schema.FIELDS.filter((item) => item.section === 2).map((item) => fromField(item.key, item.key === 'contact_designation' ? 'Contact Designation' : null)),
        ...schema.CATEGORY_OPTIONS.flatMap((category) => {
            const pick = (row) => selectionsOf(row).find((selection) => selection.category === category.label);
            return [
                { header: `Category: ${category.label}`, key: `cat_${category.key}`, width: 12, value: (row) => yesNo(pick(row)) },
                { header: `${category.label}: Items`, key: `cat_items_${category.key}`, width: 30, value: (row) => (pick(row) ? schema.describeSelection(pick(row)) : '') },
            ];
        }),
        ...schema.FIELDS.filter((item) => item.section === 3).map((item) => fromField(item.key, null, 36)),
        ...schema.FIELDS.filter((item) => item.section === 4).map((item) => fromField(item.key, item.key === 'currency' ? 'Currency' : null)),
        ...schema.DOCUMENTS.flatMap((document) => [
            { header: `${document.label}: Attached`, key: `doc_${document.key}`, width: 14, value: (row) => (row.documents?.[document.key] ? 'Yes' : 'N/A') },
            { header: `${document.label}: Verified`, key: `docv_${document.key}`, width: 14, value: (row) => (row.documents?.[document.key] ? (row.documents_verified?.[document.key] === 'yes' ? 'Yes' : 'Pending') : '') },
        ]),
        fromField('authorized_person_name', 'Authorized Person Name'),
        fromField('authorized_person_designation', 'Authorized Person Designation'),
        { header: 'Declaration Date', key: 'declaration_date', width: 14, value: (row) => formatDate(row.declaration_date) },
        { header: 'Declaration Accepted', key: 'declaration_accepted', width: 12, value: (row) => yesNo(row.declaration_accepted) },
        ...schema.INTERNAL_CHECKS.flatMap((check) => [
            { header: `${check.label}: Status`, key: `check_${check.key}`, width: 14, value: (row) => CHECK_LABELS[row[`check_${check.key}`]] || '' },
            { header: `${check.label}: Remarks`, key: `check_${check.key}_remarks`, width: 28, value: (row) => row[`check_${check.key}_remarks`] || '' },
        ]),
        { header: 'Procurement Reviewer', key: 'procurement_reviewer', width: 20, value: (row) => row.procurement_reviewer || '' },
        { header: 'Procurement Review Date', key: 'procurement_reviewed_on', width: 14, value: (row) => formatDate(row.procurement_reviewed_on) },
        { header: 'Accounts / Finance Reviewer', key: 'finance_reviewer', width: 20, value: (row) => row.finance_reviewer || '' },
        { header: 'Finance Review Date', key: 'finance_reviewed_on', width: 14, value: (row) => formatDate(row.finance_reviewed_on) },
        { header: 'Final Approver', key: 'final_approver', width: 20, value: (row) => row.final_approver || '' },
        { header: 'Final Approval Date', key: 'final_approved_on', width: 14, value: (row) => formatDate(row.final_approved_on) },
        { header: 'Final Decision', key: 'final_decision', width: 18, value: (row) => DECISION_LABELS[row.final_decision] || '' },
        { header: 'Decision Remarks', key: 'decision_remarks', width: 32, value: (row) => row.decision_remarks || '' },
    ];
}

async function buildKycWorkbook(rows, { filtersLabel = '' } = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sudarshan Pipes AI Assistant';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('KYC submissions', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
    const columns = excelColumns();
    sheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
    for (const row of rows) {
        // Every value is written as text: PAN/IFSC/account/PIN/mobile must
        // never become numbers (lost leading zeros, 1.23E+15).
        sheet.addRow(Object.fromEntries(columns.map((column) => {
            const value = column.value(row);
            return [column.key, value === null || value === undefined ? '' : String(value)];
        })));
    }
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: 'middle', wrapText: true };
    header.height = 32;
    header.eachCell((cellRef) => {
        cellRef.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    if (filtersLabel) {
        const info = workbook.addWorksheet('Export info');
        info.addRow(['Exported', new Date().toISOString()]);
        info.addRow(['Filters', filtersLabel]);
        info.addRow(['Rows', rows.length]);
        info.getColumn(1).width = 12;
        info.getColumn(2).width = 60;
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = {
    renderKycPdf,
    buildKycWorkbook,
    excelColumns,
    formatDate,
};
