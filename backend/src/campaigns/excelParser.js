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
        const column = this._normalizeColumn(name);
        return ['phone', 'mobile', 'phone_number', 'mobile_number', 'whatsapp', 'number', 'contact'].includes(column)
            || /^(?:[a-z]+_)*(?:phone|mobile|whatsapp|number)(?:_?\d+)?$/.test(column);
    }

    _canonicalColumn(name) {
        const column = this._normalizeColumn(name);
        if (['dealer_name', 'business_name'].includes(column)) return 'name';
        if (['place', 'town', 'location'].includes(column)) return 'city';
        return column;
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
            const phoneIndexes = headers
                .map((header, index) => header && this._isPhoneColumn(header) ? index : -1)
                .filter(index => index >= 0);
            const sheetPhoneColumn = this._normalizeColumn(headers[phoneIndexes[0]]);
            if (!phoneColNorm) phoneColNorm = sheetPhoneColumn;

            for (const [index, header] of headers.entries()) {
                if (!header) continue;
                const normalized = this._normalizeColumn(header);
                if (this._isPhoneColumn(header) && index === phoneIndexes[0]) {
                    if (!allColumns.includes(phoneColNorm)) allColumns.push(phoneColNorm);
                    continue;
                }
                for (const column of new Set([normalized, this._canonicalColumn(header)])) {
                    if (!allColumns.includes(column)) allColumns.push(column);
                }
            }

            for (const { rowNumber, values } of sheetRows) {
                if (rowNumber <= headerRowNumber) continue;
                const obj = {};
                headers.forEach((header, index) => {
                    if (!header) return;
                    const originalColumn = this._normalizeColumn(header);
                    const value = stringifyCell(values[index]).trim();
                    const column = this._isPhoneColumn(header) && index === phoneIndexes[0]
                        ? phoneColNorm
                        : originalColumn;
                    obj[column] = value;
                    if (!this._isPhoneColumn(header)) {
                        const canonical = this._canonicalColumn(header);
                        if (!obj[canonical] || value) obj[canonical] = value;
                    }
                });
                if (Object.values(obj).some(value => value !== '')) {
                    const candidates = [];
                    for (const index of phoneIndexes) {
                        candidates.push(...this._splitPhoneCandidates(stringifyCell(values[index])));
                    }
                    const firstPhoneIndex = phoneIndexes[0];
                    if (firstPhoneIndex !== undefined && !headers[firstPhoneIndex + 1]
                        && values[firstPhoneIndex + 1] !== null && values[firstPhoneIndex + 1] !== undefined) {
                        candidates.push(...this._splitPhoneCandidates(stringifyCell(values[firstPhoneIndex + 1])));
                    }
                    rawRows.push({ ...obj, _phoneCandidates: candidates, _rowIndex: rowNumber, _sheetName: worksheet.name });
                }
            }
        }

        if (!rawRows.length || !phoneColNorm) {
            throw new Error('Excel file has no data rows under a recognized phone/mobile/WhatsApp header.');
        }

        const columns = allColumns.filter(column => column !== phoneColNorm);

        // Build normalized rows from the union of columns across all sheets.
        const normalizedRows = [];
        for (const row of rawRows) {
            const normalized = {};
            for (const column of allColumns) normalized[column] = String(row[column] || '').trim();
            normalized._rowIndex = row._rowIndex;
            normalized._sheetName = row._sheetName;
            const candidates = row._phoneCandidates.length ? row._phoneCandidates : [''];
            for (const candidate of candidates) {
                const phone = requestedCode ? ensureCountryCode(candidate, requestedCode) : this._cleanPhone(candidate);
                normalizedRows.push({ ...normalized, [phoneColNorm]: phone, _sourcePhone: candidate });
            }
        }

        const validation = this._validate(normalizedRows, phoneColNorm, requestedCode);

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

    _splitPhoneCandidates(value) {
        const candidates = [];
        const segments = String(value ?? '').split(/[,\u002f;\r\n]+/).map(segment => segment.trim()).filter(Boolean);
        for (const segment of segments) {
            const words = segment.split(/\s+/).filter(Boolean);
            if (words.length === 1) {
                candidates.push(segment);
                continue;
            }

            const firstDigits = this._cleanPhone(words[0]);
            if (['91', '0091'].includes(firstDigits)) {
                let subscriber = '';
                let nextWord = 1;
                while (nextWord < words.length && subscriber.length < 10) {
                    subscriber += this._cleanPhone(words[nextWord]);
                    nextWord++;
                }
                if (subscriber.length === 10) {
                    candidates.push(`91${subscriber}`);
                    candidates.push(...this._splitPhoneCandidates(words.slice(nextWord).join(' ')));
                    continue;
                }
            }

            const firstSubscriberDigits = this._cleanPhone(words[1]);
            const wordLengths = words.map(word => this._cleanPhone(word).length);
            if (segment.startsWith('+') && wordLengths.slice(1).some(length => length >= 9)) {
                candidates.push(`+${firstDigits}${firstSubscriberDigits}`, ...words.slice(2));
                continue;
            }
            if (segment.startsWith('+')) {
                candidates.push(segment);
                continue;
            }
            if (wordLengths.some(length => length >= 9)) candidates.push(...words);
            else candidates.push(segment);
        }
        return candidates;
    }

    _validate(rows, phoneCol, countryCode = null) {
        const seen = new Set();
        const countsByReason = { blank: 0, 'too short': 0, 'too long': 0, duplicate: 0, 'not a mobile number': 0, valid: 0 };
        let invalid = 0, duplicates = 0, missingPhone = 0;
        const errors = [];
        const rejectedRows = [];

        rows.forEach((row) => {
            const phone = this._cleanPhone(row[phoneCol] || '');
            let reason = null;
            if (!phone) reason = 'blank';
            else if (countryCode === '91' && phone.length < 12) reason = 'too short';
            else if (phone.length < 10) reason = 'too short';
            else if (countryCode === '91' && phone.length > 12) reason = 'too long';
            else if (phone.length > 15) reason = 'too long';
            else if (countryCode === '91' && !/^91[6-9]\d{9}$/.test(phone)) reason = 'not a mobile number';
            else if (seen.has(phone)) reason = 'duplicate';

            if (reason) {
                countsByReason[reason]++;
                if (reason === 'duplicate') duplicates++;
                else {
                    invalid++;
                    if (reason === 'blank') missingPhone++;
                }
                const issue = reason === 'duplicate' ? `Duplicate phone: ${phone}` : reason;
                const rejected = { ...row, _reason: reason };
                rejectedRows.push(rejected);
                errors.push({ row: row._rowIndex, sheet: row._sheetName, reason, issue });
                row._valid = false;
                return;
            }

            seen.add(phone);
            row._phone = phone;
            row[phoneCol] = phone;
            row._valid = true;
            countsByReason.valid++;
        });

        return {
            total: rows.length,
            valid: countsByReason.valid,
            invalid,
            duplicates,
            missingPhone,
            countsByReason,
            errors: errors.slice(0, 50),
            rejectedRows,
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

    getRejectedCsv(parsedResult) {
        const rejected = parsedResult.validation.rejectedRows || [];
        const columns = [...parsedResult.allColumns, 'sheet', 'row', 'reason'];
        const escape = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const lines = [columns.map(escape).join(',')];
        for (const row of rejected) {
            lines.push([
                ...parsedResult.allColumns.map(column => column === parsedResult.phoneColumn ? row._sourcePhone : row[column]),
                row._sheetName,
                row._rowIndex,
                row._reason,
            ].map(escape).join(','));
        }
        return lines.join('\r\n');
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
