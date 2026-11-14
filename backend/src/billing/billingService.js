// =============================================================
// Billing — monthly subscription through Razorpay.
//
// A super admin ticks the accounts that must pay and sets each one's
// monthly price (billing_accounts). Such an account may use the
// automation only while paid_until is in the future; every successful
// Razorpay payment adds one month (from today, or from the current
// paid_until if still active). Super admins never pay.
//
// Razorpay keys are the PLATFORM's (server env only — never per-tenant
// app_settings): RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and optionally
// RAZORPAY_WEBHOOK_SECRET for the backup webhook.
// =============================================================
const crypto = require('node:crypto');
const axios = require('axios');
const db = require('../database/db');
const { superAdminEmails } = require('../security/teamAccess');

const ACCOUNTS = 'billing_accounts';
const PAYMENTS = 'billing_payments';
const SETTINGS = 'billing_settings';
const CACHE_MS = 60 * 1000;
const statusCache = new Map(); // authId -> { at, status }
const customerCache = new Map(); // authId -> { at, isMember, result }
let defaultCache = null; // { at, amountPaise }

class BillingError extends Error {
    constructor(message, statusCode = 400, code = 'BILLING_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

function migrationError(error) {
    const text = `${error?.code || ''} ${error?.message || ''}`;
    if (/42P01|PGRST205|does not exist|Could not find the table/i.test(text) && /billing_/i.test(text)) {
        return new BillingError('Billing needs a one-time database update. Run supabase-billing-migration.sql in Supabase.', 503, 'BILLING_MIGRATION_PENDING');
    }
    return error;
}

function keys() {
    return {
        keyId: String(process.env.RAZORPAY_KEY_ID || '').trim(),
        keySecret: String(process.env.RAZORPAY_KEY_SECRET || '').trim(),
        webhookSecret: String(process.env.RAZORPAY_WEBHOOK_SECRET || '').trim(),
    };
}

/** Add calendar months, clamping the day (31 Jan + 1 month → 28/29 Feb). */
function addMonths(date, months = 1) {
    const d = new Date(date);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return d;
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hmac(secret, text) {
    return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

function isSuperAdmin(req) {
    return Boolean(req?.access?.superAdmin) || superAdminEmails().includes(String(req?.user?.email || '').toLowerCase());
}

class BillingService {
    constructor() {
        this.BillingError = BillingError;
    }

    /** Seam for tests. */
    async _razorpay(method, path, data) {
        const { keyId, keySecret } = keys();
        const response = await axios({
            method,
            url: `https://api.razorpay.com/v1${path}`,
            data,
            auth: { username: keyId, password: keySecret },
            timeout: 20000,
        });
        return response.data;
    }

    /** Seam for tests: every registered login (email + id). */
    async _listAuthAccounts() {
        const { supabase } = require('../database/supabaseClient');
        const { data, error } = await supabase.rpc('team_list_accounts');
        if (error) throw error;
        return data || [];
    }

    clearCache(authId) {
        if (authId) { statusCache.delete(authId); customerCache.delete(authId); } else { statusCache.clear(); customerCache.clear(); }
        const { clearTeamCache } = require('../security/teamAccess');
        clearTeamCache();
    }

    /** Default monthly price (paise) for customers with no price of their own. */
    async getDefaultAmountPaise() {
        if (defaultCache && Date.now() - defaultCache.at < CACHE_MS) return defaultCache.amountPaise;
        let amountPaise = 0;
        try {
            const [row] = await db.select(SETTINGS, 'default_amount_paise', 'id = ?', [1], '', 1, 0);
            amountPaise = Number(row?.default_amount_paise) || 0;
        } catch (error) {
            // Table not created yet → no default price.
            if (!/billing_settings|42P01|PGRST205/i.test(`${error?.code} ${error?.message}`)) throw error;
        }
        defaultCache = { at: Date.now(), amountPaise };
        return amountPaise;
    }

    async setDefaultAmount(amount, actorEmail) {
        const value = Number(amount);
        if (!(value >= 0) || value > 1000000) throw new BillingError('Enter a valid monthly price.');
        const paise = Math.round(value * 100);
        try {
            const existing = await db.select(SETTINGS, 'id', 'id = ?', [1], '', 1, 0);
            const data = { default_amount_paise: paise, updated_at: new Date(), updated_by_email: actorEmail || null };
            if (existing.length) await db.update(SETTINGS, data, 'id = ?', [1]);
            else await db.insert(SETTINGS, { id: 1, ...data });
        } catch (error) {
            if (/billing_settings|42P01|PGRST205/i.test(`${error?.code} ${error?.message}`)) {
                throw new BillingError('Run supabase-billing-customers-migration.sql in Supabase first.', 503, 'BILLING_MIGRATION_PENDING');
            }
            throw error;
        }
        defaultCache = null;
        this.clearCache();
        return { defaultAmount: paise / 100 };
    }

    /**
     * Is this account a paying customer (outside the company), and has it paid?
     * Customer = ticked "Must pay", or not a company team member at all while a
     * default price is set. Company staff (team members, not ticked) are free.
     */
    async customerStatus(authId, { isMember = false } = {}) {
        const cached = customerCache.get(authId);
        if (cached && cached.isMember === isMember && Date.now() - cached.at < CACHE_MS) return cached.result;
        let result = { customer: false, blocked: false };
        try {
            const row = await this._account(authId);
            const ticked = Boolean(row?.required) && Number(row?.amount_paise) > 0;
            const defaulted = !ticked && !isMember && !row && (await this.getDefaultAmountPaise()) > 0;
            if (ticked || defaulted) {
                const status = await this.getStatus(authId, { customer: true });
                result = { customer: true, blocked: status.blocked };
            }
        } catch (error) {
            // Billing not installed: nobody is a customer (previous behaviour).
            if (error.code !== 'BILLING_MIGRATION_PENDING') console.error('[billing] customer check failed:', error.message);
        }
        customerCache.set(authId, { at: Date.now(), isMember, result });
        return result;
    }

    async _account(authId) {
        try {
            const [row] = await db.select(ACCOUNTS, '*', 'user_id = ?', [authId], '', 1, 0);
            return row || null;
        } catch (error) { throw migrationError(error); }
    }

    /** What the signed-in account sees about its own subscription. */
    async getStatus(authId, { now = new Date(), customer = false } = {}) {
        let row = await this._account(authId);
        // A customer nobody has priced yet pays the default monthly price.
        if (customer && !row?.required) {
            const def = await this.getDefaultAmountPaise();
            if (def > 0) row = { ...(row || {}), required: true, amount_paise: def };
        }
        const required = Boolean(row?.required) && Number(row?.amount_paise) > 0;
        const paidUntil = row?.paid_until ? new Date(row.paid_until) : null;
        const active = !required || (paidUntil && paidUntil > now);
        return {
            required,
            active: Boolean(active),
            blocked: required && !active,
            amount: required ? Number(row.amount_paise) / 100 : 0,
            currency: row?.currency || 'INR',
            paidUntil: paidUntil ? paidUntil.toISOString() : null,
            canPayOnline: Boolean(keys().keyId && keys().keySecret),
        };
    }

    /** Cached check used by the route guard. */
    async isBlocked(authId) {
        const cached = statusCache.get(authId);
        if (cached && Date.now() - cached.at < CACHE_MS) return cached.status.blocked;
        const status = await this.getStatus(authId);
        statusCache.set(authId, { at: Date.now(), status });
        return status.blocked;
    }

    // ─── super admin ──────────────────────────────────────────

    async listAccounts() {
        let rows;
        try {
            rows = await db.select(ACCOUNTS, '*', '', [], '', 10000, 0);
        } catch (error) { throw migrationError(error); }
        const byUser = new Map(rows.map(r => [r.user_id, r]));
        const admins = superAdminEmails();
        const now = new Date();
        const accounts = (await this._listAuthAccounts()).map(a => {
            const b = byUser.get(a.user_id);
            const paidUntil = b?.paid_until ? new Date(b.paid_until) : null;
            return {
                user_id: a.user_id,
                email: a.email,
                last_sign_in_at: a.last_sign_in_at || null,
                super_admin: admins.includes(String(a.email || '').toLowerCase()),
                required: Boolean(b?.required),
                amount: b ? Number(b.amount_paise) / 100 : 0,
                paid_until: paidUntil ? paidUntil.toISOString() : null,
                paid: Boolean(paidUntil && paidUntil > now),
            };
        });
        return { accounts, defaultAmount: (await this.getDefaultAmountPaise()) / 100, canPayOnline: Boolean(keys().keyId && keys().keySecret) };
    }

    async setAccount(userId, { required, amount }, actorEmail) {
        const amountNumber = Number(amount);
        if (required && !(amountNumber >= 1)) throw new BillingError('Enter a monthly amount of at least ₹1 for this account.');
        if (amountNumber > 1000000) throw new BillingError('That amount is too large.');
        const amountPaise = Number.isFinite(amountNumber) && amountNumber > 0 ? Math.round(amountNumber * 100) : 0;
        const accounts = await this._listAuthAccounts();
        const account = accounts.find(a => a.user_id === userId);
        if (!account) throw new BillingError('Account not found.', 404);
        const existing = await this._account(userId);
        const data = { email: account.email, required: Boolean(required), amount_paise: amountPaise, updated_at: new Date(), updated_by_email: actorEmail || null };
        try {
            if (existing) await db.update(ACCOUNTS, data, 'user_id = ?', [userId]);
            else await db.insert(ACCOUNTS, { user_id: userId, ...data });
        } catch (error) { throw migrationError(error); }
        this.clearCache(userId);
        return this.getStatus(userId);
    }

    /** Cash / bank transfer received outside Razorpay: add months by hand. */
    async markPaid(userId, { months = 1 } = {}, actorEmail) {
        const count = Math.min(24, Math.max(1, Math.floor(Number(months) || 1)));
        const account = await this._account(userId);
        if (!account?.required) throw new BillingError('Tick "Must pay" for this account first.');
        const period = await this._extend(account, count);
        await db.insert(PAYMENTS, {
            user_id: userId,
            razorpay_order_id: `manual_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            amount_paise: Number(account.amount_paise) * count,
            currency: account.currency || 'INR',
            status: 'manual',
            period_start: period.start,
            period_end: period.end,
            note: `Marked paid by ${actorEmail || 'admin'}`,
            paid_at: new Date(),
        });
        return this.getStatus(userId);
    }

    async _extend(account, months = 1) {
        const now = new Date();
        const current = account.paid_until ? new Date(account.paid_until) : null;
        const start = current && current > now ? current : now;
        const end = addMonths(start, months);
        await db.update(ACCOUNTS, { paid_until: end, updated_at: new Date() }, 'user_id = ?', [account.user_id]);
        this.clearCache(account.user_id);
        return { start, end };
    }

    // ─── paying ───────────────────────────────────────────────

    async createOrder(authId, email, { customer = false } = {}) {
        const { keyId, keySecret } = keys();
        if (!keyId || !keySecret) throw new BillingError('Online payment is not set up yet. Please contact the administrator to pay.', 503, 'BILLING_NOT_CONFIGURED');
        let account = await this._account(authId);
        if (customer && !account?.required) {
            const def = await this.getDefaultAmountPaise();
            if (def > 0) {
                const data = { email: email || null, required: true, amount_paise: def, updated_at: new Date() };
                if (account) await db.update(ACCOUNTS, data, 'user_id = ?', [authId]);
                else await db.insert(ACCOUNTS, { user_id: authId, ...data });
                account = await this._account(authId);
            }
        }
        if (!account?.required || !(Number(account.amount_paise) > 0)) throw new BillingError('Your account does not need a subscription.');

        let order;
        try {
            order = await this._razorpay('post', '/orders', {
                amount: Number(account.amount_paise),
                currency: account.currency || 'INR',
                receipt: `sub_${String(authId).slice(0, 8)}_${Date.now()}`,
                notes: { user_id: authId, purpose: 'monthly_subscription' },
            });
        } catch (error) {
            console.error('[billing] create order failed:', error.response?.data?.error?.description || error.message);
            throw new BillingError('Could not start the payment. Please try again in a minute.', 502, 'BILLING_GATEWAY_ERROR');
        }
        await db.insert(PAYMENTS, {
            user_id: authId,
            razorpay_order_id: order.id,
            amount_paise: Number(order.amount),
            currency: order.currency,
            status: 'created',
        });
        return { keyId, orderId: order.id, amount: Number(order.amount), currency: order.currency, email: email || '' };
    }

    /** Checkout success callback: verify the signature, then add a month. */
    async verifyPayment(authId, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = {}) {
        const { keySecret } = keys();
        if (!orderId || !paymentId || !signature) throw new BillingError('Payment details are missing.');
        if (!keySecret || !safeEqual(hmac(keySecret, `${orderId}|${paymentId}`), signature)) {
            throw new BillingError('We could not confirm this payment. If money was taken, it will be confirmed automatically shortly or refunded by Razorpay.', 400, 'BILLING_SIGNATURE_INVALID');
        }
        const [payment] = await db.select(PAYMENTS, '*', 'razorpay_order_id = ?', [orderId], '', 1, 0);
        if (!payment || payment.user_id !== authId) throw new BillingError('This payment does not belong to your account.', 403);
        return this._settle(payment, paymentId);
    }

    /** Razorpay webhook (backup for when the browser closes before verify). */
    async handleWebhook(rawBody, signature) {
        const { webhookSecret } = keys();
        if (!webhookSecret) throw new BillingError('Webhook secret not configured.', 503);
        if (!rawBody || !safeEqual(hmac(webhookSecret, rawBody), signature)) throw new BillingError('Invalid signature.', 401);
        const event = JSON.parse(rawBody.toString('utf8'));
        if (!['payment.captured', 'order.paid'].includes(event.event)) return { ignored: true };
        const entity = event.payload?.payment?.entity;
        if (!entity?.order_id || !entity?.id) return { ignored: true };
        const [payment] = await db.select(PAYMENTS, '*', 'razorpay_order_id = ?', [entity.order_id], '', 1, 0);
        if (!payment) return { ignored: true };
        if (Number(entity.amount) !== Number(payment.amount_paise)) {
            console.error(`[billing] webhook amount mismatch for order ${entity.order_id}`);
            return { ignored: true };
        }
        return this._settle(payment, entity.id);
    }

    /** Idempotent: the same order never adds a month twice. */
    async _settle(payment, paymentId) {
        if (payment.status === 'paid') return this.getStatus(payment.user_id);
        // Claim the order first so a parallel verify + webhook cannot both extend.
        const claimed = await db.update(PAYMENTS, { status: 'paid', razorpay_payment_id: paymentId, paid_at: new Date() },
            'id = ? AND status = ?', [payment.id, 'created']);
        if (!claimed.length) return this.getStatus(payment.user_id);
        const account = await this._account(payment.user_id);
        const period = await this._extend(account || { user_id: payment.user_id }, 1);
        await db.update(PAYMENTS, { period_start: period.start, period_end: period.end }, 'id = ?', [payment.id]);
        return this.getStatus(payment.user_id);
    }

    async history(authId) {
        try {
            return await db.select(PAYMENTS, 'id, amount_paise, currency, status, period_start, period_end, paid_at, created_at',
                'user_id = ? AND status IN (?)', [authId, ['paid', 'manual']], 'created_at desc', 24, 0);
        } catch (error) { throw migrationError(error); }
    }
}

const service = new BillingService();

/**
 * Route guard for the automation areas. Blocks a ticked account that has
 * not paid (402 PAYMENT_REQUIRED). If billing itself is unavailable
 * (migration not run / DB hiccup) it lets the request through so paying
 * customers are never locked out by a billing outage.
 */
function requireActiveSubscription(req, res, next) {
    if (isSuperAdmin(req)) return next();
    const authId = req.user?.authId;
    if (!authId) return next();
    (req.access?.customer ? Promise.resolve(!req.access.paid) : service.isBlocked(authId))
        .then(blocked => {
            if (!blocked) return next();
            res.status(402).json({ error: 'Your monthly subscription is due. Please pay to continue using the automation.', code: 'PAYMENT_REQUIRED' });
        })
        .catch(error => {
            if (error.code !== 'BILLING_MIGRATION_PENDING') console.error('[billing] check failed, allowing request:', error.message);
            next();
        });
}

module.exports = service;
module.exports.requireActiveSubscription = requireActiveSubscription;
module.exports.isSuperAdmin = isSuperAdmin;
module.exports.addMonths = addMonths;
module.exports.BillingError = BillingError;
