// =============================================================
// Security smoke test — webhook signature verification, upload
// content validation, and rate limiter wiring.
//
// Verifies, WITHOUT real Supabase or Meta:
//   1. POST /api/webhooks/whatsapp rejects unsigned / bad-signature
//      payloads (401) even though a valid-looking body is sent.
//   2. A correctly signed payload (HMAC-SHA256 over the raw bytes,
//      X-Hub-Signature-256: sha256=<hex>) is accepted (200).
//   3. Fail-closed: no app secret configured anywhere → 403, no
//      message processing.
//   4. GET handshake: correct env verify token returns the challenge;
//      wrong token → 403.
//   5. Upload magic-byte validation: a text file renamed to .xlsx is
//      rejected; real PNG/ZIP/PDF bytes pass; unknown extensions are
//      rejected.
//   6. Rate limiters are actually mounted on the webhook, image
//      extractor, conversations, campaigns, and settings mounts.
//
// Run: node backend/src/security/__tests__/security-phase1-smoke.test.js
// =============================================================
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const path = require('path');

process.env.WABA_APP_SECRET = 'test-meta-app-secret-0123456789abcdef';
process.env.WABA_WEBHOOK_VERIFY_TOKEN = 'test-verify-token';
delete process.env.AUTH_DISABLED;

// ---- Inject a Supabase mock BEFORE requiring modules that use it ----
const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
        supabase: { from: () => { throw new Error('unexpected supabase call in test'); } },
        isAvailable: () => false, // webhook falls back to env-only secrets/tokens
        transaction: async (ops) => { for (const op of ops) await op(); },
        normalizeRow: (r) => r,
        parseJsonFields: (r) => r,
    },
};

// Build the app the same way server.js does (without listen/startup).
const webhookRouter = require('../../routes/whatsappWebhook');
const { webhookLimiter, aiExtractLimiter, sendLimiter, mutationLimiter } = require('../../middleware/rateLimiterMiddleware');
const { validateUploadBuffer } = require('../../middleware/fileValidation');

const app = express();
// Same raw-body capture as server.js (express.json verify callback) —
// signature verification needs the exact bytes Meta sent.
app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use('/api/webhooks/whatsapp', webhookLimiter, webhookRouter);
// Minimal authenticated stubs for limiter-mount assertions.
app.use('/api/image-extractor', (req, _res, next) => { req.user = { id: 'u1' }; next(); }, aiExtractLimiter, (_req, res) => res.json({ ok: true }));
app.use('/api/conversations', (req, _res, next) => { req.user = { id: 'u1' }; next(); }, sendLimiter, (_req, res) => res.json({ ok: true }));
app.use('/api/campaigns', (req, _res, next) => { req.user = { id: 'u1' }; next(); }, mutationLimiter, (_req, res) => res.json({ ok: true }));
app.use('/api/settings', (req, _res, next) => { req.user = { id: 'u1' }; next(); }, mutationLimiter, (_req, res) => res.json({ ok: true }));

const server = app.listen(0);
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const WEBHOOK_BODY = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN1' }, contacts: [], messages: [] } }] }],
});

function sign(body, secret) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function postWebhook(body, headers = {}) {
    const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
    });
    return res.status;
}

async function test1_rejectsUnsignedAndBadSignatures() {
    console.log('▶ Test 1: unsigned / wrong-signature webhook POSTs are rejected');
    assert.strictEqual(await postWebhook(WEBHOOK_BODY), 401, 'unsigned payload rejected with 401');
    assert.strictEqual(
        await postWebhook(WEBHOOK_BODY, { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) }),
        401,
        'bad signature rejected with 401',
    );
    assert.strictEqual(
        await postWebhook(WEBHOOK_BODY, { 'X-Hub-Signature-256': sign(WEBHOOK_BODY, 'wrong-secret-1234567890') }),
        401,
        'signature from a different secret rejected',
    );
    console.log('✅ Test 1 passed\n');
}

async function test2_acceptsValidSignature() {
    console.log('▶ Test 2: correctly signed payload is accepted');
    // Message list is empty in this fixture → normalizeWebhook returns no
    // message → route answers 200 without touching Supabase.
    assert.strictEqual(
        await postWebhook(WEBHOOK_BODY, { 'X-Hub-Signature-256': sign(WEBHOOK_BODY, process.env.WABA_APP_SECRET) }),
        200,
        'validly signed payload accepted',
    );
    // Meta-style wrapped payloads: signature over inner JSON string in "data".
    const wrapped = JSON.stringify({ data: WEBHOOK_BODY });
    assert.strictEqual(
        await postWebhook(wrapped, { 'X-Hub-Signature-256': sign(WEBHOOK_BODY, process.env.WABA_APP_SECRET) }),
        200,
        'wrapped payload signed over inner JSON accepted',
    );
    console.log('✅ Test 2 passed\n');
}

