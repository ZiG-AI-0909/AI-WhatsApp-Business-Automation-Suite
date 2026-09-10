// =============================================================
// WhatsApp Business API webhook — public route (Meta calls it).
//
// SECURITY: every POST is verified against Meta's X-Hub-Signature-256
// HMAC-SHA256 signature before the payload is parsed. The key is the
// per-user app secret (each user configures their own WABA); any user
// with a configured app secret participates in verification. Rejecting
// unsigned payloads prevents anyone from injecting fake "incoming
// messages" (and thus AI-generated replies) into any tenant.
//
// GET (subscription handshake) uses the per-user webhook verify token,
// falling back to the env-level token so single-tenant env setups and
// existing Meta app configs keep working.
// =============================================================
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const businessApiProvider = require('../whatsapp/businessApiProvider');
const incomingMessageService = require('../conversations/incomingMessageService');

/**
 * Verify Meta's X-Hub-Signature-256: "sha256=<hex HMAC of raw body>".
 * Timing-safe compare; handles Meta's payload-wrapping re-signing
 * (the signed payload is the raw JSON string; an inner "data" key with
 * a JSON string value is unwrapped before the second check).
 */
function verifyMetaSignature(rawBody, signatureHeader, appSecrets) {
    if (!signatureHeader || typeof signatureHeader !== 'string') return false;
    const expected = 'sha256=';
    if (!signatureHeader.startsWith(expected)) return false;
    if (!rawBody?.length) return false;

    const provided = signatureHeader.slice(expected.length).trim();
    if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
    const hmac = (payload) =>
        crypto.createHmac('sha256', appSecrets).update(payload).digest('hex');

    const rawValid = crypto.timingSafeEqual(
        Buffer.from(provided.toLowerCase(), 'hex'),
        Buffer.from(hmac(rawBody), 'hex'),
    );
    if (rawValid) return true;

    try {
        const parsed = JSON.parse(rawBody.toString('utf8'));
        const inner = parsed?.data;
        if (typeof inner === 'string' && inner) {
            return crypto.timingSafeEqual(
                Buffer.from(provided.toLowerCase(), 'hex'),
                Buffer.from(hmac(Buffer.from(inner, 'utf8')), 'hex'),
            );
        }
    } catch {
        // fall through
    }
    return false;
}

/**
 * Collect every app secret configured in the system: the env-level WABA
 * app secret plus any per-user app_settings row (key APP_SECRET, value
 * JSON string containing appSecret/app_secret). Returns unique non-empty
 * secrets so verification works for any configured tenant.
 */
async function collectAppSecrets() {
    const secrets = new Set();
    const envSecret = process.env.WABA_APP_SECRET || process.env.META_APP_SECRET || '';
    if (envSecret) secrets.add(envSecret);

    try {
        const db = require('../database/db');
        if (db.isAvailable()) {
            const rows = await db.select('app_settings', 'value', 'key = ?', ['APP_SECRET'], '', 100, 0);
            for (const row of rows) {
                const value = typeof row?.value === 'string' ? row.value : '';
                if (!value) continue;
                try {
                    const parsed = JSON.parse(value);
                    for (const key of ['appSecret', 'app_secret', 'APP_SECRET']) {
                        if (typeof parsed?.[key] === 'string' && parsed[key]) secrets.add(parsed[key]);
                    }
                } catch {
                    if (value.length >= 16) secrets.add(value);
                }
            }
        }
    } catch (error) {
        console.error('[webhook] failed to load app secrets for signature verification:', error.message);
    }
    return [...secrets];
}

// Meta webhook verification handshake (GET).
router.get('/', async (req, res) => {
    try {
        // Per-user verify tokens (app_settings WEBHOOK_VERIFY_TOKEN /
        // WABA_WEBHOOK_VERIFY_TOKEN) plus the env-level fallback.
        let storedTokens = [];
        try {
            const db = require('../database/db');
            if (db.isAvailable()) {
                const rows = await db.select(
                    'app_settings', 'value',
                    "key IN ('WEBHOOK_VERIFY_TOKEN','WABA_WEBHOOK_VERIFY_TOKEN')",
                    [], 'key', 100, 0,
                );
                storedTokens = rows
                    .map((row) => {
                        const value = typeof row?.value === 'string' ? row.value : '';
                        try { return JSON.parse(value)?.verifyToken || ''; } catch { return value; }
                    })
                    .filter(Boolean);
            }
        } catch (error) {
            console.error('[webhook] failed to load stored verify tokens:', error.message);
        }
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        const mode = req.query['hub.mode'];

        for (const verifyToken of [...storedTokens, process.env.WABA_WEBHOOK_VERIFY_TOKEN]) {
            try {
                return res.status(200).send(
                    businessApiProvider.verifyWebhook(null, mode, token, challenge, verifyToken),
                );
            } catch {
                // Try the next candidate token.
            }
        }
        res.sendStatus(403);
    } catch {
        res.sendStatus(403);
    }
});

// Incoming WhatsApp events (POST) — signature-verified.
router.post('/', async (req, res) => {
    try {
        const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body ?? {}));
        // req.rawBody is captured by the express.json verify callback in server.js.
        const signature = req.get('X-Hub-Signature-256');
        const appSecrets = await collectAppSecrets();

        if (!appSecrets.length) {
            // Fail closed: without any configured app secret we cannot
            // verify anything, so no payload is processed.
            console.error('[webhook] no WABA app secret configured — rejecting unsigned webhook POST');
            return res.sendStatus(403);
        }

        const verified = appSecrets.some((secret) => verifyMetaSignature(rawBody, signature, secret));
        if (!verified) {
            console.warn('[webhook] invalid or missing X-Hub-Signature-256 — payload rejected');
            return res.sendStatus(401);
        }

        const parsed = JSON.parse(rawBody.toString('utf8'));
        const { message, phoneNumberId } = businessApiProvider.normalizeWebhook(parsed);
        if (!message) return res.sendStatus(200);

        // Attribute the message to the user who configured this number.
        const userId = businessApiProvider.findUserIdByPhoneNumberId(phoneNumberId);
        if (!userId) return res.sendStatus(200);

        const sendMessage = (phone, body, jid, media, buttons) =>
            businessApiProvider.sendMessage(userId, phone, body, media, buttons);
        await incomingMessageService.process(message, userId, req.app.get('io'), sendMessage);
        res.sendStatus(200);
    } catch (error) {
        console.error('WhatsApp Business webhook error:', error.message);
        res.sendStatus(500);
    }
});

module.exports = router;
