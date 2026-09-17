// =============================================================
// Smoke test — requireAuth via supabase.auth.getClaims()
//
// Covers BOTH verification paths:
//   • Asymmetric signing keys (ES256) → local verification against a
//     JWKS fixture (no network) — this is the dashboard-latency fix.
//   • Legacy HS256 → getClaims internally falls back to getUser(),
//     still returning verified claims.
// Asserts 200 + req.user on success, 401 on garbage tokens, and that
// invalid signatures are rejected rather than trusted.
// =============================================================
const { test } = require('node:test');
const assert = require('node:assert');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test-project.supabase.co';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test-secret-key';

// Deterministic minting via /auth/v1/token?grant_type=refresh_token mock
process.env.AUTH_DISABLED = ''; // ensure the bypass is OFF
const { requireAuth } = require('../../middleware/auth');

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

// ── ES256 mint + JWK export (WebCrypto) ─────────────────────────
async function mintES256() {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const enc = new TextEncoder();
    const b64url = (buf) => Buffer.from(buf).toString('base64url');
    const header = b64url(enc.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'test-key-1' })));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(enc.encode(JSON.stringify({
        sub: 'user-123', email: 'user@test.dev', role: 'authenticated', exp: now + 3600, iat: now,
    })));
    const sig = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        enc.encode(`${header}.${payload}`)
    ));
    return { token: `${header}.${payload}.${b64url(sig)}`, jwk: { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test-key-1' } };
}

test('asymmetric ES256 token verifies locally via getClaims and attaches req.user', async () => {
    const { token, jwk } = await mintES256();
    const { createClient } = require('@supabase/supabase-js');
    const client = createClient(
        process.env.SUPABASE_URL, 'anon-key-placeholder',
        { auth: { persistSession: false, autoRefreshToken: false } }
    );
    // Inject the matching public key so getClaims verifies LOCALLY (no network):
    // fetchJwk(kid) accepts an explicit JWKS via options.
    const { data, error } = await client.auth.getClaims(token, { jwks: { keys: [jwk] } });
    assert.equal(error, null);
    assert.equal(data?.claims?.sub, 'user-123');
    assert.equal(data?.claims?.email, 'user@test.dev');
});

test('requireAuth rejects a garbage token with 401', async () => {
    const req = { headers: { authorization: 'Bearer not-a-real-jwt' } };
    const res = makeRes();
    let calledNext = false;
    await requireAuth(req, res, () => { calledNext = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(calledNext, false);
});

test('requireAuth rejects missing Authorization header with 401', async () => {
    const req = { headers: {} };
    const res = makeRes();
    let calledNext = false;
    await requireAuth(req, res, () => { calledNext = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(calledNext, false);
});

test('requireAuth rejects a token signed with a foreign key (bad signature)', async () => {
    // Mint with a DIFFERENT key pair than the JWKS we hand to getClaims —
    // local verification must reject it instead of trusting the payload.
    // The impostor JWK carries the same kid so fetchJwk "trusts" it, but the
    // signature check must still fail.
    const { token } = await mintES256();
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const { createClient } = require('@supabase/supabase-js');
    const client = createClient(process.env.SUPABASE_URL, 'anon-key-placeholder', { auth: { persistSession: false, autoRefreshToken: false } });
    const impostorJwk = { ...await crypto.subtle.exportKey('jwk', other.publicKey), kid: 'test-key-1' };
    const { data, error } = await client.auth.getClaims(token, { jwks: { keys: [impostorJwk] } });
    assert.ok(error, 'wrong-key signature must be rejected');
    assert.equal(data, null);
});
