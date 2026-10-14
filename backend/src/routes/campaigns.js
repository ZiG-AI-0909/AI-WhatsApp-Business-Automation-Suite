const express = require('express');
const campaignService = require('../campaigns/campaignService');
const db = require('../database/db');
const { formattingNotice } = require('../utils/countryCodes');
const {
    uploadExcel,
    uploadCampaignMedia,
    excelStorageConfig,
    campaignMediaStorageConfig,
    uploadToStorage,
    BUCKETS,
} = require('../middleware/upload');
const { respondIfInvalidUpload } = require('../middleware/fileValidation');
const path = require('node:path');
const campaignMediaStorage = require('../campaigns/campaignMediaStorage');
const sessionManager = require('../whatsapp/sessionManager');

const router = express.Router();

function validIds(ids) {
    return Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(id));
}

function sanitizeCampaignMediaFilename(fileName) {
    const originalName = path.basename(String(fileName || 'attachment')).normalize('NFKD');
    const extension = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, '');
    const rawBase = originalName.slice(0, originalName.length - path.extname(originalName).length);
    const base = rawBase
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return `${base || 'attachment'}${extension}`;
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
    res.json(campaignService.getQueueStatus(req.user.id));
});

// POST /api/campaigns/bulk-delete
router.post('/bulk-delete', async (req, res) => {
    if (!validIds(req.body?.ids)) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
    try {
        res.json(await campaignService.deleteMany(req.body.ids, req.user.id));
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

router.get('/:id/estimate', async (req, res) => {
    try {
        res.json(await campaignService.estimateRemaining(+req.params.id, req.user.id));
    } catch (err) {
        res.status(err.message === 'Campaign not found' ? 404 : 500).json({ error: err.message });
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

        // Parse the in-memory upload instead of downloading the just-uploaded
        // file again; the stored path is retained for campaign creation.
        const result = await campaignService.validateExcelBuffer(req.file.buffer, { countryCode }, req.user.id);
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
        const isImage = ['image/jpeg', 'image/png', 'image/webp'].includes(req.file.mimetype);
        const isPdf = req.file.mimetype === 'application/pdf';
        const sizeLimit = isImage ? 5 * 1024 * 1024 : 16 * 1024 * 1024;
        if (!isImage && !isPdf) {
            return res.status(400).json({ error: 'Campaign attachments must be JPEG, PNG, or WEBP images, or PDF documents.' });
        }
        if (req.file.size > sizeLimit) {
            return res.status(400).json({
                error: isImage ? 'Images must be 5 MB or smaller.' : 'PDF documents must be 16 MB or smaller.',
            });
        }

        const safeFilename = sanitizeCampaignMediaFilename(req.file.originalname);
        const objectName = `${Date.now()}-${safeFilename}`;
        // Multer parsed the file into memory — upload it to Supabase Storage.
        const stored = await uploadToStorage(
            campaignMediaStorageConfig.bucket,
            `${campaignMediaStorageConfig.prefix}${objectName}`,
            req.file.buffer,
            safeFilename,
            req.file.mimetype,
            { objectName },
        );

        const mediaType = isImage ? 'image' : 'document';
        res.json({
            mediaPath: stored.path,
            mediaBucket: stored.bucket,
            mediaObjectPath: stored.objectPath,
            filename: safeFilename,
            mediaType,
            mimetype: req.file.mimetype,
        });
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
    const { name, templateMessage, filePath, settings, allowMissingFields, mediaPath, mediaBucket, mediaObjectPath, mediaType, mediaFilename, mediaMimetype, buttons, countryCode } = req.body;
    if (!name?.trim() || !templateMessage?.trim() || !filePath) {
        return res.status(400).json({ error: 'name, templateMessage, and filePath required' });
    }
    try {
        // For remote files (Supabase Storage), pass the URL directly
        const resolvedFilePath = filePath;
        const resolvedMediaPath = mediaPath || null;

        const campaign = await campaignService.create(req.user.id, { name, templateMessage, filePath: resolvedFilePath, settings, allowMissingFields: !!allowMissingFields, mediaPath: resolvedMediaPath, mediaBucket, mediaObjectPath, mediaType, mediaFilename, mediaMimetype, buttons, countryCode });
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

router.post('/:id/test-media', async (req, res) => {
    try {
        const campaign = await campaignService.get(+req.params.id, req.user.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        if (!campaign.media_path) return res.status(400).json({ error: 'This campaign has no attachment to test.' });
        if ((campaign.provider || 'web') !== 'web') {
            return res.status(400).json({ error: 'Test-to-self is available for WhatsApp Web campaigns only.' });
        }
        if (sessionManager.getStatus(req.user.id) !== 'connected') {
            return res.status(400).json({ error: 'Connect WhatsApp Web before sending a media test.' });
        }

        const ownPhone = sessionManager.getOwnPhoneNumber(req.user.id);
        if (!ownPhone) {
            return res.status(400).json({ error: 'Could not read your connected WhatsApp number. Reconnect WhatsApp and try again.' });
        }
        const [firstContact] = await db.select(
            'campaign_contacts',
            'rendered_message',
            'campaign_id = ? AND user_id = ? AND rendered_message IS NOT NULL',
            [+req.params.id, req.user.id],
            'id',
            1,
            0,
        );
        if (!firstContact?.rendered_message) {
            return res.status(400).json({ error: 'This campaign has no message available to test.' });
        }

        let downloaded;
        try {
            downloaded = await campaignMediaStorage.downloadCampaignMedia(campaign);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }
        await sessionManager.sendMessage(req.user.id, ownPhone, firstContact.rendered_message, null, {
            buffer: downloaded.buffer,
            type: campaign.media_type || 'image',
            filename: campaign.media_filename || 'attachment',
            mimetype: campaign.media_mimetype || 'application/octet-stream',
        });
        res.json({ success: true, message: `Media test sent to your WhatsApp number ending in ${ownPhone.slice(-4)}.` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/:id/retry-failed
router.post('/:id/retry-failed', async (req, res) => {
    try {
        const result = await campaignService.retryFailed(+req.params.id, req.app.get('io'), req.user.id);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/campaigns/:id/pause
router.post('/:id/pause', async (req, res) => {
    try {
        await campaignService.pause(+req.params.id, req.user.id);
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
module.exports.sanitizeCampaignMediaFilename = sanitizeCampaignMediaFilename;
