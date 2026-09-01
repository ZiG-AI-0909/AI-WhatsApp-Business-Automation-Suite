const express = require('express');
const router = express.Router();
const templateService = require('../templates/templateService');

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

router.get('/', (req, res) => res.json(templateService.list()));

router.post('/bulk-delete', (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    templateService.deleteMany(req.body.ids);
    res.json({ deleted: req.body.ids.length });
});

router.get('/:id', (req, res) => {
    const t = templateService.get(+req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    res.json(t);
});

router.post('/', (req, res) => {
    const { name, content } = req.body;
    if (!name?.trim() || !content?.trim()) return res.status(400).json({ error: 'Name and content required' });
    res.status(201).json(templateService.create(name, content));
});

router.put('/:id', (req, res) => {
    const { name, content } = req.body;
    if (!name?.trim() || !content?.trim()) return res.status(400).json({ error: 'Name and content required' });
    const t = templateService.update(+req.params.id, name, content);
    if (!t) return res.status(404).json({ error: 'Not found' });
    res.json(t);
});

router.post('/:id/duplicate', (req, res) => {
    const t = templateService.duplicate(+req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    res.status(201).json(t);
});

router.delete('/:id', (req, res) => {
    templateService.delete(+req.params.id);
    res.json({ success: true });
});

module.exports = router;
