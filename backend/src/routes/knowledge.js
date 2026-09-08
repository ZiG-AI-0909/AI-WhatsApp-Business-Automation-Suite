const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const knowledgeBase = require('../ai/knowledgeBase');
const { uploadKnowledge, isRemotePath, downloadFromStorage, BUCKETS } = require('../middleware/upload');

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
router.post('/upload', uploadKnowledge.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { name, category } = req.body;
    try {
        // If it's a remote file (Supabase Storage), download it first
        let content;
        if (isRemotePath(req.file.path)) {
            const fileData = await downloadFromStorage(BUCKETS.knowledge, req.file.path);
            content = fileData.toString('utf8');
        } else {
            content = fs.readFileSync(req.file.path, 'utf8');
        }
        const docName = name?.trim() || req.file.originalname;
        const id = await knowledgeBase.addDocument(docName, category || 'general', content, req.file.path);
        const doc = await knowledgeBase.getDocument(id);
        res.status(201).json(doc);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// PUT /api/knowledge/:id
router.put('/:id', async (req, res) => {
    const updated = await knowledgeBase.updateDocument(+req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
});

// DELETE /api/knowledge/:id
router.delete('/:id', async (req, res) => {
    await knowledgeBase.deleteDocument(+req.params.id);
    res.json({ success: true });
});

module.exports = router;
