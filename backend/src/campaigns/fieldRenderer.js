/**
 * FieldRenderer — Renders {{field}} placeholders with actual row data.
 * Fields are case-insensitive. Missing fields are left as-is or replaced with empty string.
 */
class FieldRenderer {
    /**
     * Render a template message with a row's data.
     * @param {string} template - "Hello {{name}}, from {{company}}..."
     * @param {object} row - { name: 'Rajesh', company: 'ABC Infra', ... }
     * @param {object} options
     * @param {boolean} options.strict - If true, missing fields cause an error
     * @returns {string} Rendered message
     */
    render(template, row, options = {}) {
        return template.replace(/\{\{(\w+)\}\}/g, (match, field) => {
            const key = field.toLowerCase().trim();
            // Try direct match, then case-insensitive
            const value = row[key] ?? row[field] ?? this._findCaseInsensitive(row, key);
            if (value === undefined || value === null || value === '') {
                if (options.strict) throw new Error(`Missing field: ${field}`);
                return match; // Keep placeholder if missing (for preview warnings)
            }
            return String(value);
        });
    }

    _findCaseInsensitive(row, key) {
        const lower = key.toLowerCase();
        const found = Object.keys(row).find(k => k.toLowerCase() === lower);
        return found ? row[found] : undefined;
    }

    /**
     * Extract all {{field}} names from a template.
     * @param {string} template
     * @returns {string[]}
     */
    extractFields(template) {
        const matches = template.match(/\{\{(\w+)\}\}/g) || [];
        return [...new Set(matches.map(m => m.slice(2, -2).toLowerCase()))];
    }

    /**
     * Validate that all required fields exist in a row.
     * @returns {string[]} Missing field names
     */
    getMissingFields(template, row) {
        const required = this.extractFields(template);
        return required.filter(f => {
            const v = row[f] ?? this._findCaseInsensitive(row, f);
            return v === undefined || v === null || v === '';
        });
    }

    /**
     * Preview rendering for multiple rows.
     * @param {string} template
     * @param {object[]} rows
     * @param {number} count
     * @returns {Array} [{phone, rendered, missingFields}]
     */
    previewBatch(template, rows, count = 5) {
        return rows.slice(0, count).map(row => ({
            phone: row.phone || row._phone || '',
            name: row.name || '',
            rendered: this.render(template, row),
            missingFields: this.getMissingFields(template, row),
        }));
    }
}

module.exports = new FieldRenderer();
