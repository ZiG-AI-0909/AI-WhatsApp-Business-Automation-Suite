const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const campaignService = require('../campaigns/campaignService');
const whatsappService = require('../whatsapp/providerManager');
const { uploadExcel, uploadCampaignMedia, UPLOAD_DIR, CAMPAIGN_MEDIA_DIR, isRemotePath, getFileNameFromPath, getBucketForPath, downloadFromStorage, BUCKETS } = require('../middleware/upload');

// File paths are now Supabase Storage URLs, no local path validation needed
function uploadedFilePath(filePath) {
    return filePath;
}

function uploadedMediaPath(filePath) {
    return filePath;
}

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

// GET /api/campaigns
router.get('/', (req, res) => {
    res.json(campaignService.list({ page: +req.query.page || 1, limit: +req.query.limit || 20 }));
});

// GET /api/campaigns/stats
router.get('/stats', (req, res) => {
    res.json(campaignService.stats());
});

// GET /api/campaigns/queue-status
router.get('/queue-status', (req, res) => {
    res.json(campaignService.getQueueStatus());
});

// POST /api/campaigns/bulk-delete
router.post('/bulk-delete', (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    campaignService.deleteMany(req.body.ids);
    res.json({ deleted: req.body.ids.length });
});

// GET /api/campaigns/:id
router.get('/:id', (req, res) => {
    const c = campaignService.get(+req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
});

// GET /api/campaigns/:id/contacts
router.get('/:id/contacts', (req, res) => {
    res.json(campaignService.getContacts(+req.params.id, {
        page: +req.query.page || 1,
        limit: +req.query.limit || 50,
        status: req.query.status,
    }));
});

// POST /api/campaigns/validate-excel
router.post('/validate-excel', uploadExcel.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
        // For Excel files, we need to download from Supabase to validate
        const filePath = isRemotePath(req.file.path) ? req.file.path : req.file.path;
        const result = campaignService.validateExcel(filePath);
        res.json({ filePath, filename: req.file.filename, ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/media
router.post('/media', uploadCampaignMedia.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    // Determine media type based on mimetype
    let mediaType = 'image';
    if (['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(req.file.mimetype)) {
        mediaType = 'document';
    }
    
    res.json({ mediaPath: req.file.path, filename: req.file.filename, mediaType, mimetype: req.file.mimetype });
});

// POST /api/campaigns/preview
router.post('/preview', async (req, res) => {
    const { filePath, template, count = 5 } = req.body;
    if (!filePath || !template) return res.status(400).json({ error: 'filePath and template required' });
    try {
        // If it's a remote file, we need to handle it differently
        res.json(campaignService.previewMessages(filePath, template, +count));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns
router.post('/', async (req, res) => {
    const { name, templateMessage, filePath, settings, allowMissingFields, mediaPath, mediaType, mediaFilename, mediaMimetype, buttons } = req.body;
    if (!name?.trim() || !templateMessage?.trim() || !filePath) {
        return res.status(400).json({ error: 'name, templateMessage, and filePath required' });
    }
    try {
        // For remote files (Supabase Storage), pass the URL directly
        // For local files (during transition), resolve the path
        const resolvedFilePath = isRemotePath(filePath) ? filePath : filePath;
        const resolvedMediaPath = mediaPath ? (isRemotePath(mediaPath) ? mediaPath : mediaPath) : null;
        
        const campaign = await campaignService.create({ name, templateMessage, filePath: resolvedFilePath, settings, allowMissingFields: !!allowMissingFields, mediaPath: resolvedMediaPath, mediaType, mediaFilename, mediaMimetype, buttons });
        res.status(201).json(campaign);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/:id/start
router.post('/:id/start', async (req, res) => {
    try {
        await campaignService.start(+req.params.id, whatsappService, req.app.get('io'));
        res.json({ success: true, message: 'Campaign started' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/:id/pause
router.post('/:id/pause', (req, res) => {
    try {
        campaignService.pause(+req.params.id);
        res.json({ success: true, message: 'Campaign paused' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/:id/resume
router.post('/:id/resume', (req, res) => {
    try {
        campaignService.resume(+req.params.id, whatsappService, req.app.get('io'));
        res.json({ success: true, message: 'Campaign resumed' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/:id/stop
router.post('/:id/stop', (req, res) => {
    campaignService.stop(+req.params.id);
    res.json({ success: true, message: 'Campaign stopped' });
});

// DELETE /api/campaigns/:id
router.delete('/:id', (req, res) => {
    campaignService.delete(+req.params.id);
    res.json({ success: true });
});

module.exports = router;