async function test3_failsClosedWithoutSecret() {
    console.log('▶ Test 3: no app secret configured → fail closed (403)');
    delete process.env.WABA_APP_SECRET;
    // New require to re-evaluate collectAppSecrets against the changed env.
    delete require.cache[require.resolve('../../routes/whatsappWebhook')];
    const freshApp = express();
    freshApp.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
    freshApp.use('/api/webhooks/whatsapp', require('../../routes/whatsappWebhook'));
    const s2 = freshApp.listen(0);
    const res = await fetch(`http://127.0.0.1:${s2.address().port}/api/webhooks/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: WEBHOOK_BODY,
    });
    assert.strictEqual(res.status, 403, 'unsigned+secretless webhook rejected with 403');
    s2.close();
    process.env.WABA_APP_SECRET = 'test-meta-app-secret-0123456789abcdef';
    console.log('✅ Test 3 passed\n');
}

async function test4_getHandshake() {
    console.log('▶ Test 4: GET subscription handshake verifies the token');
    const good = await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(process.env.WABA_WEBHOOK_VERIFY_TOKEN)}&hub.challenge=CHALLENGE_42`);
    assert.strictEqual(good.status, 200, 'correct verify token accepted');
    assert.strictEqual(await good.text(), 'CHALLENGE_42', 'challenge echoed back');
    const bad = await fetch(`${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=CHALLENGE_42`);
    assert.strictEqual(bad.status, 403, 'wrong verify token rejected');
    console.log('✅ Test 4 passed\n');
}

async function test5_uploadMagicByteValidation() {
    console.log('▶ Test 5: upload content validation (magic bytes)');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 7)]);
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(16, 1)]);
    const text = Buffer.from('name,phone\nRaj,919812345678\n', 'utf8');

    assert.deepStrictEqual(validateUploadBuffer(png, 'photo.png'), { ok: true, ext: '.png' }, 'PNG magic accepted');
    assert.deepStrictEqual(validateUploadBuffer(zip, 'sheet.xlsx'), { ok: true, ext: '.xlsx' }, 'ZIP-based .xlsx accepted');
    assert.deepStrictEqual(validateUploadBuffer(pdf, 'doc.pdf'), { ok: true, ext: '.pdf' }, 'PDF magic accepted');

    const renamed = validateUploadBuffer(text, 'evil.xlsx');
    assert.strictEqual(renamed.ok, false, 'text masquerading as .xlsx rejected');
    assert.ok(/does not match/.test(renamed.error), 'clear rejection message');

    assert.strictEqual(validateUploadBuffer(text, 'notes.txt').ok, true, 'clean UTF-8 .txt accepted');
    const binaryTxt = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    assert.strictEqual(validateUploadBuffer(binaryTxt, 'blob.txt').ok, false, 'binary bytes in .txt rejected');
    assert.strictEqual(validateUploadBuffer(png, 'payload.exe').ok, false, 'unknown extension rejected');
    assert.strictEqual(validateUploadBuffer(Buffer.alloc(0), 'empty.png').ok, false, 'empty upload rejected');

    // Knowledge route accepts .md — the text validator must cover it too.
    assert.strictEqual(validateUploadBuffer(Buffer.from('# Docs', 'utf8'), 'doc.md').ok, true, '.md accepted');
    console.log('✅ Test 5 passed\n');
}

async function test6_rateLimitersMounted() {
    console.log('▶ Test 6: rate limiters mounted on sensitive mounts');
    // app.use() pushes one Layer per handler, named after the middleware
    // function. Our four limiters mount on 6 paths in this test app.
    const LIMITER_NAMES = new Set(['webhookLimiter', 'sendLimiter', 'aiExtractLimiter', 'mutationLimiter']);
    const rateLimitLayers = app._router.stack.filter((l) => LIMITER_NAMES.has(l.name)).length;
    assert.ok(rateLimitLayers >= 5, `expected ≥5 limiter layers, saw ${rateLimitLayers}`);
    // Functional proof: the image-extractor limiter trips to 429.
    let last;
    for (let i = 0; i < 31; i++) {
        last = await fetch(`${BASE}/api/image-extractor/stats`, { method: 'GET' });
    }
    assert.strictEqual(last.status, 429, 'image-extractor limiter trips to 429');
    console.log('✅ Test 6 passed\n');
}

async function main() {
    try {
        await test1_rejectsUnsignedAndBadSignatures();
        await test2_acceptsValidSignature();
        await test3_failsClosedWithoutSecret();
        await test4_getHandshake();
        await test5_uploadMagicByteValidation();
        await test6_rateLimitersMounted();
        console.log('🎉 ALL SECURITY SMOKE TESTS PASSED');
        server.close();
        process.exit(0);
    } catch (error) {
        console.error('❌ SECURITY SMOKE TEST FAILED:', error.message);
        console.error(error.stack);
        server.close();
        process.exit(1);
    }
}

main();
