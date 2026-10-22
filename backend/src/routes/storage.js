// =============================================================
// Storage monitoring, alerts and "Download now + clean up" — /api/storage/*
//
// publicRouter (no sign-in, mounted before requireAuth):
//   POST /cron             external scheduler; X-Cron-Secret header
// router (requireAuth):
//   GET  /status, /notifications      every signed-in user: level and
//                                     totals only, no file names
//   everything else                   storage administrators only — the
//                                     KYC staff list (private.kyc_staff)
// Every download / clean-up step records who did it (id + email).
// =============================================================
const crypto = require('crypto');
const express = require('express');
const { isKycStaff, requireKycStaff } = require('../kyc/kycService');
const monitor = require('../storage/storageMonitor');
const files = require('../storage/storageFiles');
const archives = require('../storage/storageArchive');
const jobs = require('../storage/storageJobs');

const GB = 1024 ** 3;

function fail(res, error, fallback) {
    if (!error.statusCode) console.error(`[storage] ${fallback}:`, error.message || error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : fallback, code: error.code });
}

/** The signed-in person (never a shared-workspace owner). */
const actorOf = (req) => ({ id: req.user?.authId || null, email: req.user?.email || null });

// ── Public ───────────────────────────────────────────────────────────
const publicRouter = express.Router();

publicRouter.post('/cron', async (req, res) => {
    const secret = process.env.STORAGE_CRON_SECRET || '';
    const given = String(req.get('x-cron-secret') || '');
    if (secret.length < 16 || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json(await jobs.tick());
});

// ── Signed-in users ─────────────────────────────────────────────────
const router = express.Router();

router.get('/status', async (req, res) => {
    try {
        const [status, isAdmin] = await Promise.all([
            monitor.publicStatus(),
            isKycStaff(req.user?.authId).catch(() => false),
        ]);
        res.json({ ...status, isAdmin });
    } catch (error) {
        if (error.code === 'STORAGE_MIGRATION_PENDING') return res.json({ setupRequired: true, isAdmin: await isKycStaff(req.user?.authId).catch(() => false) });
        fail(res, error, 'Could not load the storage status.');
    }
});

router.get('/notifications', async (req, res) => {
    try {
        const isAdmin = await isKycStaff(req.user?.authId).catch(() => false);
        res.json({ notifications: await monitor.listNotifications({ limit: Number(req.query.limit) || 20, includeEmail: isAdmin }) });
    } catch (error) {
        fail(res, error, 'Could not load storage notifications.');
    }
});

// ── Administrators ──────────────────────────────────────────────────
router.use(requireKycStaff);

function settingsForClient(settings) {
    const gb = (bytes) => (bytes == null ? null : Math.round((bytes / GB) * 1000) / 1000);
    return { ...settings, capacity_gb: gb(settings.capacity_bytes), db_capacity_gb: gb(settings.db_capacity_bytes) };
}

async function overview() {
    const [usage, settings, trend, notifications, folders, history] = await Promise.all([
        monitor.measureUsage(),
        monitor.getSettings(),
        monitor.trend({ days: 30 }),
        monitor.listNotifications({ limit: 20, includeEmail: true }),
        archives.listFolders(),
        archives.listArchives(),
    ]);
    return {
        usage,
        alert: { severity: usage.severity, name: monitor.SEVERITY_NAMES[usage.severity], message: monitor.messageFor(usage.severity, usage) || null },
        settings: settingsForClient(settings),
        trend,
        notifications,
        folders,
        archives: history,
        limits: { maxFiles: archives.MAX_FILES, maxBytes: archives.MAX_BYTES },
        emailSender: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) ? 'server' : (settings.updated_by ? 'admin_settings' : 'none'),
    };
}

router.get('/overview', async (req, res) => {
    try {
        res.json(await overview());
    } catch (error) {
        fail(res, error, 'Could not load storage management.');
    }
});

router.post('/refresh', async (req, res) => {
    try {
        monitor.invalidate();
        await jobs.tick();
        res.json(await overview());
    } catch (error) {
        fail(res, error, 'Could not refresh storage.');
    }
});

router.put('/settings', async (req, res) => {
    try {
        const { values, errors } = monitor.validateSettings(req.body || {});
        if (Object.keys(errors).length) return res.status(400).json({ error: 'Please correct the highlighted settings.', fields: errors });
        await monitor.updateSettings(values, req.user?.authId);
        jobs.tick(); // re-evaluate warnings against the new settings
        res.json(await overview());
    } catch (error) {
        fail(res, error, 'Could not save storage settings.');
    }
});

router.get('/files', async (req, res) => {
    try {
        res.json(await files.listFiles(files.readFileFilters(req.query)));
    } catch (error) {
        fail(res, error, 'Could not list stored files.');
    }
});

router.get('/files/download', async (req, res) => {
    try {
        res.json(await files.downloadUrl(String(req.query.bucket || ''), String(req.query.name || '')));
    } catch (error) {
        fail(res, error, 'Could not create a download link.');
    }
});

// ── Download now + clean up ─────────────────────────────────────────
router.post('/archives', async (req, res) => {
    try {
        res.status(201).json(await archives.createArchive(req.body || {}, actorOf(req)));
    } catch (error) {
        fail(res, error, 'Could not prepare the download.');
    }
});

router.get('/archives/:id', async (req, res) => {
    try {
        res.json(await archives.getArchive(req.params.id));
    } catch (error) {
        fail(res, error, 'Could not load the download.');
    }
});

router.get('/archives/:id/download', async (req, res) => {
    try {
        const result = await archives.streamArchive(req.params.id, res, actorOf(req));
        if (result) console.log(`[storage] archive ${req.params.id} downloaded by ${req.user?.email || req.user?.authId}`);
    } catch (error) {
        if (res.headersSent) return res.destroy();
        fail(res, error, 'Could not create the ZIP.');
    }
});

router.post('/archives/:id/verify', async (req, res) => {
    try {
        res.json(await archives.verifyArchive(req.params.id, req.body || {}, actorOf(req)));
    } catch (error) {
        fail(res, error, 'Could not check the download.');
    }
});

router.post('/archives/:id/cleanup', async (req, res) => {
    try {
        const result = await archives.cleanupArchive(req.params.id, { confirmSaved: req.body?.confirmSaved === true }, actorOf(req));
        jobs.checkSoon();
        res.json(result);
    } catch (error) {
        fail(res, error, 'Could not clean up storage.');
    }
});

router.post('/archives/:id/cancel', async (req, res) => {
    try {
        res.json(await archives.cancelArchive(req.params.id));
    } catch (error) {
        fail(res, error, 'Could not cancel the download.');
    }
});

module.exports = { router, publicRouter };
