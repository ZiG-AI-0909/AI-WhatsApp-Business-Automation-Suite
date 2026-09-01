const express = require('express');
const router = express.Router();
const whatsappService = require('../whatsapp/providerManager');

// GET /api/whatsapp/status
router.get('/status', (req, res) => {
    res.json({
        status: whatsappService.getStatus(),
        provider: whatsappService.providerName,
        qrAvailable: !!whatsappService.getQRDataUrl(),
    });
});

// GET /api/whatsapp/qr
router.get('/qr', (req, res) => {
    const qr = whatsappService.getQRDataUrl();
    if (!qr) return res.status(404).json({ error: 'No QR code available' });
    res.json({ qrDataUrl: qr });
});

// POST /api/whatsapp/reconnect
router.post('/reconnect', async (req, res) => {
    try {
        await whatsappService.reconnect();
        res.json({ message: 'Reconnecting...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/whatsapp/disconnect
router.post('/disconnect', async (req, res) => {
    try {
        await whatsappService.disconnect();
        res.json({ message: 'Disconnected' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/provider', async (req, res) => {
    try {
        const { provider, config = {} } = req.body || {};
        await whatsappService.switchProvider(provider);
        if (provider === 'business') whatsappService.configureBusiness(config);
        res.json({ provider: whatsappService.providerName, status: whatsappService.getStatus() });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/business/test', async (req, res) => {
    try {
        whatsappService.configureBusiness(req.body || {});
        res.json(await whatsappService.testBusinessConnection());
    } catch (err) {
        res.status(400).json({ error: err.response?.data?.error?.message || err.message });
    }
});

router.post('/business/connect', async (req, res) => {
    try {
        whatsappService.configureBusiness(req.body || {});
        await whatsappService.switchProvider('business');
        await whatsappService.connect();
        res.json({ provider: whatsappService.providerName, status: whatsappService.getStatus() });
    } catch (err) {
        res.status(400).json({ error: err.response?.data?.error?.message || err.message });
    }
});

module.exports = router;
