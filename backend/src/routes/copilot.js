const express = require('express');
const copilotService = require('../copilot/copilotService');

const router = express.Router();

// POST /api/copilot/brief — generate a sales brief for one contact or
// conversation. On-demand only (button in the UI), so AI spend is user
// controlled. Accepts either contactId or conversationId; the response
// only ever contains the requesting user's own data.
router.post('/brief', async (req, res) => {
    const contactId = Number(req.body?.contactId) || null;
    const conversationId = Number(req.body?.conversationId) || null;
    if (!contactId && !conversationId) {
        return res.status(400).json({ error: 'Provide a contactId or a conversationId.' });
    }
    try {
        const brief = await copilotService.brief(req.user.id, {
            contactId,
            conversationId,
            narrative: req.body?.narrative !== false,
        });
        if (!brief) return res.status(404).json({ error: 'Contact or conversation not found.' });
        res.json(brief);
    } catch (error) {
        console.error('[copilot] brief failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
