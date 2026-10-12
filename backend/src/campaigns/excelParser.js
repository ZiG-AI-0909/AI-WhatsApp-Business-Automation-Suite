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

        const worksheet = loaded.worksheets[0];
        if (!worksheet) {
            throw new Error('Excel file is empty or has no data rows.');
        }

        //exceljs streams rows including the header; convert to plain objects.
        const rawRows = [];
        let header = null;
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            const values = [];
            // Row values are 1-indexed and sparse; walk up to the last real
            // cell so column positions stay stable across rows.
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                values[colNumber - 1] = cell.value;
            });
            if (rowNumber === 1) {
                header = values.map((v) => (v === null || v === undefined) ? '' : String(v));
                return;
            }
            const obj = {};
            header.forEach((name, i) => {
                if (!name) return; // unnamed columns dropped
                obj[name] = stringifyCell(values[i]);
            });
            // Skip fully empty rows.
            if (Object.values(obj).some((v) => v !== '')) rawRows.push(obj);
        });

        if (!rawRows || rawRows.length === 0) {
            throw new Error('Excel file is empty or has no data rows.');
        }

        // Detect all column names
        const allColumns = Object.keys(rawRows[0]);

        // Normalize column names (lowercase, trim)
        const columns = allColumns.map(c => c.trim().toLowerCase().replace(/\s+/g, '_'));

        // Check for phone column (flexible matching)
        const phoneColRaw = allColumns.find(c =>
            ['phone', 'mobile', 'phone_number', 'mobile_number', 'whatsapp', 'number', 'contact']
                .includes(c.trim().toLowerCase().replace(/\s+/g, '_'))
        );

        if (!phoneColRaw) {
            throw new Error('Required column "phone" (or mobile/number/whatsapp) not found in Excel file.');
        }

        const phoneColNorm = phoneColRaw.trim().toLowerCase().replace(/\s+/g, '_');

        // Build normalized rows
        const normalizedRows = rawRows.map((row, idx) => {
            const normalized = {};
            allColumns.forEach((rawCol, i) => {
                normalized[columns[i]] = String(row[rawCol] || '').trim();
            });
            normalized._rowIndex = idx + 2; // Excel row number (1-header, 2+data)
            return normalized;
        });

        // Apply the selected/account country code to every phone value BEFORE
        // validation, so length checks and dedupe keys use the final stored form.
        if (requestedCode) {
            for (const row of normalizedRows) {
                row[phoneColNorm] = ensureCountryCode(row[phoneColNorm], requestedCode);
            }
        }

        // Validate rows
        const validation = this._validate(normalizedRows, phoneColNorm);

        return {
            phoneColumn: phoneColNorm,
            columns: columns.filter(c => c !== phoneColNorm),
            allColumns: columns,
            rawRows,
            rows: normalizedRows,
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
                errors.push({ row: row._rowIndex, issue: 'Invalid or missing phone number' });
                row._valid = false;
                return;
            }

            if (seen.has(phone)) {
                duplicates++;
                errors.push({ row: row._rowIndex, issue: `Duplicate phone: ${phone}` });
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
