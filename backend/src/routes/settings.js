const express = require('express');
const router = express.Router();
const aiService = require('../ai/aiService');
const db = require('../database/db');

// Settings persistence now uses Supabase app_settings table
// instead of local settings.json file (which doesn't survive Render free tier restarts)

const fieldKeys = {
    AI_API_KEY: 'aiApiKey',
    AI_BASE_URL: 'aiBaseURL',
    AI_MODEL: 'aiModel',
    BUSINESS_NAME: 'businessName',
    BUSINESS_TAGLINE: 'businessTagline',
};

// Reverse mapping for lookups
const fieldKeysReverse = {};
for (const [envKey, fieldKey] of Object.entries(fieldKeys)) {
    fieldKeysReverse[fieldKey] = envKey;
}

async function loadSettings() {
    if (!db.isAvailable()) return null;
    try {
        const rows = await db.select('app_settings', '*', '', [], 'key', 100, 0);
        const settings = {};
        for (const row of rows) {
            settings[row.key] = row.value;
        }
        return settings;
    } catch (error) {
        console.error('[settings] Error loading settings from Supabase:', error.message);
        return null;
    }
}

async function saveSetting(key, value) {
    if (!db.isAvailable()) {
        throw new Error('Supabase is not configured');
    }
    await db.insert('app_settings', {
        key,
        value,
        updated_at: new Date(),
    }).then(() => {
        // On conflict, update
    }).catch(() => {
        // If insert fails (duplicate key), update instead
        db.update('app_settings', {
            value,
            updated_at: new Date(),
        }, 'key = ?', [key]);
    });
}

async function mergedSetting(key) {
    // Supabase settings take precedence over process.env
    const stored = await loadSettings();
    if (stored && typeof stored[key] === 'string' && stored[key].trim()) {
        return stored[key].trim();
    }
    return (process.env[key] || '').trim();
}

// Shared response shape for GET / and PUT /
async function getSettings() {
    const stored = await loadSettings();
    return {
        ai: {
            available: aiService.isAvailable(),
            model: (stored?.AI_MODEL || process.env.AI_MODEL || '').trim() || aiService.getModel(),
            baseURL: (stored?.AI_BASE_URL || process.env.AI_BASE_URL || '').trim(),
        },
        business: {
            name: (stored?.BUSINESS_NAME || process.env.BUSINESS_NAME || '').trim() || "Bhavesh's Project",
            tagline: (stored?.BUSINESS_TAGLINE || process.env.BUSINESS_TAGLINE || '').trim(),
        },
    };
}

// GET /api/settings
router.get('/', async (req, res) => {
    try {
        res.json(await getSettings());
    } catch (error) {
        console.error('[settings] GET error:', error);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

router.put('/', async (req, res) => {
    try {
        const provided = Object.entries(fieldKeys)
            .map(([key, field]) => [key, req.body?.[field]])
            .filter(([, value]) => typeof value === 'string' && value.trim());

        if (!provided.length) {
            return res.json(await getSettings());
        }


        for (const [key, value] of provided) {
            const trimmedValue = value.trim();
            // Update Supabase
            await saveSetting(key, trimmedValue);
            // Also update process.env for immediate effect
            process.env[key] = trimmedValue;
        }

        aiService.reconfigure();

        // Return updated settings
        res.json(await getSettings());
    } catch (error) {
        console.error('[settings] PUT error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
