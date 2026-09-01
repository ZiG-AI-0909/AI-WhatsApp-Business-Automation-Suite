const express = require('express');
const router = express.Router();
const fs = require('fs');
const knowledgeBase = require('../ai/knowledgeBase');
const { uploadKnowledge } = require('../middleware/upload');

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

// GET /api/knowledge
router.get('/', (req, res) => {
    res.json(knowledgeBase.listDocuments());
});

// POST /api/knowledge/bulk-delete
router.post('/bulk-delete', (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    knowledgeBase.deleteMany(req.body.ids);
    res.json({ deleted: req.body.ids.length });
});

// GET /api/knowledge/:id
router.get('/:id', (req, res) => {
    const doc = knowledgeBase.getDocument(+req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
});

// POST /api/knowledge — create text document
router.post('/', (req, res) => {
    const { name, category, content } = req.body;
    if (!name?.trim() || !content?.trim()) {
        return res.status(400).json({ error: 'Name and content required' });
    }
    const id = knowledgeBase.addDocument(name.trim(), category || 'general', content.trim());
    res.status(201).json(knowledgeBase.getDocument(id));
});

// POST /api/knowledge/upload — upload a text file
router.post('/upload', uploadKnowledge.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { name, category } = req.body;
    try {
        const content = fs.readFileSync(req.file.path, 'utf8');
        const docName = name?.trim() || req.file.originalname;
        const id = knowledgeBase.addDocument(docName, category || 'general', content, req.file.path);
        res.status(201).json(knowledgeBase.getDocument(id));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// PUT /api/knowledge/:id
router.put('/:id', (req, res) => {
    const updated = knowledgeBase.updateDocument(+req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
});

// DELETE /api/knowledge/:id
router.delete('/:id', (req, res) => {
    knowledgeBase.deleteDocument(+req.params.id);
    res.json({ success: true });
});

module.exports = router;
