const express = require('express');
const router = express.Router();
const aiService = require('../ai/aiService');
const resendService = require('../email/resendService');
const db = require('../database/db');

// Settings persistence now uses Supabase app_settings table
// instead of local settings.json file (which doesn't survive Render free tier restarts)

const fieldKeys = {
    AI_API_KEY: 'aiApiKey',
    AI_BASE_URL: 'aiBaseURL',
    AI_MODEL: 'aiModel',
    BUSINESS_NAME: 'businessName',
    BUSINESS_TAGLINE: 'businessTagline',
    // Per-user Resend (email campaigns) — same bring-your-own-key pattern
    // as the AI settings above.
    RESEND_API_KEY: 'resendApiKey',
    RESEND_FROM_EMAIL: 'resendFromEmail',
    RESEND_FROM_NAME: 'resendFromName',
};

// Reverse mapping for lookups
const fieldKeysReverse = {};
for (const [envKey, fieldKey] of Object.entries(fieldKeys)) {
    fieldKeysReverse[fieldKey] = envKey;
}

// Settings are now PER-USER (multi-tenant): app_settings rows are owned by
// user_id, and the composite primary key is (user_id, key). Stored tenant
// settings take precedence over process.env defaults. process.env is never
// written from a tenant's PUT (that would leak one tenant's configuration
// into every other tenant's GET fallback); applying per-tenant settings at
// runtime (e.g. per-user AI keys) is Phase 3 work.
async function loadSettings(userId) {
    if (!db.isAvailable()) return null;
    try {
        const rows = await db.select('app_settings', '*', 'user_id = ?', [userId], 'key', 100, 0);
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

async function saveSetting(userId, key, value) {
    if (!db.isAvailable()) {
        throw new Error('Supabase is not configured');
    }
    await db.insert('app_settings', {
        key,
        value,
        user_id: userId,
        updated_at: new Date(),
    }).then(() => {
        // On conflict, update
    }).catch(() => {
        // If insert fails (duplicate (user_id, key)), update instead
        db.update('app_settings', {
            value,
            updated_at: new Date(),
        }, 'user_id = ? AND key = ?', [userId, key]);
    });
}

async function mergedSetting(key, userId) {
    // Stored (per-user) settings take precedence over process.env defaults
    const stored = await loadSettings(userId);
    if (stored && typeof stored[key] === 'string' && stored[key].trim()) {
        return stored[key].trim();
    }
    return (process.env[key] || '').trim();
}

// Shared response shape for GET / and PUT /
async function getSettings(userId) {
    const stored = await loadSettings(userId);
    const [email] = await Promise.all([resendService.getConfig(userId)]);
    return {
        ai: {
            available: aiService.isAvailable(),
            model: (stored?.AI_MODEL || process.env.AI_MODEL || '').trim() || aiService.getModel(),
            baseURL: (stored?.AI_BASE_URL || process.env.AI_BASE_URL || '').trim(),
        },
        business: {
            name: (stored?.BUSINESS_NAME || process.env.BUSINESS_NAME || '').trim() || 'Sudarshan Pipes',
            tagline: (stored?.BUSINESS_TAGLINE || process.env.BUSINESS_TAGLINE || '').trim(),
        },
        // Email (Resend) — mirrors the `ai` section's shape: booleans for
        // secret presence, plain values for sender identity fields.
        email,
    };
}

// GET /api/settings
router.get('/', async (req, res) => {
    try {
        res.json(await getSettings(req.user.id));
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
            return res.json(await getSettings(req.user.id));
        }

        for (const [key, value] of provided) {
            const trimmedValue = value.trim();
            // Store per-user (multi-tenant isolation); do NOT write process.env
            await saveSetting(req.user.id, key, trimmedValue);
        }

        aiService.reconfigure();

        // Return updated settings
        res.json(await getSettings(req.user.id));
    } catch (error) {
        console.error('[settings] PUT error:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/settings/email/test — send a test email to the logged-in
// user's own Supabase auth email using their SAVED Resend credentials.
// Mirrors POST /api/whatsapp/business/test. On failure the response
// carries Resend's actual error message (e.g. "domain not verified"),
// not a generic error.
router.post('/email/test', async (req, res) => {
    try {
        const recipient = req.user.email;
        if (!recipient) {
            return res.status(400).json({ error: 'Your account has no email address to send the test to.' });
        }
        const result = await resendService.sendTestEmail(req.user.id, recipient);
        res.json(result);
    } catch (error) {
        console.error('[settings] email test error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

module.exports = router;
