// =============================================================
// Team & access — /api/team/* (behind requireAuth).
//
//   GET  /me                 every signed-in account: what it may open
//   (super admins only)
//   GET  /                   all registered accounts + their access
//   POST /members            give access by registered email
//   PUT  /members/:userId    change areas / super admin
//   DELETE /members/:userId  remove all access
//   PUT  /company            whose data the team works on (by email)
// =============================================================
const express = require('express');
const access = require('../security/teamAccess');
const admin = require('../security/teamAdmin');

const router = express.Router();

const actor = (req) => ({ authId: req.user?.authId, email: req.user?.email });

function fail(res, error, fallback) {
    if (!error.statusCode) console.error(`[team] ${fallback}:`, error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : fallback, code: error.code, fields: error.fields });
}

/** Email of the company workspace account (shown in the app header), or null. */
async function companyEmail(ownerId) {
    if (!ownerId) return null;
    try {
        const { supabaseAdmin } = require('../middleware/auth');
        const { data } = await supabaseAdmin.auth.admin.getUserById(ownerId);
        return data?.user?.email || null;
    } catch {
        return null;
    }
}

router.get('/me', async (req, res) => {
    try {
        const me = req.access || { enforced: false, superAdmin: false };
        // One list of areas in both modes (before Team & access is enabled,
        // the KYC areas follow the KYC staff list).
        const permissions = [];
        for (const module of access.MODULES) if (await access.hasModule(req, module).catch(() => false)) permissions.push(module);
        const member = me.enforced && (me.superAdmin || permissions.length);
        res.json({
            enforced: Boolean(me.enforced),
            super_admin: Boolean(me.superAdmin),
            permissions,
            email: req.user?.email || '',
            company_email: member ? await companyEmail(me.companyOwnerId) : null,
        });
    } catch (error) {
        fail(res, error, 'Could not load your access.');
    }
});

router.use(access.requireSuperAdmin);

router.get('/', async (req, res) => {
    try {
        res.json(await admin.listAccounts());
    } catch (error) {
        fail(res, error, 'Could not load the team.');
    }
});

router.post('/members', async (req, res) => {
    try {
        const account = await admin.addByEmail(req.body || {}, actor(req));
        res.status(201).json({ ok: true, account });
    } catch (error) {
        fail(res, error, 'Could not give access.');
    }
});

router.put('/members/:userId', async (req, res) => {
    try {
        const account = await admin.updateAccess(req.params.userId, req.body || {}, actor(req));
        res.json({ ok: true, account });
    } catch (error) {
        fail(res, error, 'Could not save access.');
    }
});

router.delete('/members/:userId', async (req, res) => {
    try {
        const account = await admin.removeAccess(req.params.userId, actor(req));
        res.json({ ok: true, account });
    } catch (error) {
        fail(res, error, 'Could not remove access.');
    }
});

router.put('/company', async (req, res) => {
    try {
        const account = await admin.setCompanyOwner(req.body?.email, actor(req));
        res.json({ ok: true, account });
    } catch (error) {
        fail(res, error, 'Could not change the company workspace.');
    }
});

module.exports = router;
