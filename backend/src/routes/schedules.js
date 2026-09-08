const express = require('express');
const fs = require('fs');
const cronParser = require('cron-parser');
const schedulerService = require('../campaigns/schedulerService');
const { isRemotePath } = require('../middleware/upload');

const router = express.Router();

function validateSchedule(body) {
    if (!['once', 'recurring'].includes(body.scheduleType)) return 'scheduleType must be once or recurring';
    if (!body.name?.trim() || !body.templateMessage?.trim() || !body.filePath) return 'name, templateMessage, and filePath required';
    // Skip file existence check for remote files (Supabase Storage)
    if (!isRemotePath(body.filePath) && !fs.existsSync(body.filePath)) return 'Uploaded file not found';
    if (body.scheduleType === 'once') {
        const runAt = new Date(body.runAt);
        if (!body.runAt || Number.isNaN(runAt.getTime()) || runAt <= new Date()) return 'runAt must be a valid future ISO date';
    } else {
        if (!body.recurrenceCron) return 'recurrenceCron is required';
        try { cronParser.CronExpressionParser.parse(body.recurrenceCron); } catch { return 'recurrenceCron must be a valid cron expression'; }
    }
    return null;
}

function validIds(ids) { return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id)); }

router.post('/', async (req, res) => {
    const error = validateSchedule(req.body || {});
    if (error) return res.status(400).json({ error });
    try {
        const schedule = await schedulerService.create({ ...req.body, filePath: req.body.filePath, mediaPath: req.body.mediaPath || null });
        res.status(201).json(schedule);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.get('/', async (_req, res) => {
    try {
        res.json(await schedulerService.list());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/bulk-delete', async (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    try {
        await schedulerService.deleteMany(req.body.ids);
        res.json({ deleted: req.body.ids.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const schedule = await schedulerService.get(+req.params.id);
        if (!schedule) return res.status(404).json({ error: 'Not found' });
        res.json(schedule);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch('/:id/pause', async (req, res) => {
    try { res.json(await schedulerService.pause(+req.params.id)); } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/:id/resume', async (req, res) => {
    try { res.json(await schedulerService.resume(+req.params.id)); } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/:id/retry', async (req, res) => {
    try { res.json(await schedulerService.retry(+req.params.id)); } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/cancel', async (req, res) => {
    try { res.json(await schedulerService.cancel(+req.params.id)); } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
    try {
        await schedulerService.delete(+req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;