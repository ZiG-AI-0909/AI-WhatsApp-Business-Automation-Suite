const express = require('express');
const knowledgeBase = require('../ai/knowledgeBase');
const seedKnowledgeService = require('../knowledge/seedKnowledgeService');
const {
    uploadKnowledge,
    knowledgeStorageConfig,
    uploadToStorage,
    downloadFromStorage,
    isRemotePath,
    BUCKETS,
} = require('../middleware/upload');

const router = express.Router();

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

// GET /api/knowledge
// First load for a brand-new account seeds the default company-profile
// document (no-op for anyone who already has documents). Awaited so the
// seeded doc is visible in the very first list response.
router.get('/', async (req, res) => {
    try {
        await seedKnowledgeService.seedIfEmpty(req.user.id);
        res.json(await knowledgeBase.listDocuments(req.user.id));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/knowledge/bulk-delete
router.post('/bulk-delete', async (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    try {
        await knowledgeBase.deleteMany(req.body.ids, req.user.id);
        res.json({ deleted: req.body.ids.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/knowledge/:id
router.get('/:id', async (req, res) => {
    try {
        const doc = await knowledgeBase.getDocument(+req.params.id, req.user.id);
        if (!doc) return res.status(404).json({ error: 'Not found' });
        res.json(doc);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/knowledge — create text document
router.post('/', async (req, res) => {
    const { name, category, content } = req.body;
    if (!name?.trim() || !content?.trim()) {
        return res.status(400).json({ error: 'Name and content required' });
    }
    try {
        const id = await knowledgeBase.addDocument(req.user.id, name.trim(), category || 'general', content.trim());
        res.status(201).json(await knowledgeBase.getDocument(id, req.user.id));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/knowledge/upload — upload a text file
router.post('/upload', uploadKnowledge.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { name, category } = req.body;
    try {
        // Multer parsed the file into memory — upload it to Supabase Storage.
        const stored = await uploadToStorage(
            knowledgeStorageConfig.bucket,
            `${knowledgeStorageConfig.prefix}${Date.now()}_${req.file.originalname}`,
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype,
        );

        // Download the stored file to extract its text content.
        const fileData = await downloadFromStorage(knowledgeStorageConfig.bucket, stored.filename);
        const content = fileData.toString('utf8');

        const docName = name?.trim() || req.file.originalname;
        const id = await knowledgeBase.addDocument(req.user.id, docName, category || 'general', content, stored.path);
        const doc = await knowledgeBase.getDocument(id, req.user.id);
        res.status(201).json(doc);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// PUT /api/knowledge/:id
router.put('/:id', async (req, res) => {
    try {
        const updated = await knowledgeBase.updateDocument(+req.params.id, req.user.id, req.body);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/knowledge/:id
router.delete('/:id', async (req, res) => {
    try {
        await knowledgeBase.deleteDocument(+req.params.id, req.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
