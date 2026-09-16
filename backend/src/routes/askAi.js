const express = require('express');
const queryService = require('../ai/queryService');

const router = express.Router();

// POST /api/ask-ai — answer a technical question from the Knowledge Base,
// returning the AI answer plus the exact source documents used.
router.post('/ask', async (req, res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question : '';
    if (!question.trim()) return res.status(400).json({ error: 'Type a question first.' });
    try {
        res.json(await queryService.ask(req.user.id, question));
    } catch (error) {
        console.error('[askAi] ask failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/ask-ai/chat — conversational assistant turn. The client sends
// the message plus the recent conversation (role/content pairs); the server
// stays stateless. Retrieval + grounding rules are the same as /ask, with a
// company-website fallback when the Knowledge Base has no match.
router.post('/chat', async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!message.trim()) return res.status(400).json({ error: 'Type a message first.' });
    try {
        res.json(await queryService.chat(req.user.id, message, history));
    } catch (error) {
        console.error('[askAi] chat failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/ask-ai/history — past questions (this user's only).
router.get('/history', async (req, res) => {
    try {
        res.json(await queryService.listHistory(req.user.id));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/ask-ai/history/:id — remove one saved question.
router.delete('/history/:id', async (req, res) => {
    try {
        await queryService.deleteHistory(+req.params.id, req.user.id);
        res.json({ success: true });
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

module.exports = router;
