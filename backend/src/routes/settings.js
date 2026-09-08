const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const aiService = require('../ai/aiService');

// Persisted settings live on the same persistent disk as the SQLite database,
// not in .env. The platform dashboard env vars are the source of truth on first
// deploy; the Settings UI writes to settings.json so changes survive restarts.
const SETTINGS_PATH = path.join(__dirname, '..', '..', 'data', 'settings.json');
const DATA_DIR = path.dirname(SETTINGS_PATH);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Map of settings-field keys to their env var names. The UI sends these field
// names; we store both the env name and the current value.
const fieldKeys = {
    aiApiKey: 'AI_API_KEY',
    aiBaseURL: 'AI_BASE_URL',
    aiModel: 'AI_MODEL',
    businessName: 'BUSINESS_NAME',
    businessTagline: 'BUSINESS_TAGLINE',
};

function loadSettings() {
    if (!fs.existsSync(SETTINGS_PATH)) return null;
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function saveSettings(settings) {
    const tempPath = SETTINGS_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2));
    fs.renameSync(tempPath, SETTINGS_PATH);
}

function mergedSetting(key) {
    // JSON config (from Settings UI) takes precedence over process.env.
    const stored = loadSettings();
    if (stored && typeof stored[key] === 'string' && stored[key].trim()) {
        return stored[key].trim();
    }
    return (process.env[key] || '').trim();
}

function getSettings() {
    return {
        ai: {
            available: aiService.isAvailable(),
            model: mergedSetting('AI_MODEL') || aiService.getModel(),
            baseURL: mergedSetting('AI_BASE_URL') || '',
        },
        business: {
            name: mergedSetting('BUSINESS_NAME') || "Bhavesh's Project",
            tagline: mergedSetting('BUSINESS_TAGLINE') || '',
        },
    };
}

// GET /api/settings
router.get('/', (req, res) => {
    res.json(getSettings());
});

router.put('/', (req, res) => {
    const provided = Object.entries(fieldKeys)
        .map(([field, key]) => [key, req.body?.[field]])
        .filter(([, value]) => typeof value === 'string' && value.trim());
    if (!provided.length) return res.json(getSettings());

    const stored = loadSettings() || {};
    for (const [key, value] of provided) {
        stored[key] = value.trim();
        // Also update process.env so the running process picks up the change
        // immediately without a restart.
        process.env[key] = value.trim();
    }
    saveSettings(stored);
    aiService.reconfigure();
    res.json(getSettings());
});

module.exports = router;
