const express = require('express');
const analyticsService = require('../analytics/analyticsService');

const router = express.Router();

router.get('/dashboard', async (req, res) => {
    try {
        res.json(await analyticsService.getDashboard(req.user.id));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/campaigns/:id', async (req, res) => {
    try {
        const data = await analyticsService.getCampaignAnalytics(+req.params.id, req.user.id);
        if (!data) return res.status(404).json({ error: 'Not found' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/messages/trend', async (req, res) => {
    try {
        res.json(await analyticsService.getMessageTrend(req.user.id, +req.query.days || 7));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
