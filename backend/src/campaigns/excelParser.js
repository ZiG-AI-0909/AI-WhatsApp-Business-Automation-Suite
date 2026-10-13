const ExcelJS = require('exceljs');
const { ensureCountryCode, sanitizeDialCode } = require('../utils/countryCodes');

/**
 * Parse an Excel/CSV file and dynamically detect all columns.
 * The 'phone' column is required; all other columns become dynamic fields.
 *
 * Uses exceljs (maintained) instead of the abandoned `xlsx` package, which
 * carried 2 unpatched high-severity advisories. exceljs reads workbooks via
 * promises, so parse()/parseBuffer() are async; every caller awaits them.
 */
class ExcelParser {
    _normalizeColumn(name) {
        return name.trim().toLowerCase().replace(/\s+/g, '_');
    }

    _isPhoneColumn(name) {
        return ['phone', 'mobile', 'phone_number', 'mobile_number', 'whatsapp', 'number', 'contact']
            .includes(this._normalizeColumn(name));
    }

    /**
     * Parse an uploaded Excel file.
     * @param {string|Buffer} source - Absolute path to the uploaded .xlsx file, or a Buffer of the file contents
     * @param {object} [options]
     * @param {string|null} [options.countryCode] - Dial code (digits, e.g. '91') to prepend
     *   to numbers that don't already include a country code. When omitted,
     *   numbers are cleaned but left as-is (caller decides the code).
     * @returns {Promise<object>} { columns, rows, validation }
     */
    async parse(source, { countryCode = null } = {}) {
        const requestedCode = sanitizeDialCode(countryCode);
        const workbook = new ExcelJS.Workbook();
        // Both entry points return a promise: readFile(path) and load(buffer).
        const loaded = Buffer.isBuffer(source)
            ? await workbook.xlsx.load(source)
            : await workbook.xlsx.readFile(source);

        if (!loaded.worksheets.length) {
            throw new Error('Excel file is empty or has no data rows.');
        }

        const rawRows = [];
        let phoneColNorm = null;
        const allColumns = [];
        const ignoredSheets = [];

        for (const worksheet of loaded.worksheets) {
            const sheetRows = [];
            worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
                const values = [];
                row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                    values[colNumber - 1] = cell.value;
                });
                sheetRows.push({ rowNumber, values });
            });

            const headerRowIndex = sheetRows.findIndex(({ values }) =>
                values.some(value => value !== null && value !== undefined && this._isPhoneColumn(String(value)))
            );
            if (headerRowIndex < 0) {
                if (sheetRows.some(({ values }) => values.some(value => value !== null && value !== undefined && String(value).trim()))) {
                    ignoredSheets.push(worksheet.name);
                }
                continue;
            }

            const { rowNumber: headerRowNumber, values: headerValues } = sheetRows[headerRowIndex];
            const headers = headerValues.map(value => value === null || value === undefined ? '' : String(value).trim());
            const sheetPhoneHeader = headers.find(name => name && this._isPhoneColumn(name));
            const sheetPhoneColumn = this._normalizeColumn(sheetPhoneHeader);
            if (!phoneColNorm) phoneColNorm = sheetPhoneColumn;

            for (const header of headers) {
                if (!header) continue;
                const normalized = this._normalizeColumn(header);
                const column = this._isPhoneColumn(header) ? phoneColNorm : normalized;
                if (!allColumns.includes(column)) allColumns.push(column);
            }

            for (const { rowNumber, values } of sheetRows) {
                if (rowNumber <= headerRowNumber) continue;
                const obj = {};
                headers.forEach((header, index) => {
                    if (!header) return;
                    const column = this._isPhoneColumn(header) ? phoneColNorm : this._normalizeColumn(header);
                    obj[column] = stringifyCell(values[index]).trim();
                });
                if (Object.values(obj).some(value => value !== '')) {
                    rawRows.push({ ...obj, _rowIndex: rowNumber, _sheetName: worksheet.name });
                }
            }
        }

        if (!rawRows.length || !phoneColNorm) {
            throw new Error('Excel file has no data rows under a recognized phone/mobile/WhatsApp header.');
        }

        const columns = allColumns.filter(column => column !== phoneColNorm);

        // Build normalized rows from the union of columns across all sheets.
        const normalizedRows = rawRows.map((row) => {
            const normalized = {};
            for (const column of allColumns) {
                normalized[column] = String(row[column] || '').trim();
            }
            normalized._rowIndex = row._rowIndex;
            normalized._sheetName = row._sheetName;
            return normalized;
        });

        // Apply the selected/account country code to every phone value BEFORE
        // validation, so length checks and dedupe keys use the final stored form.
        if (requestedCode) {
            for (const row of normalizedRows) {
                row[phoneColNorm] = ensureCountryCode(row[phoneColNorm], requestedCode);
            }
        }

        const validation = this._validate(normalizedRows, phoneColNorm);

        return {
            phoneColumn: phoneColNorm,
            columns,
            allColumns,
            rawRows,
            rows: normalizedRows,
            ignoredSheets,
            validation,
        };
    }

    _validate(rows, phoneCol) {
        const seen = new Set();
        let valid = 0, invalid = 0, duplicates = 0, missingPhone = 0;
        const errors = [];

        rows.forEach((row, i) => {
            const phone = this._cleanPhone(row[phoneCol] || '');

            if (!phone || phone.length < 10 || phone.length > 15) {
                invalid++;
                missingPhone++;
                errors.push({ row: row._rowIndex, sheet: row._sheetName, issue: 'Invalid or missing phone number' });
                row._valid = false;
                return;
            }

            if (seen.has(phone)) {
                duplicates++;
                errors.push({ row: row._rowIndex, sheet: row._sheetName, issue: `Duplicate phone: ${phone}` });
                row._valid = false;
                return;
            }

            seen.add(phone);
            row._phone = phone;
            row[phoneCol] = phone;
            row._valid = true;
            valid++;
        });

        return {
            total: rows.length,
            valid,
            invalid,
            duplicates,
            missingPhone,
            errors: errors.slice(0, 50), // Cap error list
        };
    }

    _cleanPhone(phone) {
        return String(phone).replace(/[^\d]/g, '');
    }

    /**
     * Get valid rows only (phone validated, no duplicates).
     */
    getValidRows(parsedResult) {
        return parsedResult.rows.filter(r => r._valid);
    }

    /**
     * Parse from an in-memory Buffer (e.g. a file downloaded from Supabase Storage).
     */
    async parseBuffer(buffer, options) {
        return this.parse(buffer, options);
    }

    /**
     * Get the available dynamic field names (column names excluding phone).
     */
    getDynamicFields(parsedResult) {
        return parsedResult.allColumns.filter(c => c !== parsedResult.phoneColumn);
    }
}

// exceljs cell values can be rich objects (formula results, hyperlinks,
// rich text). Flatten to a plain string the way sheet_to_json did.
function stringifyCell(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
        if (typeof value.text === 'string') return value.text; // hyperlink / rich text
        if (value.result !== undefined) return value.result;    // formula result
        if (value.richText && Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
        return String(value);
    }
    return String(value);
}

module.exports = new ExcelParser();
