// Billing smoke test — runs in memory (db + Razorpay API stubbed).
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'hook_secret';
process.env.SUPER_ADMIN_EMAILS = 'boss@example.com';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../../database/db');
const billing = require('../billingService');
const { requireActiveSubscription, addMonths } = billing;

const PAYER = '11111111-1111-1111-1111-111111111111';
const FREE = '22222222-2222-2222-2222-222222222222';
const BOSS = '33333333-3333-3333-3333-333333333333';

const tables = {};
let nextId = 1;
const rowsOf = t => (tables[t] ||= []);
function matches(row, where, params) {
    if (!where) return true;
    const p = [...params];
    return where.split(/\s+AND\s+/i).every(cond => {
        const inM = cond.match(/^(\w+)\s+IN\s*\(\?\)$/i);
        if (inM) return p.shift().includes(row[inM[1]]);
        const m = cond.trim().match(/^(\w+)\s*=\s*\?$/);
        if (!m) throw new Error(`unsupported where ${cond}`);
        return String(row[m[1]]) === String(p.shift());
    });
}
Object.assign(db, {
    isAvailable: () => true,
    async select(t, _c, where, params = [], _o, limit) { return rowsOf(t).filter(r => matches(r, where, params)).slice(0, limit ?? undefined).map(r => ({ ...r })); },
    async insert(t, data) { const row = { id: nextId++, ...data }; rowsOf(t).push(row); return { ...row }; },
    async update(t, data, where, params) { const hit = rowsOf(t).filter(r => matches(r, where, params)); hit.forEach(r => Object.assign(r, data)); return hit.map(r => ({ ...r })); },
});
billing._listAuthAccounts = async () => [
    { user_id: PAYER, email: 'payer@example.com' },
    { user_id: FREE, email: 'free@example.com' },
    { user_id: BOSS, email: 'boss@example.com' },
];
const orders = [];
billing._razorpay = async (method, path, data) => {
    assert.equal(method, 'post'); assert.equal(path, '/orders');
    const order = { id: `order_${orders.length + 1}`, amount: data.amount, currency: data.currency };
    orders.push(order);
    return order;
};

function guard(authId, email) {
    return new Promise(resolve => {
        const req = { user: { authId, email }, access: { superAdmin: false } };
        const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ blocked: true, code: this.code, body }); } };
        requireActiveSubscription(req, res, () => resolve({ blocked: false }));
    });
}
const sign = (orderId, paymentId) => crypto.createHmac('sha256', 'test_secret').update(`${orderId}|${paymentId}`).digest('hex');

async function main() {
    // addMonths clamps month ends.
    assert.equal(addMonths(new Date('2026-01-31T10:00:00Z')).toISOString(), '2026-02-28T10:00:00.000Z');
    assert.equal(addMonths(new Date('2026-11-14T00:00:00Z')).toISOString(), '2026-12-14T00:00:00.000Z');

    // Nobody ticked → nobody blocked.
    assert.equal((await guard(PAYER, 'payer@example.com')).blocked, false);

    // Admin ticks payer at ₹999.
    await assert.rejects(billing.setAccount(PAYER, { required: true, amount: 0 }), /at least/);
    await billing.setAccount(PAYER, { required: true, amount: 999 }, 'boss@example.com');
    const list = await billing.listAccounts();
    const row = list.accounts.find(a => a.user_id === PAYER);
    assert.equal(row.required, true); assert.equal(row.amount, 999); assert.equal(row.paid, false);
    assert.equal(list.accounts.find(a => a.user_id === BOSS).super_admin, true);

    const g = await guard(PAYER, 'payer@example.com');
    assert.equal(g.blocked, true); assert.equal(g.code, 402); assert.equal(g.body.code, 'PAYMENT_REQUIRED');
    assert.equal((await guard(FREE, 'free@example.com')).blocked, false);
    assert.equal((await guard(BOSS, 'boss@example.com')).blocked, false, 'super admin from env never pays');

    // Free account cannot create an order.
    await assert.rejects(billing.createOrder(FREE), /does not need/);

    // Pay: order → bad signature rejected → good signature adds a month.
    const order = await billing.createOrder(PAYER, 'payer@example.com');
    assert.equal(order.amount, 99900); assert.equal(order.keyId, 'rzp_test_key');
    await assert.rejects(billing.verifyPayment(PAYER, { razorpay_order_id: order.orderId, razorpay_payment_id: 'pay_1', razorpay_signature: 'nope' }), /could not confirm/i);
    await assert.rejects(billing.verifyPayment(FREE, { razorpay_order_id: order.orderId, razorpay_payment_id: 'pay_1', razorpay_signature: sign(order.orderId, 'pay_1') }), /does not belong/);
    const status = await billing.verifyPayment(PAYER, { razorpay_order_id: order.orderId, razorpay_payment_id: 'pay_1', razorpay_signature: sign(order.orderId, 'pay_1') });
    assert.equal(status.active, true); assert.equal(status.blocked, false);
    const until1 = new Date(status.paidUntil);
    assert.ok(until1 - Date.now() > 27 * 864e5 && until1 - Date.now() < 32 * 864e5);
    assert.equal((await guard(PAYER, 'payer@example.com')).blocked, false, 'cache cleared on payment');

    // Same payment again (verify + webhook) never adds a second month.
    await billing.verifyPayment(PAYER, { razorpay_order_id: order.orderId, razorpay_payment_id: 'pay_1', razorpay_signature: sign(order.orderId, 'pay_1') });
    const body = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: order.orderId, amount: 99900 } } } }));
    await assert.rejects(billing.handleWebhook(body, 'bad'), /Invalid signature/);
    await billing.handleWebhook(body, crypto.createHmac('sha256', 'hook_secret').update(body).digest('hex'));
    assert.equal((await billing.getStatus(PAYER)).paidUntil, until1.toISOString());

    // Webhook alone settles a second order (browser closed) and stacks a month.
    const order2 = await billing.createOrder(PAYER);
    const body2 = Buffer.from(JSON.stringify({ event: 'order.paid', payload: { payment: { entity: { id: 'pay_2', order_id: order2.orderId, amount: 99900 } } } }));
    await billing.handleWebhook(body2, crypto.createHmac('sha256', 'hook_secret').update(body2).digest('hex'));
    assert.equal((await billing.getStatus(PAYER)).paidUntil, addMonths(until1).toISOString());

    // Wrong amount in webhook is ignored.
    const order3 = await billing.createOrder(PAYER);
    const body3 = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_3', order_id: order3.orderId, amount: 100 } } } }));
    assert.deepEqual(await billing.handleWebhook(body3, crypto.createHmac('sha256', 'hook_secret').update(body3).digest('hex')), { ignored: true });

    // Expired → blocked; manual "mark paid" for cash unblocks; history lists it.
    tables.billing_accounts.find(r => r.user_id === PAYER).paid_until = new Date(Date.now() - 1000);
    billing.clearCache();
    assert.equal((await guard(PAYER)).blocked, true);
    await billing.markPaid(PAYER, { months: 2 }, 'boss@example.com');
    assert.equal((await guard(PAYER)).blocked, false);
    const history = await billing.history(PAYER);
    assert.deepEqual(history.map(h => h.status).sort(), ['manual', 'paid', 'paid']);
    await assert.rejects(billing.markPaid(FREE, {}), /Must pay/);

    // Unticking frees the account.
    tables.billing_accounts.find(r => r.user_id === PAYER).paid_until = null;
    await billing.setAccount(PAYER, { required: false, amount: 999 });
    assert.equal((await guard(PAYER)).blocked, false);

    console.log('billing-smoke: all checks passed');
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
