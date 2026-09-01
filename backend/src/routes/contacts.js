const express = require('express');
const router = express.Router();
const contactService = require('../contacts/contactService');

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

// GET /api/contacts
router.get('/', (req, res) => {
    const { search, page, limit, opt_in } = req.query;
    const optIn = opt_in === '1' ? true : opt_in === '0' ? false : undefined;
    res.json(contactService.list({ search, page: +page || 1, limit: +limit || 50, optIn }));
});

// GET /api/contacts/stats
router.get('/stats', (req, res) => {
    res.json(contactService.stats());
});

// POST /api/contacts/bulk-delete
router.post('/bulk-delete', (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    contactService.deleteMany(req.body.ids);
    res.json({ deleted: req.body.ids.length });
});

// GET /api/contacts/:id
router.get('/:id', (req, res) => {
    const c = contactService.findById(+req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
});

// PUT /api/contacts/:id
router.put('/:id', (req, res) => {
    const updated = contactService.update(+req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
});

// POST /api/contacts/:id/optout
router.post('/:id/optout', (req, res) => {
    const c = contactService.findById(+req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    contactService.setOptOut(c.phone);
    res.json({ success: true });
});

// DELETE /api/contacts/:id
router.delete('/:id', (req, res) => {
    contactService.delete(+req.params.id);
    res.json({ success: true });
});

module.exports = router;
