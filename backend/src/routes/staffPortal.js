// =============================================================
// Staff & Member Login + staff dashboard — /api/staff-portal/*
//
// Not behind requireAuth: staff sign in with Staff ID + PIN and use the
// session token from POST /login (technician/staffPortal.js). Everything
// after /login requires that token and only ever returns the signed-in
// staff member's own data — no route takes a staff id from the request.
// =============================================================
const express = require('express');
const { staffLoginLimiter } = require('../middleware/rateLimiterMiddleware');
const portal = require('../technician/staffPortal');

const router = express.Router();

const LOGIN_ERRORS = {
    invalid: [401, 'Invalid Staff ID or PIN.'],
    locked: [423, 'Too many wrong PINs. This Staff ID is locked for 15 minutes.'],
    inactive: [403, 'This Staff ID is not active. Please contact the office.'],
};

function fail(res, error, fallback) {
    if (!error.statusCode) console.error(`[staff-portal] ${fallback}:`, error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : fallback, code: error.code });
}

// Sessions and personal data: never cached.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Deploy check: { configured, missing: [env var names], database }. No secrets.
router.get('/health', staffLoginLimiter, async (req, res) => {
    try {
        res.json(await portal.health());
    } catch (error) {
        fail(res, error, 'Could not check the staff login setup.');
    }
});

router.post('/login', staffLoginLimiter, express.json({ limit: '4kb' }), async (req, res) => {
    try {
        const result = await portal.login(req.body || {});
        if (result.error) {
            const [status, message] = LOGIN_ERRORS[result.error];
            return res.status(status).json({ error: message, code: `STAFF_LOGIN_${result.error.toUpperCase()}` });
        }
        console.log(`[staff-portal] ${result.staff.staff_code} signed in`);
        return res.json({ ...result.session, staff: result.staff });
    } catch (error) {
        return fail(res, error, 'Could not sign you in. Please try again.');
    }
});

router.use(portal.requireStaffSession);

router.get('/me', (req, res) => res.json({ staff: portal.profile(req.staff) }));

router.post('/pin', staffLoginLimiter, express.json({ limit: '4kb' }), async (req, res) => {
    try {
        const result = await portal.changePin(req.staff, req.body || {});
        if (result.errors) return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: result.errors });
        return res.json({ ...result.session, staff: result.staff });
    } catch (error) {
        return fail(res, error, 'Could not change your PIN.');
    }
});

router.get('/summary', async (req, res) => {
    try {
        res.json(await portal.summary(req.staff));
    } catch (error) {
        fail(res, error, 'Could not load your totals.');
    }
});

router.get('/registrations', async (req, res) => {
    try {
        res.json(await portal.registrations(req.staff, req.query));
    } catch (error) {
        fail(res, error, 'Could not load your registrations.');
    }
});

router.get('/link', async (req, res) => {
    try {
        res.json(await portal.personalLink(req.staff, req.get('origin')));
    } catch (error) {
        fail(res, error, 'Could not make your link.');
    }
});

module.exports = router;
