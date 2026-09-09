const express = require('express');
const templateService = require('../templates/templateService');

const router = express.Router();

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

router.get('/', async (req, res) => {
    try {
        res.json(await templateService.list(req.user.id, { channel: req.query.channel }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/bulk-delete', async (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    try {
        await templateService.deleteMany(req.body.ids, req.user.id);
        res.json({ deleted: req.body.ids.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const t = await templateService.get(+req.params.id, req.user.id);
        if (!t) return res.status(404).json({ error: 'Not found' });
        res.json(t);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', async (req, res) => {
    const { name, content, channel, subject } = req.body;
    if (!name?.trim() || !content?.trim()) return res.status(400).json({ error: 'Name and content required' });
    try {
        res.status(201).json(await templateService.create(req.user.id, name, content, { channel, subject }));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.put('/:id', async (req, res) => {
    const { name, content, channel, subject } = req.body;
    if (!name?.trim() || !content?.trim()) return res.status(400).json({ error: 'Name and content required' });
    try {
        const t = await templateService.update(+req.params.id, name, content, req.user.id, { channel, subject });
        if (!t) return res.status(404).json({ error: 'Not found' });
        res.json(t);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/:id/duplicate', async (req, res) => {
    try {
        const t = await templateService.duplicate(+req.params.id, req.user.id);
        if (!t) return res.status(404).json({ error: 'Not found' });
        res.status(201).json(t);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await templateService.delete(+req.params.id, req.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
