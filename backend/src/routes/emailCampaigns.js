const express = require('express');
const multer = require('multer');
const path = require('node:path');
const emailCampaignService = require('../email/emailCampaignService');
const emailSender = require('../email/emailSender');

const router = express.Router();

const uploadList = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (['.xlsx', '.csv'].includes(ext)) return cb(null, true);
        cb(Object.assign(new Error('Please upload an Excel (.xlsx) or CSV (.csv) file.'), { statusCode: 400 }));
    },
});

function fail(res, error, fallback = 'Something went wrong. Please try again.') {
    const status = error.statusCode || 400;
    if (status >= 500 && error.code !== 'EMAIL_MIGRATION_PENDING') console.error('[email-campaigns]', error);
    res.status(status).json({ error: status >= 500 && error.code !== 'EMAIL_MIGRATION_PENDING' ? fallback : error.message, code: error.code });
}

function publicBaseUrl(req) {
    return process.env.BACKEND_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
}

const wrap = handler => async (req, res) => {
    try { await handler(req, res); } catch (error) { fail(res, error); }
};

// GET /api/email-campaigns/sender — is a sending account set up?
router.get('/sender', wrap(async (req, res) => {
    res.json(await emailSender.getConfig(req.user.id));
}));

router.get('/', wrap(async (req, res) => {
    res.json({ campaigns: await emailCampaignService.list(req.user.id) });
}));

// POST /api/email-campaigns/parse — multipart "file" (.xlsx/.csv) OR JSON { text }
router.post('/parse', (req, res, next) => {
    if (req.is('multipart/form-data')) {
        return uploadList.single('file')(req, res, err => (err ? res.status(400).json({ error: err.statusCode ? err.message : 'The file could not be uploaded. Please use a .xlsx or .csv file under 10 MB.' }) : next()));
    }
    next();
}, wrap(async (req, res) => {
    if (req.file) return res.json(await emailCampaignService.parseFile(req.file.buffer, req.file.originalname));
    if (typeof req.body?.text === 'string') return res.json(emailCampaignService.parsePasted(req.body.text));
    res.status(400).json({ error: 'Upload a file or paste email addresses.' });
}));

router.post('/preview', wrap(async (req, res) => {
    res.json({ previews: emailCampaignService.preview(req.body || {}) });
}));

// Send one test email to the logged-in user's own address.
router.post('/test', wrap(async (req, res) => {
    res.json(await emailCampaignService.sendTest(req.user.id, req.user.email, req.body || {}));
}));

router.post('/', wrap(async (req, res) => {
    const campaign = await emailCampaignService.create(req.user.id, req.body || {});
    if (req.body?.startNow) {
        return res.status(201).json(await emailCampaignService.start(campaign.id, req.user.id, { publicBaseUrl: publicBaseUrl(req) }));
    }
    res.status(201).json(campaign);
}));

router.get('/:id', wrap(async (req, res) => {
    const campaign = await emailCampaignService.get(+req.params.id, req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
    res.json(campaign);
}));

router.get('/:id/recipients', wrap(async (req, res) => {
    res.json(await emailCampaignService.getRecipients(+req.params.id, req.user.id, {
        status: ['pending', 'sent', 'failed', 'skipped'].includes(req.query.status) ? req.query.status : undefined,
        page: +req.query.page || 1,
        limit: +req.query.limit || 50,
    }));
}));

for (const action of ['start', 'resume', 'retry-failed']) {
    router.post(`/:id/${action}`, wrap(async (req, res) => {
        const method = { start: 'start', resume: 'resume', 'retry-failed': 'retryFailed' }[action];
        res.json(await emailCampaignService[method](+req.params.id, req.user.id, { publicBaseUrl: publicBaseUrl(req) }));
    }));
}

router.post('/:id/pause', wrap(async (req, res) => {
    res.json(await emailCampaignService.pause(+req.params.id, req.user.id));
}));

router.post('/:id/stop', wrap(async (req, res) => {
    res.json(await emailCampaignService.stop(+req.params.id, req.user.id));
}));

router.delete('/:id', wrap(async (req, res) => {
    res.json(await emailCampaignService.delete(+req.params.id, req.user.id));
}));

// ─── Public unsubscribe (no login; signed token) ──────────────
const publicRouter = express.Router();

function page(title, message) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>`
        + `<body style="font-family:Arial,Helvetica,sans-serif;background:#f6f7f9;color:#222;margin:0;padding:48px 16px">`
        + `<div style="max-width:440px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 4px rgba(0,0,0,.08)">`
        + `<h1 style="font-size:20px;margin:0 0 12px">${title}</h1><p style="margin:0;line-height:1.5">${message}</p></div></body></html>`;
}

async function handleUnsubscribe(req, res) {
    try {
        const ok = await emailCampaignService.unsubscribe(req.params.token);
        if (!ok) return res.status(400).type('html').send(page('Link not valid', 'This unsubscribe link is not valid. Please reply to the email and ask to be removed.'));
        res.type('html').send(page('You are unsubscribed', 'You will not receive these emails any more.'));
    } catch (error) {
        console.error('[email-unsubscribe]', error.message);
        res.status(500).type('html').send(page('Please try again', 'We could not process your request right now. Please try the link again in a few minutes.'));
    }
}

// GET only shows a confirm button: email security scanners open links
// automatically, and must not unsubscribe people by doing so.
publicRouter.get('/unsubscribe/:token', (req, res) => {
    const token = String(req.params.token || '').replace(/[^A-Za-z0-9._-]/g, '');
    res.type('html').send(page('Unsubscribe', 'Press the button to stop receiving these emails.'
        + `<form method="post" action="${token}" style="margin-top:20px"><button type="submit" style="background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer">Unsubscribe me</button></form>`));
});
// The button above, and one-click unsubscribe from mail apps (RFC 8058).
publicRouter.post('/unsubscribe/:token', handleUnsubscribe);

module.exports = router;
module.exports.publicRouter = publicRouter;
