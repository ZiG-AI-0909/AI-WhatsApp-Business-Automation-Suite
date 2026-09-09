// =============================================================
// WhatsApp Business API webhook — no auth (Meta calls it).
// Incoming messages are attributed to the user who configured the
// phone_number_id that Meta includes in every webhook payload, so
// messages can never be saved under the wrong tenant.
// =============================================================
const express = require('express');
const router = express.Router();
const businessApiProvider = require('../whatsapp/businessApiProvider');
const incomingMessageService = require('../conversations/incomingMessageService');

router.get('/', (req, res) => {
    try {
        // Webhook verification uses the env verify token (Meta-level config).
        const challenge = businessApiProvider.verifyWebhook(
            null,
            req.query['hub.mode'],
            req.query['hub.verify_token'],
            req.query['hub.challenge'],
        );
        res.status(200).send(challenge);
    } catch {
        res.sendStatus(403);
    }
});

router.post('/', async (req, res) => {
    try {
        const { message, phoneNumberId } = businessApiProvider.normalizeWebhook(req.body);
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
