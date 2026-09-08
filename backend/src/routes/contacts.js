const express = require('express');
const contactService = require('../contacts/contactService');

const router = express.Router();

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

// GET /api/contacts
router.get('/', async (req, res) => {
    const { search, page, limit, opt_in } = req.query;
    const optIn = opt_in === '1' ? true : opt_in === '0' ? false : undefined;
    try {
        res.json(await contactService.list({ search, page: +page || 1, limit: +limit || 50, optIn }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/contacts/stats
router.get('/stats', async (req, res) => {
    try {
        res.json(await contactService.stats());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/contacts/bulk-delete
router.post('/bulk-delete', async (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    try {
        await contactService.deleteMany(req.body.ids);
        res.json({ deleted: req.body.ids.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/contacts/:id
router.get('/:id', async (req, res) => {
    try {
        const c = await contactService.findById(+req.params.id);
        if (!c) return res.status(404).json({ error: 'Not found' });
        res.json(c);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/contacts/:id
router.put('/:id', async (req, res) => {
    try {
        const updated = await contactService.update(+req.params.id, req.body);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/contacts/:id/optout
router.post('/:id/optout', async (req, res) => {
    try {
        const c = await contactService.findById(+req.params.id);
        if (!c) return res.status(404).json({ error: 'Not found' });
        await contactService.setOptOut(c.phone);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/contacts/:id
router.delete('/:id', async (req, res) => {
    try {
        await contactService.delete(+req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
