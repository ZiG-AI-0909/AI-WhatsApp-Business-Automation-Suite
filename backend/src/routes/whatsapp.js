// =============================================================
// WhatsApp routes — strictly per-user.
//
// SECURITY: every handler operates ONLY on req.user.id's own
// session. req.user is set by the requireAuth middleware from the
// validated Supabase JWT and can never be influenced by request
// bodies or query strings. It is therefore impossible for a user
// to read another user's status/QR or control another user's
// connection through these endpoints.
// =============================================================
const express = require('express');
const router = express.Router();
const sessionManager = require('../whatsapp/sessionManager');

// GET /api/whatsapp/status — this user's connection status only
router.get('/status', (req, res) => {
    res.json({
        status: sessionManager.getStatus(req.user.id),
        provider: 'web',
        qrAvailable: !!sessionManager.getQRDataUrl(req.user.id),
        lastError: sessionManager.getLastError(req.user.id),
    });
});

// GET /api/whatsapp/qr — this user's own QR code only
router.get('/qr', (req, res) => {
    const qr = sessionManager.getQRDataUrl(req.user.id);
    if (!qr) return res.status(404).json({ error: 'No QR code available' });
    res.json({ qrDataUrl: qr });
});

// POST /api/whatsapp/connect — lazily create/refresh THIS user's Baileys session
router.post('/connect', async (req, res) => {
    try {
        await sessionManager.initialize(req.user.id);
        res.json({ message: 'Session started. Scan the QR code when it appears.', status: sessionManager.getStatus(req.user.id) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/whatsapp/reconnect — restart this user's socket (keeps auth state)
router.post('/reconnect', async (req, res) => {
    try {
        await sessionManager.disconnect(req.user.id);
        await sessionManager.initialize(req.user.id);
        res.json({ message: 'Reconnecting...', status: sessionManager.getStatus(req.user.id) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/whatsapp/disconnect — drop this user's socket, keep auth state
router.post('/disconnect', async (req, res) => {
    try {
        await sessionManager.disconnect(req.user.id);
        res.json({ message: 'Disconnected', status: sessionManager.getStatus(req.user.id) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/whatsapp/logout — EXPLICIT sign-out only (frontend Sign Out button).
// Fully invalidates the WhatsApp link and deletes stored auth state.
// Never called on tab close, refresh, or connection drop.
router.post('/logout', async (req, res) => {
    try {
        await sessionManager.logout(req.user.id);
        res.json({ message: 'WhatsApp session logged out. A fresh QR scan is required next time.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/whatsapp/business/test — test THIS user's Cloud API credentials
router.post('/business/test', async (req, res) => {
    try {
        res.json(await sessionManager.testBusinessConnection(req.user.id, req.body || {}));
    } catch (err) {
        res.status(400).json({ error: err.response?.data?.error?.message || err.message });
    }
});

// POST /api/whatsapp/business/connect — connect THIS user via Cloud API
router.post('/business/connect', async (req, res) => {
    try {
        const result = await sessionManager.connectBusiness(req.user.id, req.body || {});
        res.json({ provider: 'WhatsApp Business API', ...result });
    } catch (err) {
        res.status(400).json({ error: err.response?.data?.error?.message || err.message });
    }
});

module.exports = router;
