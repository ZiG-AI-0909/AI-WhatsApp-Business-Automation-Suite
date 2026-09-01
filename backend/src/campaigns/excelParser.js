const xlsx = require('xlsx');
const path = require('path');

/**
 * Parse an Excel/CSV file and dynamically detect all columns.
 * The 'phone' column is required; all other columns become dynamic fields.
 */
class ExcelParser {
    /**
     * Parse an uploaded Excel file.
     * @param {string} filePath - Absolute path to the uploaded .xlsx file
     * @returns {object} { columns, rows, validation }
     */
    parse(filePath) {
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawRows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

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
     * Get the available dynamic field names (column names excluding phone).
     */
    getDynamicFields(parsedResult) {
        return parsedResult.allColumns.filter(c => c !== parsedResult.phoneColumn);
    }
}

module.exports = new ExcelParser();
