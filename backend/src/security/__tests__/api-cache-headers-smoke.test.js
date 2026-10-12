// =============================================================
// Smoke test — API HTTP caching headers (304 regression).
//
// Express's default ETag made browsers revalidate every GET;
// identical responses came back as a body-less 304, which the
// frontend treated as an error ("Request failed (304)").
// Proves, WITHOUT real Supabase (server boots against an empty
// in-memory mock; AUTH_DISABLED provides req.user for the
// authenticated probe):
//   1. No /api response sets an ETag header.
//   2. Every /api response sets Cache-Control: no-store.
//   3. A GET that sends If-None-Match still gets a 200 with a
//      body — never a 304.
//
// Run: node backend/src/security/__tests__/api-cache-headers-smoke.test.js
// =============================================================
const assert = require('assert');
const http = require('http');

// ── Test configuration BEFORE any app module loads ──
// Port 0 = bind a random free port. AUTH_DISABLED gives requireAuth a
// synthetic req.user without touching Supabase auth. A 64-hex
// ENCRYPTION_KEY satisfies the fail-loud startup check.
process.env.PORT = '0';
process.env.AUTH_DISABLED = 'true';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

// ── Minimal in-memory Supabase mock injected BEFORE modules load ──
// The boot path (resumeInterrupted, scheduler polling) only reads the
// database; an always-empty result set keeps startup quiet. Any filter
// chain is accepted and resolves to zero rows.
function emptyTable() {
    const builder = {
        select() { return builder; },
        eq() { return builder; },
        neq() { return builder; },
        in() { return builder; },
        gt() { return builder; },
        gte() { return builder; },
        lt() { return builder; },
        lte() { return builder; },
        like() { return builder; },
        ilike() { return builder; },
        is() { return builder; },
        or() { return builder; },
        contains() { return builder; },
        not() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        range() { return builder; },
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then(resolve, reject) {
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
        catch(reject) { return Promise.resolve({ data: [], error: null }).catch(reject); },
        finally(fn) { return Promise.resolve({ data: [], error: null }).finally(fn); },
    };
    return builder;
}

const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
        supabase: { from: () => emptyTable() },
        isAvailable: () => true,
        transaction: async (ops) => { for (const op of ops) await op(); },
        normalizeRow: (r) => r,
        parseJsonFields: (r) => r,
    },
};

// Boot the REAL server (this is the regression target: its ETag config).
const { server } = require('../../server');

function waitForListening() {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        (function poll() {
            if (server.listening) return resolve(server.address().port);
            if (Date.now() - started > 5000) return reject(new Error('server did not start within 5s'));
            setTimeout(poll, 50);
        })();
    });
}

function get(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            { host: '127.0.0.1', port, path, headers },
            (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
            },
        );
        req.on('error', reject);
    });
}

async function main() {
    try {
        const port = await waitForListening();
        const auth = { Authorization: 'Bearer test-token' };

        // ── Test 1: public endpoint — no ETag, no-store ──
        console.log('▶ Test 1: GET /api/health sends no ETag and Cache-Control: no-store');
        const health = await get(port, '/api/health');
        assert.strictEqual(health.status, 200, 'health returns 200');
        assert.strictEqual(health.headers.etag, undefined, 'no ETag on /api responses');
        assert.strictEqual(health.headers['cache-control'], 'no-store', 'Cache-Control: no-store on /api responses');
        const healthBody = JSON.parse(health.body);
        assert.strictEqual(healthBody.status, 'ok', 'health body parses (response would have no body on a 304)');
        console.log('✅ Test 1 passed\n');

        // ── Test 2: authenticated endpoint — same header contract ──
        console.log('▶ Test 2: GET /api/campaigns (authenticated) sends no ETag and no-store');
        const campaigns = await get(port, '/api/campaigns', auth);
        assert.strictEqual(campaigns.status, 200, 'campaigns returns 200');
        assert.strictEqual(campaigns.headers.etag, undefined, 'no ETag on authenticated /api responses');
        assert.strictEqual(campaigns.headers['cache-control'], 'no-store', 'no-store on authenticated /api responses');
        const campaignsBody = JSON.parse(campaigns.body);
        assert.ok(Array.isArray(campaignsBody.data), 'JSON body parses and campaigns data is an array');
        console.log('✅ Test 2 passed\n');

        // ── Test 3: the actual 304 regression — If-None-Match must not 304 ──
        console.log('▶ Test 3: conditional GET (If-None-Match) still returns a full 200');
        const revalidated = await get(port, '/api/health', { 'If-None-Match': '"would-be-etag"' });
        assert.strictEqual(revalidated.status, 200, 'no 304 is ever produced for /api GETs');
        assert.strictEqual(revalidated.headers.etag, undefined, 'still no ETag on revalidation');
        assert.ok(JSON.parse(revalidated.body).status === 'ok', 'revalidated response has a full JSON body');
        console.log('✅ Test 3 passed\n');

        console.log('🎉 ALL API CACHE-HEADERS SMOKE TESTS PASSED');
        server.close(() => process.exit(0));
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
