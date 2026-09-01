const express = require('express');
const router = express.Router();
const fs = require('fs');
const cronParser = require('cron-parser');
const schedulerService = require('../campaigns/schedulerService');
const { uploadedFilePath, uploadedMediaPath } = require('./schedulePathHelpers');

function validateSchedule(body) {
    if (!['once', 'recurring'].includes(body.scheduleType)) return 'scheduleType must be once or recurring';
    if (!body.name?.trim() || !body.templateMessage?.trim() || !body.filePath) return 'name, templateMessage, and filePath required';
    if (!fs.existsSync(body.filePath)) return 'Uploaded file not found';
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

router.post('/', (req, res) => {
    const error = validateSchedule(req.body || {});
    if (error) return res.status(400).json({ error });
    try {
        res.status(201).json(schedulerService.create({ ...req.body, filePath: uploadedFilePath(req.body.filePath), mediaPath: req.body.mediaPath ? uploadedMediaPath(req.body.mediaPath) : null }));
    } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/', (_req, res) => res.json(schedulerService.list()));
router.post('/bulk-delete', (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    schedulerService.deleteMany(req.body.ids);
    res.json({ deleted: req.body.ids.length });
});
router.get('/:id', (req, res) => {
    const schedule = schedulerService.get(+req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Not found' });
    res.json(schedule);
});
router.patch('/:id/pause', (req, res) => {
    try { res.json(schedulerService.pause(+req.params.id)); } catch (err) { res.status(400).json({ error: err.message }); }
});
router.patch('/:id/resume', (req, res) => {
    try { res.json(schedulerService.resume(+req.params.id)); } catch (err) { res.status(400).json({ error: err.message }); }
});
router.patch('/:id/retry', (req, res) => {
    try { res.json(schedulerService.retry(+req.params.id)); } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post('/:id/cancel', (req, res) => {
    try { res.json(schedulerService.cancel(+req.params.id)); } catch (err) { res.status(400).json({ error: err.message }); }
});
router.delete('/:id', (req, res) => {
    schedulerService.delete(+req.params.id);
    res.json({ success: true });
});

module.exports = router;