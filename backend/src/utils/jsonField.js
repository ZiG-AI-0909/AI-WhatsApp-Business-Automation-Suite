function parseJsonField(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return fallback;

    try {
        let parsed = JSON.parse(value);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        return parsed;
    } catch {
        return fallback;
    }
}

module.exports = { parseJsonField };
