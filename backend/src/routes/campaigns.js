const express = require('express');
const campaignService = require('../campaigns/campaignService');
const { formattingNotice } = require('../utils/countryCodes');
const {
    uploadExcel,
    uploadCampaignMedia,
    excelStorageConfig,
    campaignMediaStorageConfig,
    uploadToStorage,
    downloadFromStorage,
    BUCKETS,
} = require('../middleware/upload');
const { respondIfInvalidUpload } = require('../middleware/fileValidation');

const router = express.Router();

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

// GET /api/campaigns
router.get('/', async (req, res) => {
    try {
        res.json(await campaignService.list(req.user.id, { page: +req.query.page || 1, limit: +req.query.limit || 20 }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/campaigns/stats
router.get('/stats', async (req, res) => {
    try {
        res.json(await campaignService.stats(req.user.id));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/campaigns/queue-status
router.get('/queue-status', (req, res) => {
    res.json(campaignService.getQueueStatus());
});

// POST /api/campaigns/bulk-delete
router.post('/bulk-delete', async (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    try {
        await campaignService.deleteMany(req.body.ids, req.user.id);
        res.json({ deleted: req.body.ids.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/campaigns/:id
router.get('/:id', async (req, res) => {
    try {
        const c = await campaignService.get(+req.params.id, req.user.id);
        if (!c) return res.status(404).json({ error: 'Not found' });
        res.json(c);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/campaigns/:id/contacts
router.get('/:id/contacts', async (req, res) => {
    try {
        res.json(await campaignService.getContacts(+req.params.id, req.user.id, {
            page: +req.query.page || 1,
            limit: +req.query.limit || 50,
            status: req.query.status,
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/campaigns/validate-excel
router.post('/validate-excel', uploadExcel.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!respondIfInvalidUpload(req, res)) return;
    try {
        // Multer parsed the file into memory — upload it to Supabase Storage.
        const stored = await uploadToStorage(
            excelStorageConfig.bucket,
            `${excelStorageConfig.prefix}${Date.now()}_${req.file.originalname}`,
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype,
        );

        // Per-upload country override arrives as a form field on the same
        // multipart request. When absent, the account's Settings default is used.
        const countryCode = req.body?.countryCode || null;

        // Download the stored file and parse it to validate the contact columns.
        const fileData = await downloadFromStorage(excelStorageConfig.bucket, stored.filename);
        const result = await campaignService.validateExcelBuffer(fileData, { countryCode }, req.user.id);
        res.json({
            filePath: stored.path,
            filename: stored.filename,
            ...result,
            // Plain-language confirmation for the UI, e.g. "342 contacts found.
            // Numbers will be formatted as +91 XXXXXXXXXX unless they already
            // include a country code."
            formattingNotice: formattingNotice(result.valid, result.countryCode),
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/media
router.post('/media', uploadCampaignMedia.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!respondIfInvalidUpload(req, res)) return;

    try {
        // Multer parsed the file into memory — upload it to Supabase Storage.
        const stored = await uploadToStorage(
            campaignMediaStorageConfig.bucket,
            `${campaignMediaStorageConfig.prefix}${Date.now()}_${req.file.originalname}`,
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype,
        );

        // Determine media type based on mimetype
        let mediaType = 'image';
        if (['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(req.file.mimetype)) {
            mediaType = 'document';
        }

        res.json({ mediaPath: stored.path, filename: stored.filename, mediaType, mimetype: req.file.mimetype });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/campaigns/preview
router.post('/preview', async (req, res) => {
    const { filePath, template, count = 5, countryCode } = req.body;
    if (!filePath || !template) return res.status(400).json({ error: 'filePath and template required' });
    try {
        res.json(await campaignService.previewMessages(filePath, template, +count, { countryCode }, req.user.id));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns
router.post('/', async (req, res) => {
    const { name, templateMessage, filePath, settings, allowMissingFields, mediaPath, mediaType, mediaFilename, mediaMimetype, buttons, countryCode } = req.body;
    if (!name?.trim() || !templateMessage?.trim() || !filePath) {
        return res.status(400).json({ error: 'name, templateMessage, and filePath required' });
    }
    try {
        // For remote files (Supabase Storage), pass the URL directly
        const resolvedFilePath = filePath;
        const resolvedMediaPath = mediaPath || null;

        const campaign = await campaignService.create(req.user.id, { name, templateMessage, filePath: resolvedFilePath, settings, allowMissingFields: !!allowMissingFields, mediaPath: resolvedMediaPath, mediaType, mediaFilename, mediaMimetype, buttons, countryCode });
        res.status(201).json(campaign);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/:id/start
router.post('/:id/start', async (req, res) => {
    try {
        await campaignService.start(+req.params.id, req.app.get('io'), req.user.id);
        res.json({ success: true, message: 'Campaign started' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/:id/pause
router.post('/:id/pause', async (req, res) => {
    try {
        await campaignService.pause(+req.params.id);
        res.json({ success: true, message: 'Campaign paused' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/:id/resume
router.post('/:id/resume', async (req, res) => {
    try {
        await campaignService.resume(+req.params.id, req.app.get('io'), req.user.id);
        res.json({ success: true, message: 'Campaign resumed' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/:id/stop
router.post('/:id/stop', async (req, res) => {
    try {
        await campaignService.stop(+req.params.id, req.user.id);
        res.json({ success: true, message: 'Campaign stopped' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// DELETE /api/campaigns/:id
router.delete('/:id', async (req, res) => {
    try {
        await campaignService.delete(+req.params.id, req.user.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
