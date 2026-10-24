'use strict';

// Mechanic / technician partner registrations — Excel export (exceljs, the
// same as the vendor KYC export in kyc/kycExport.js). One row per
// registration, one column per field, in form order. The Aadhaar itself is
// never exported: only whether one was uploaded (staff open it from the app
// through a short-lived signed link).

const ExcelJS = require('exceljs');
const { formatDate } = require('../kyc/kycExport');
const { referenceFor } = require('./technicianService');

const STATUS_LABELS = { pending: 'Pending', shortlisted: 'Shortlisted', approved: 'Approved', rejected: 'Rejected' };
const SOURCE_LABELS = { device: 'Shared from phone', link: 'Pasted Google Maps link' };
// Rows from before Staff mode have no registration_source: they were self-registered.
const REGISTRATION_SOURCE_LABELS = { self: 'Self-registered', staff: 'Staff-registered' };

const IST_DATE_TIME = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
function formatDateTime(value) {
    const date = new Date(value || '');
    return Number.isNaN(date.getTime()) ? '' : IST_DATE_TIME.format(date).replace(/\//g, '-').replace(',', '');
}

function excelColumns() {
    return [
        { header: 'Reference', key: 'reference', width: 14, value: (row) => referenceFor(row.id) },
        { header: 'Submitted (IST)', key: 'submitted_at', width: 17, value: (row) => formatDateTime(row.submitted_at) },
        { header: 'Status', key: 'status', width: 12, value: (row) => STATUS_LABELS[row.status] || row.status },
        { header: 'Registered By', key: 'registration_source', width: 16, value: (row) => REGISTRATION_SOURCE_LABELS[row.registration_source] || REGISTRATION_SOURCE_LABELS.self },
        { header: 'Staff ID', key: 'staff_code', width: 12, value: (row) => row.staff_code },
        { header: 'Staff Name', key: 'staff_name', width: 22, value: (row) => row.staff_name },
        { header: 'Name', key: 'full_name', width: 24, value: (row) => row.full_name },
        { header: 'District', key: 'district', width: 16, value: (row) => row.district },
        { header: 'Place', key: 'place', width: 18, value: (row) => row.place },
        { header: 'Shop Name', key: 'shop_name', width: 24, value: (row) => row.shop_name },
        { header: 'Contact Number', key: 'mobile', width: 15, value: (row) => row.mobile },
        { header: 'Address', key: 'address', width: 40, value: (row) => row.address },
        { header: 'Pincode', key: 'pincode', width: 9, value: (row) => row.pincode },
        { header: 'State', key: 'state', width: 15, value: (row) => row.state },
        { header: 'Date of Birth', key: 'date_of_birth', width: 13, value: (row) => formatDate(row.date_of_birth) },
        { header: 'Date of Marriage', key: 'date_of_marriage', width: 15, value: (row) => formatDate(row.date_of_marriage) },
        { header: 'Shop Location (Google Maps)', key: 'shop_maps_url', width: 40, value: (row) => row.shop_maps_url, link: true },
        { header: 'Latitude', key: 'shop_latitude', width: 11, value: (row) => row.shop_latitude },
        { header: 'Longitude', key: 'shop_longitude', width: 11, value: (row) => row.shop_longitude },
        { header: 'Location Accuracy (m)', key: 'shop_location_accuracy_m', width: 11, value: (row) => row.shop_location_accuracy_m },
        { header: 'Location Source', key: 'shop_location_source', width: 20, value: (row) => SOURCE_LABELS[row.shop_location_source] || '' },
        { header: 'Aadhaar Uploaded', key: 'aadhaar', width: 10, value: (row) => (row.documents?.aadhaar ? (row.documents.aadhaar.archived ? `Yes (archived offline ${formatDate(row.documents.aadhaar.archived.at)})` : 'Yes') : 'No') },
        { header: 'Review Remarks', key: 'review_remarks', width: 36, value: (row) => row.review_remarks },
        { header: 'Last Reviewed (IST)', key: 'reviewed_at', width: 17, value: (row) => formatDateTime(row.reviewed_at) },
    ];
}

async function buildTechnicianWorkbook(rows, { filtersLabel = '' } = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sudarshan Pipes AI Assistant';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Partner registrations', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
    const columns = excelColumns();
    sheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
    for (const row of rows) {
        // Every value is written as text: mobile/PIN must never become
        // numbers. The Maps link is a clickable hyperlink.
        const added = sheet.addRow(Object.fromEntries(columns.map((column) => {
            const value = column.value(row);
            return [column.key, value === null || value === undefined ? '' : String(value)];
        })));
        for (const column of columns.filter((item) => item.link)) {
            const cellRef = added.getCell(column.key);
            const url = String(cellRef.value || '');
            if (/^https:\/\//.test(url)) {
                cellRef.value = { text: url, hyperlink: url };
                cellRef.font = { color: { argb: 'FF1F4E9A' }, underline: true };
            }
        }
        added.alignment = { vertical: 'top', wrapText: true };
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
        info.addRow(['Exported', formatDateTime(new Date())]);
        info.addRow(['Filters', filtersLabel]);
        info.addRow(['Rows', rows.length]);
        info.getColumn(1).width = 12;
        info.getColumn(2).width = 60;
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

// Employees (staff roster). PINs are never exported — only their hash exists.
const EMPLOYEE_SOURCE_LABELS = { self: 'Self-registered', manual: 'Added manually' };

async function buildEmployeeWorkbook(rows, { filtersLabel = '' } = {}) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sudarshan Pipes AI Assistant';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Employees', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
    const columns = [
        ['Employee ID', 'staff_code', 14, (row) => row.staff_code],
        ['Name', 'full_name', 24, (row) => row.full_name],
        ['Mobile', 'phone', 13, (row) => row.phone],
        ['State of Operation', 'state', 18, (row) => row.state],
        ['Email', 'email', 28, (row) => row.email],
        ['Status', 'active', 10, (row) => (row.active ? 'Active' : 'Inactive')],
        ['Registered', 'registration_source', 16, (row) => EMPLOYEE_SOURCE_LABELS[row.registration_source] || EMPLOYEE_SOURCE_LABELS.manual],
        ['Registration Date (IST)', 'created_at', 17, (row) => formatDateTime(row.created_at)],
    ];
    sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
    for (const row of rows) {
        // Text only, so mobile numbers never become numbers.
        sheet.addRow(Object.fromEntries(columns.map(([, key, , value]) => [key, String(value(row) ?? '')])));
    }
    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.eachCell((cellRef) => {
        cellRef.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    const info = workbook.addWorksheet('Export info');
    info.addRow(['Exported', formatDateTime(new Date())]);
    info.addRow(['Filters', filtersLabel || 'none (all employees)']);
    info.addRow(['Rows', rows.length]);
    info.getColumn(1).width = 12;
    info.getColumn(2).width = 60;
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { buildTechnicianWorkbook, buildEmployeeWorkbook, excelColumns };
