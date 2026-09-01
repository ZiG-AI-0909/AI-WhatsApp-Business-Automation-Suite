const express = require('express');
const router = express.Router();
const analyticsService = require('../analytics/analyticsService');

router.get('/dashboard', (req, res) => {
    res.json(analyticsService.getDashboard());
});

router.get('/campaigns/:id', (req, res) => {
    const data = analyticsService.getCampaignAnalytics(+req.params.id);
    if (!data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
});

router.get('/messages/trend', (req, res) => {
    res.json(analyticsService.getMessageTrend(+req.query.days || 7));
});

module.exports = router;
