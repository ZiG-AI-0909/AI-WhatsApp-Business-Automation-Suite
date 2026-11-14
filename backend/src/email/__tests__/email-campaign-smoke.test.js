// Bulk email campaigns — parse, render, send loop, limits, unsubscribe.
// Runs entirely in memory: db methods and the SMTP transport are stubbed.
process.env.ENCRYPTION_KEY ||= 'test-encryption-key-for-email-smoke';
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const db = require('../../database/db');
const emailSender = require('../emailSender');
const service = require('../emailCampaignService');

const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// ─── in-memory db ─────────────────────────────────────────────
const tables = {};
let nextId = 1;
function matches(row, where, params) {
    if (!where) return true;
    const p = [...params];
    return where.split(/\s+AND\s+/i).every(cond => {
        const m = cond.trim().match(/^(\w+)\s*(>=|=)\s*\?$/);
        if (!m) throw new Error(`unsupported where: ${cond}`);
        const value = p.shift();
        const cell = row[m[1]];
        if (m[2] === '>=') return cell != null && new Date(cell) >= new Date(value);
        return String(cell) === String(value);
    });
}
const rowsOf = t => (tables[t] ||= []);
Object.assign(db, {
    isAvailable: () => true,
    async select(t, _cols, where, params = [], orderBy = '', limit = null, offset = 0) {
        let out = rowsOf(t).filter(r => matches(r, where, params)).map(r => ({ ...r }));
        if (orderBy) {
            const [col, dir] = orderBy.split(/\s+/);
            out.sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
        }
        return out.slice(offset || 0, limit == null ? undefined : (offset || 0) + limit);
    },
    async insert(t, data) { const row = { id: nextId++, created_at: new Date().toISOString(), ...data }; rowsOf(t).push(row); return { ...row }; },
    async insertMany(t, list) { return Promise.all(list.map(r => db.insert(t, r))); },
    async update(t, data, where, params) { const hit = rowsOf(t).filter(r => matches(r, where, params)); hit.forEach(r => Object.assign(r, data)); return hit; },
    async del(t, where, params) { tables[t] = rowsOf(t).filter(r => !matches(r, where, params)); },
    async count(t, where, params) { return rowsOf(t).filter(r => matches(r, where, params)).length; },
});
tables.app_settings = [
    { user_id: USER, key: 'SMTP_USER', value: 'shop@gmail.com' },
    { user_id: USER, key: 'SMTP_PASS', value: require('../../utils/encryption').encryptSettingIfSecret('SMTP_PASS', 'abcd efgh ijkl mnop') },
    { user_id: USER, key: 'SMTP_FROM_NAME', value: 'Sudarshan Pipes' },
];

// ─── fake SMTP ────────────────────────────────────────────────
const sent = [];
let transportOptions = null;
let failNext = null;
emailSender._getNodemailer = () => ({
    createTransport(opts) {
        transportOptions = opts;
        return {
            close() {},
            async verify() { return true; },
            async sendMail(msg) {
                if (failNext) { const e = failNext; failNext = null; throw e; }
                sent.push(msg);
                return { messageId: `<m${sent.length}@test>` };
            },
        };
    },
});

const waitFor = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('timed out waiting');
};

