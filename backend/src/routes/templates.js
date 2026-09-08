const express = require('express');
const templateService = require('../templates/templateService');

const router = express.Router();

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

router.get('/', async (req, res) => {
    try {
        res.json(await templateService.list());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/bulk-delete', async (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    try {
        await templateService.deleteMany(req.body.ids);
        res.json({ deleted: req.body.ids.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const t = await templateService.get(+req.params.id);
        if (!t) return res.status(404).json({ error: 'Not found' });
        res.json(t);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', async (req, res) => {
    const { name, content } = req.body;
    if (!name?.trim() || !content?.trim()) return res.status(400).json({ error: 'Name and content required' });
    try {
        res.status(201).json(await templateService.create(name, content));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.put('/:id', async (req, res) => {
    const { name, content } = req.body;
    if (!name?.trim() || !content?.trim()) return res.status(400).json({ error: 'Name and content required' });
    try {
        const t = await templateService.update(+req.params.id, name, content);
        if (!t) return res.status(404).json({ error: 'Not found' });
        res.json(t);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/:id/duplicate', async (req, res) => {
    try {
        const t = await templateService.duplicate(+req.params.id);
        if (!t) return res.status(404).json({ error: 'Not found' });
        res.status(201).json(t);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await templateService.delete(+req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
