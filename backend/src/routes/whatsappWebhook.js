const express = require('express');
const whatsappService = require('../whatsapp/providerManager');
const router = express.Router();

router.get('/', (req, res) => {
    try {
        const challenge = whatsappService.verifyBusinessWebhook(
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
        await whatsappService.handleBusinessWebhook(req.body);
        res.sendStatus(200);
    } catch (error) {
        console.error('WhatsApp Business webhook error:', error.message);
        res.sendStatus(500);
    }
});

module.exports = router;