async function main() {
    const { _internals } = service;

    // 1. Excel parse: header detection, multi-address cells, dupes, invalid.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Dealers');
    ws.addRow(['Dealer Name', 'E-mail ID', 'City']);
    ws.addRow(['Rajesh', 'RAJESH@Example.com', 'Pune']);
    ws.addRow(['Asha', 'asha@example.com; asha.alt@example.com', 'Goa']);
    ws.addRow(['Dup', 'rajesh@example.com', 'X']);
    ws.addRow(['Bad', 'not-an-email', 'Y']);
    ws.addRow(['Link', { text: 'link@example.com', hyperlink: 'mailto:link@example.com' }, 'Z']);
    const parsed = await service.parseFile(Buffer.from(await wb.xlsx.writeBuffer()), 'list.xlsx');
    assert.deepEqual(parsed.recipients.map(r => r.email), ['rajesh@example.com', 'asha@example.com', 'asha.alt@example.com', 'link@example.com']);
    assert.equal(parsed.recipients[0].name, 'Rajesh');
    assert.equal(parsed.recipients[0].fields.city, 'Pune');
    assert.equal(parsed.duplicates, 1);
    assert.equal(parsed.invalidCount, 1);
    assert.ok(parsed.columns.includes('email') && parsed.columns.includes('name'));

    // CSV with semicolons and pasted text.
    const csv = await service.parseFile(Buffer.from('Name;Email\nA;a@x.com\nB;b@x.com\n'), 'l.csv');
    assert.equal(csv.recipients.length, 2);
    const pasted = service.parsePasted('a@x.com\nBob Kumar, bob@x.com\nbob@x.com\n');
    assert.deepEqual(pasted.recipients.map(r => [r.email, r.name]), [['a@x.com', ''], ['bob@x.com', 'Bob Kumar']]);
    await assert.rejects(service.parseFile(Buffer.from('x'), 'a.pdf'), /Excel/);

    // 2. Rendering: fields filled, values escaped, plain text → HTML.
    const r = _internals.renderEmail('Hi {{Name}}', 'Dear {{name}},\n\nVisit https://x.com\nCity: {{city}}', { name: '<b>Raj</b>', city: 'Pune' });
    assert.equal(r.subject, 'Hi <b>Raj</b>');
    assert.ok(r.html.includes('&lt;b&gt;Raj&lt;/b&gt;'));
    assert.ok(r.html.includes('<a href="https://x.com">'));
    assert.ok(r.html.includes('<br>City: Pune'));
    const prev = service.preview({ subject: 'Hi {{name}}', body: 'Order {{order_no}}', recipients: parsed.recipients });
    assert.deepEqual(prev[0].missingFields, ['order_no']);

    // 3. Unsubscribe token is signed.
    const token = _internals.unsubscribeToken(USER, 'a@x.com');
    assert.deepEqual(_internals.readUnsubscribeToken(token), { userId: USER, email: 'a@x.com' });
    assert.equal(_internals.readUnsubscribeToken(token.slice(0, -2) + 'zz'), null);

    // 4. Not set up → cannot start.
    const other = await service.create(OTHER, { name: 'X', subject: 's', body: 'b', recipients: [{ email: 'q@x.com' }] });
    await assert.rejects(service.start(other.id, OTHER), /not set up/);

    // 5. Full send with unsubscribed person skipped; fast delay for the test.
    await service.unsubscribe(_internals.unsubscribeToken(USER, 'asha.alt@example.com'));
    const campaign = await service.create(USER, {
        name: 'Diwali offer', subject: 'Offer for {{name}}', body: 'Hello {{name}} from {{city}}', recipients: parsed.recipients, settings: { delaySeconds: 2, dailyLimit: 3 },
    });
    assert.equal(campaign.total, 4);
    assert.equal(campaign.skipped, 1);
    // Speed up: patch settings delay below the user-facing minimum.
    const realNormalize = _internals.normalizeSettings;
    tables.email_campaigns.find(c => c.id === campaign.id).settings = { delaySeconds: 2, dailyLimit: 3 };
    const origSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...a) => origSetTimeout(fn, ms >= 1000 ? 5 : ms, ...a);

    await service.start(campaign.id, USER, { publicBaseUrl: 'https://api.example.com' });
    await assert.rejects(service.start(campaign.id, USER), /already sending/);
    await waitFor(async () => (await service.get(campaign.id, USER)).status === 'completed');
    const done = await service.get(campaign.id, USER);
    assert.equal(done.sent, 3);
    assert.equal(sent.length, 3);
    assert.equal(transportOptions.host, 'smtp.gmail.com');
    assert.equal(transportOptions.port, 465);
    assert.equal(transportOptions.auth.pass, 'abcdefghijklmnop', 'Gmail app password spaces removed');
    assert.equal(sent[0].from, '"Sudarshan Pipes" <shop@gmail.com>');
    assert.equal(sent[0].subject, 'Offer for Rajesh');
    assert.ok(sent[0].html.includes('Hello Rajesh from Pune'));
    assert.ok(sent[0].html.includes('https://api.example.com/api/public/email/unsubscribe/'));
    assert.ok(sent[0].headers['List-Unsubscribe']);
    assert.ok(sent[0].text.includes('Hello Rajesh'));
    assert.ok(!sent.some(m => m.to === 'asha.alt@example.com'));

    // 6. Daily limit reached (3 already sent) → waits, stays running, pause works.
    const second = await service.create(USER, { name: 'Next', subject: 's', body: 'b', recipients: [{ email: 'z@x.com' }] });
    tables.email_campaigns.find(c => c.id === second.id).settings = { delaySeconds: 2, dailyLimit: 3 };
    await service.start(second.id, USER);
    await waitFor(async () => /Daily limit/.test((await service.get(second.id, USER)).last_error || ''));
    assert.equal(sent.length, 3);
    await service.pause(second.id, USER);
    assert.equal((await service.get(second.id, USER)).status, 'paused');

    // 7. Login failure pauses and keeps the email pending; bad address fails one only.
    tables.email_campaign_recipients.forEach(row => { if (row.user_id === USER) row.sent_at = null; }); // clear daily window
    failNext = Object.assign(new Error('Invalid login: 535 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });
    await service.resume(second.id, USER);
    await waitFor(async () => (await service.get(second.id, USER)).status === 'paused');
    const paused = await service.get(second.id, USER);
    assert.match(paused.last_error, /App Password/);
    assert.equal((await service.getRecipients(second.id, USER, { status: 'pending' })).total, 1);

    failNext = Object.assign(new Error('550 5.1.1 The email account that you tried to reach does not exist'), { responseCode: 550 });
    await service.resume(second.id, USER);
    await waitFor(async () => (await service.get(second.id, USER)).status === 'completed_with_errors');
    const failedList = await service.getRecipients(second.id, USER, { status: 'failed' });
    assert.match(failedList.recipients[0].error, /does not exist/);

    // 8. Retry failed sends it again.
    await service.retryFailed(second.id, USER);
    await waitFor(async () => (await service.get(second.id, USER)).status === 'completed');
    assert.equal(sent.at(-1).to, 'z@x.com');

    // 9. Restart recovery: a "sending" row is marked failed, never resent.
    const third = await service.create(USER, { name: 'Crash', subject: 's', body: 'b', recipients: [{ email: 'c1@x.com' }, { email: 'c2@x.com' }] });
    const c3 = tables.email_campaigns.find(c => c.id === third.id);
    Object.assign(c3, { status: 'running', settings: { delaySeconds: 2, dailyLimit: 100 } });
    tables.email_campaign_recipients.find(x => x.email === 'c1@x.com').status = 'sending';
    const before = sent.length;
    assert.equal((await service.resumeInterrupted()).resumed, 1);
    await waitFor(async () => ['completed', 'completed_with_errors'].includes((await service.get(third.id, USER)).status));
    assert.deepEqual(sent.slice(before).map(m => m.to), ['c2@x.com']);

    // 10. Ownership + stop + delete.
    assert.equal(await service.get(third.id, OTHER), null);
    await assert.rejects(service.delete(third.id, OTHER), /not found/);
    await service.stop(other.id, OTHER);
    assert.equal((await service.get(other.id, OTHER)).skipped, 1);
    await service.delete(third.id, USER);
    assert.equal(await service.get(third.id, USER), null);

    global.setTimeout = origSetTimeout;
    void realNormalize;
    console.log('email-campaign-smoke: all checks passed');
}

main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
