const express = require('express');
const queryService = require('../ai/queryService');

const router = express.Router();

// Keep already-human, actionable errors (validation, configuration)
// intact; everything else gets a specific "Ask AI is temporarily
// unavailable" 503 so the UI never shows a generic "Something went
// wrong" and never blames the Knowledge Base (which this feature no
// longer reads at all).
function isActionable(message) {
    return /^(Type a (question|message) first|Message is too long|Question is too long|AI is not configured)/.test(message)
        || !isTechnical(message);
}

// Mirror of the frontend's technical-noise heuristic: raw provider/DB
// strings must not reach the UI verbatim.
function isTechnical(message) {
    return /(postgres|pgrst|sqlstate|supabase|jwt|relation \w+ does not exist|column \w+ does not exist|row-level security|permission denied|internal server error|econn|etimedout|socket hang up|status code \d+)/i.test(message)
        || /[\n{}]/.test(message);
}

function errorResponse(error) {
    const raw = String(error?.message || 'Ask AI failed.');
    if (isActionable(raw)) return { status: 400, error: raw };
    return {
        status: 503,
        error: 'Ask AI is temporarily unavailable. Please try again in a moment — if it continues, check the server AI settings.',
    };
}

// POST /api/ask-ai/ask — answer an internal question from the built-in
// platform guide + company profile (NOT the Knowledge Base), returning
// the AI answer plus the guide sections used.
router.post('/ask', async (req, res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question : '';
    if (!question.trim()) return res.status(400).json({ error: 'Type a question first.' });
    try {
        res.json(await queryService.ask(req.user.id, question));
    } catch (error) {
        console.error('[askAi] ask failed:', error.message);
        const { status, error: message } = errorResponse(error);
        res.status(status).json({ error: message });
    }
});

// POST /api/ask-ai/chat — conversational assistant turn. The client sends
// the message plus the recent conversation (role/content pairs); the server
// stays stateless. Grounding comes from built-in knowledge only, with a
// company-website fallback when the guides have no match.
router.post('/chat', async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    if (!message.trim()) return res.status(400).json({ error: 'Type a message first.' });
    try {
        res.json(await queryService.chat(req.user.id, message, history));
    } catch (error) {
        console.error('[askAi] chat failed:', error.message);
        const { status, error: message } = errorResponse(error);
        res.status(status).json({ error: message });
    }
});

// GET /api/ask-ai/history — past questions (this user's only). History is
// a convenience log; if its table is missing/unreachable after a deploy,
// return an empty list instead of a 500 so the page still works.
router.get('/history', async (req, res) => {
    try {
        res.json(await queryService.listHistory(req.user.id));
    } catch (error) {
        console.error('[askAi] history unavailable (non-fatal):', error.message);
        res.json([]);
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
