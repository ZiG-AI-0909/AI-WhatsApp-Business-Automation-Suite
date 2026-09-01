const express = require('express');
const router = express.Router();
const conversationService = require('../conversations/conversationService');
const whatsappService = require('../whatsapp/providerManager');

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

// GET /api/conversations
router.get('/', (req, res) => {
    const { page, limit, search } = req.query;
    res.json(conversationService.listConversations({ page: +page || 1, limit: +limit || 30, search }));
});

// GET /api/conversations/stats/overview
router.get('/stats/overview', (req, res) => {
    res.json(conversationService.stats());
});

router.post('/bulk-delete', (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    conversationService.deleteMany(req.body.ids);
    res.json({ deleted: req.body.ids.length });
});

router.delete('/:id', (req, res) => {
    conversationService.delete(+req.params.id);
    res.json({ success: true });
});

// GET /api/conversations/:id
router.get('/:id', (req, res) => {
    const conv = conversationService.getConversation(+req.params.id);
    if (!conv) return res.status(404).json({ error: 'Not found' });
    res.json(conv);
});

// GET /api/conversations/:id/messages
router.get('/:id/messages', (req, res) => {
    const msgs = conversationService.getMessages(+req.params.id, +req.query.limit || 50);
    res.json(msgs);
});

// POST /api/conversations/:id/send
router.post('/:id/send', async (req, res) => {
    const { body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Message body required' });

    const conv = conversationService.getConversation(+req.params.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    try {
        await whatsappService.sendMessage(conv.phone, body.trim(), conv.jid);
        conversationService.saveMessage(+req.params.id, 'outbound', body.trim());
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/conversations/:id/ai
router.patch('/:id/ai', (req, res) => {
    const { enabled } = req.body;
    conversationService.setAIEnabled(+req.params.id, !!enabled);
    res.json({ success: true, ai_enabled: !!enabled });
});

// PATCH /api/conversations/:id/status
router.patch('/:id/status', (req, res) => {
    const { status } = req.body;
    const valid = ['open', 'resolved', 'human_takeover'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    conversationService.setStatus(+req.params.id, status);
    res.json({ success: true, status });
});

// POST /api/conversations/:id/read
router.post('/:id/read', (req, res) => {
    conversationService.markRead(+req.params.id);
    res.json({ success: true });
});

module.exports = router;
