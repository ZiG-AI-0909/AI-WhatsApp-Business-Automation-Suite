// =============================================================
// Billing — /api/billing/* (behind requireAuth)
//   GET  /me                    my subscription status + payment history
//   POST /order                 start a Razorpay payment for one month
//   POST /verify                Checkout success → verify + add a month
//   (super admins only)
//   GET  /accounts              every account with its billing setting
//   PUT  /accounts/:userId      { required, amount } — tick "must pay" + price
//   POST /accounts/:userId/mark-paid   { months } — cash / bank transfer
// Public: POST /api/billing/webhook (Razorpay, signed)
// =============================================================
const express = require('express');
const billing = require('../billing/billingService');

const router = express.Router();

function fail(res, error, fallback) {
    if (!error.statusCode) console.error(`[billing] ${fallback}:`, error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : fallback, code: error.code });
}

router.get('/me', async (req, res) => {
    try {
        const superAdmin = billing.isSuperAdmin(req);
        const status = superAdmin
            ? { required: false, active: true, blocked: false, amount: 0, currency: 'INR', paidUntil: null, canPayOnline: false }
            : await billing.getStatus(req.user.authId, { customer: Boolean(req.access?.customer) });
        const history = status.required ? await billing.history(req.user.authId) : [];
        res.json({ ...status, superAdmin, customer: Boolean(req.access?.customer), history });
    } catch (error) {
        // Billing not installed yet → nobody is blocked.
        if (error.code === 'BILLING_MIGRATION_PENDING') return res.json({ required: false, active: true, blocked: false, superAdmin: billing.isSuperAdmin(req), migrationPending: true, history: [] });
        fail(res, error, 'Could not load your subscription.');
    }
});

router.post('/order', async (req, res) => {
    try {
        res.json(await billing.createOrder(req.user.authId, req.user.email, { customer: Boolean(req.access?.customer) }));
    } catch (error) { fail(res, error, 'Could not start the payment.'); }
});

router.post('/verify', async (req, res) => {
    try {
        res.json(await billing.verifyPayment(req.user.authId, req.body || {}));
    } catch (error) { fail(res, error, 'Could not confirm the payment.'); }
});

function superAdminOnly(req, res, next) {
    if (billing.isSuperAdmin(req)) return next();
    res.status(403).json({ error: 'Only a super admin can manage subscriptions.', code: 'SUPER_ADMIN_ONLY' });
}

router.get('/accounts', superAdminOnly, async (req, res) => {
    try { res.json(await billing.listAccounts()); } catch (error) { fail(res, error, 'Could not load the accounts.'); }
});

router.put('/default-price', superAdminOnly, async (req, res) => {
    try { res.json(await billing.setDefaultAmount(req.body?.amount, req.user.email)); } catch (error) { fail(res, error, 'Could not save the default price.'); }
});

router.put('/accounts/:userId', superAdminOnly, async (req, res) => {
    try {
        res.json(await billing.setAccount(req.params.userId, req.body || {}, req.user.email));
    } catch (error) { fail(res, error, 'Could not save the subscription.'); }
});

router.post('/accounts/:userId/mark-paid', superAdminOnly, async (req, res) => {
    try {
        res.json(await billing.markPaid(req.params.userId, req.body || {}, req.user.email));
    } catch (error) { fail(res, error, 'Could not mark as paid.'); }
});

// Public webhook (mounted before requireAuth). Uses the raw body captured
// by express.json's verify hook, because the signature covers exact bytes.
const webhookRouter = express.Router();
webhookRouter.post('/', async (req, res) => {
    try {
        await billing.handleWebhook(req.rawBody, req.get('x-razorpay-signature'));
        res.json({ ok: true });
    } catch (error) {
        if (error.statusCode !== 401) console.error('[billing] webhook error:', error.message);
        res.status(error.statusCode || 500).json({ error: 'webhook rejected' });
    }
});

module.exports = router;
module.exports.webhookRouter = webhookRouter;
