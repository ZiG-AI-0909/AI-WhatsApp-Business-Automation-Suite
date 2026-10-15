// =============================================================
// WhatsApp Business API webhook â€” public route (Meta calls it).
//
// SECURITY: every POST is verified with the app secret of the user who owns
// the phone_number_id. The environment app secret is used only as fallback.
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
const { parseJsonField } = require('../utils/jsonField');

/**
 * Verify Meta's X-Hub-Signature-256: "sha256=<hex HMAC of raw body>".
 * Timing-safe compare; handles Meta's payload-wrapping re-signing
 * (the signed payload is the raw JSON string; an inner "data" key with
 * a JSON string value is unwrapped before the second check).
 */
function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
    if (!signatureHeader || typeof signatureHeader !== 'string') return false;
    const expected = 'sha256=';
    if (!signatureHeader.startsWith(expected)) return false;
    if (!rawBody?.length) return false;

    const provided = signatureHeader.slice(expected.length).trim();
    if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
    const hmac = (payload) =>
        crypto.createHmac('sha256', appSecret).update(payload).digest('hex');

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
 * Delivery statuses (sent/delivered/read/failed) and phone-number quality
 * updates. Errors are logged, never thrown: Meta retries a webhook that
 * fails, and a status problem must not block message handling.
 */
async function applyDeliveryEvents(primaryUserId, primaryPhoneNumberId, events) {
    const deliveryTracker = require('../campaigns/deliveryTracker');
    for (const status of events.statuses) {
        try {
            const ownerId = !status.phoneNumberId || status.phoneNumberId === primaryPhoneNumberId
                ? primaryUserId
                : await businessApiProvider.findUserIdByPhoneNumberId(status.phoneNumberId);
            if (!ownerId) continue;
            await deliveryTracker.applyReceipt(ownerId, {
                messageId: status.id,
                status: status.status,
                timestamp: status.timestamp,
                errors: status.errors,
                callbackData: status.callbackData,
            });
        } catch (error) {
            console.error('[webhook] delivery status could not be applied:', error.message);
        }
    }
    for (const update of events.qualityUpdates) {
        try {
            const ownerId = businessApiProvider.findUserIdByDisplayPhone(update.displayPhoneNumber) || primaryUserId;
            if (!ownerId) continue;
            businessApiProvider.noteQualityEvent(ownerId, update.event, update.currentLimit);
            const event = String(update.event || '').toUpperCase();
            if (event !== 'FLAGGED' && event !== 'DOWNGRADE') continue;
            const message = event === 'FLAGGED'
                ? 'WhatsApp flagged this number for low quality. Review message content and recipient consent before resuming.'
                : `WhatsApp lowered this number's messaging limit${update.currentLimit ? ` to ${update.currentLimit}` : ''}. Review recent campaigns before resuming.`;
            await require('../campaigns/messageQueue').pauseForProviderSignal(ownerId, null, 'quality_low', message);
        } catch (error) {
            console.error('[webhook] quality update could not be applied:', error.message);
        }
    }
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
                const { decryptSettingIfSecret } = require('../utils/encryption');
                storedTokens = rows
                    .map((row) => {
                        // Stored tokens are secret-bearing â†’ decrypt (legacy
                        // plaintext passes through unchanged).
                        const value = decryptSettingIfSecret(row?.key ?? '', typeof row?.value === 'string' ? row.value : '');
                        const parsed = parseJsonField(value, null);
                        if (parsed === null) return value;
                        return parsed?.verifyToken || '';
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

// Incoming WhatsApp events (POST) â€” signature-verified.
router.post('/', async (req, res) => {
    try {
        const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body ?? {}));
        // req.rawBody is captured by the express.json verify callback in server.js.
        const signature = req.get('X-Hub-Signature-256');
        let parsed;
        try {
            parsed = JSON.parse(rawBody.toString('utf8'));
        } catch {
            return res.sendStatus(400);
        }
        const { message, phoneNumberId } = businessApiProvider.normalizeWebhook(parsed);
        const events = businessApiProvider.extractWebhookEvents(parsed);
        let userId = phoneNumberId ? await businessApiProvider.findUserIdByPhoneNumberId(phoneNumberId) : null;
        // Quality updates carry the display number instead of a phone number id.
        if (!userId && events.qualityUpdates.length) {
            userId = businessApiProvider.findUserIdByDisplayPhone(events.qualityUpdates[0].displayPhoneNumber);
        }
        const appSecret = (userId && await businessApiProvider.getAppSecret(userId))
            || process.env.WABA_APP_SECRET
            || process.env.META_APP_SECRET
            || '';
        if (!appSecret) {
            console.error('[webhook] no app secret configured for owning user â€” rejecting POST');
            return res.sendStatus(403);
        }
        if (!verifyMetaSignature(rawBody, signature, appSecret)) {
            console.warn('[webhook] invalid or missing X-Hub-Signature-256 â€” payload rejected');
            return res.sendStatus(401);
        }
        if (!userId) return res.sendStatus(200);
        if (events.statuses.length || events.qualityUpdates.length) {
            await applyDeliveryEvents(userId, phoneNumberId, events);
        }
        if (!message) return res.sendStatus(200);

        const sendMessage = (phone, body, jid, media, buttons) =>
            businessApiProvider.sendMessage(userId, phone, body, media, buttons);
        // Official typing indicator while the AI drafts a reply (marks the
        // customer's message as read). Off unless WABA_TYPING_INDICATOR=true.
        const hooks = process.env.WABA_TYPING_INDICATOR === 'true'
            ? { beforeAiReply: (incoming) => businessApiProvider.sendTypingIndicator(userId, incoming.messageId) }
            : {};
        await incomingMessageService.process(message, userId, req.app.get('io'), sendMessage, hooks);
        res.sendStatus(200);
    } catch (error) {
        console.error('WhatsApp Business webhook error:', error.message);
        res.sendStatus(500);
    }
});

module.exports = router;
