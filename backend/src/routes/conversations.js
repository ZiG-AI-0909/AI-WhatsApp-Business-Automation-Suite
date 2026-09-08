const express = require('express');
const conversationService = require('../conversations/conversationService');
const whatsappService = require('../whatsapp/providerManager');

const router = express.Router();

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

// GET /api/conversations
router.get('/', async (req, res) => {
    const { page, limit, search } = req.query;
    try {
        res.json(await conversationService.listConversations({ page: +page || 1, limit: +limit || 30, search }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/conversations/stats/overview
router.get('/stats/overview', async (req, res) => {
    try {
        res.json(await conversationService.stats());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/bulk-delete', async (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    try {
        await conversationService.deleteMany(req.body.ids);
        res.json({ deleted: req.body.ids.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await conversationService.delete(+req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/conversations/:id
router.get('/:id', async (req, res) => {
    try {
        const conv = await conversationService.getConversation(+req.params.id);
        if (!conv) return res.status(404).json({ error: 'Not found' });
        res.json(conv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/conversations/:id/messages
router.get('/:id/messages', async (req, res) => {
    try {
        const msgs = await conversationService.getMessages(+req.params.id, +req.query.limit || 50);
        res.json(msgs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/conversations/:id/send
router.post('/:id/send', async (req, res) => {
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Message body required' });

    try {
        const conv = await conversationService.getConversation(+req.params.id);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        await whatsappService.sendMessage(conv.phone, body.trim(), conv.jid);
        await conversationService.saveMessage(+req.params.id, 'outbound', body.trim());
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/conversations/:id/ai
router.patch('/:id/ai', async (req, res) => {
    const { enabled } = req.body;
    try {
        await conversationService.setAIEnabled(+req.params.id, !!enabled);
        res.json({ success: true, ai_enabled: !!enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/conversations/:id/status
router.patch('/:id/status', async (req, res) => {
    const { status } = req.body;
    const valid = ['open', 'resolved', 'human_takeover'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    try {
        await conversationService.setStatus(+req.params.id, status);
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/conversations/:id/read
router.post('/:id/read', async (req, res) => {
    try {
        await conversationService.markRead(+req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
