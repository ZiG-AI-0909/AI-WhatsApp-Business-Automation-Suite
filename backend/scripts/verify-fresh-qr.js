// =============================================================
// One-off verification for the fresh-creds QR fix.
//
// Simulates a BRAND NEW user end-to-end with REAL Supabase and
// REAL Baileys (no mocks):
//   1. Deletes any whatsapp_sessions row for a synthetic test user.
//   2. Calls sessionManager.initialize() (the exact production path).
//   3. Waits for Baileys' connection.update — passes only if a QR
//      arrives ("qr=yes"), which proves the noise handshake no
//      longer crashes on empty creds.
//   4. Cleans up: disconnects and deletes the test row again.
//
// Run: node scripts/verify-fresh-qr.js
// (from the backend/ directory; loads the repo-root .env)
// =============================================================
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const sessionManager = require('../src/whatsapp/sessionManager');
const authStateStore = require('../src/whatsapp/authStateStore');
const { supabase, isAvailable } = require('../src/database/supabaseClient');

// Fixed synthetic test user — never a real account's UUID.
const TEST_USER_ID = '00000000-0000-4000-8000-000000000d0d';
const QR_TIMEOUT_MS = 50000;

async function main() {
    if (!isAvailable()) {
        console.error('[verify] Supabase is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY) — cannot run.');
        process.exit(1);
    }

    // ---- 1. Fresh start: remove any stored auth row for the test user ----
    const { error: delError } = await supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('user_id', TEST_USER_ID);
    if (delError) {
        console.error('[verify] failed to clean test row:', delError.message);
        process.exit(1);
    }
    console.log(`[verify] step 1 ok — whatsapp_sessions row for ${TEST_USER_ID} removed (fresh state)`);

    // ---- 2. Initialize via the exact production path ----
    let socket;
    try {
        socket = await sessionManager.initialize(TEST_USER_ID);
    } catch (error) {
        console.error('[verify] ❌ initialize() threw:', error);
        process.exit(1);
    }

    // ---- 3. Watch for the QR ----
    let gotQr = false;
    let closeMessage = null;
    socket.ev.on('connection.update', (update) => {
        if (update.qr) {
            gotQr = true;
            console.log(`[verify] ✅ qr=yes — QR received from Baileys (qr string length: ${update.qr.length})`);
        }
        if (update.connection === 'close' && !gotQr) {
            closeMessage = update.lastDisconnect?.error?.message || 'unknown';
            console.log(`[verify] connection closed before QR: ${closeMessage}`);
        }
    });

    const start = Date.now();
    while (!gotQr && Date.now() - start < QR_TIMEOUT_MS && !closeMessage) {
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // ---- 4. Cleanup: stop timers, flush nothing, delete the row ----
    await sessionManager.disconnect(TEST_USER_ID).catch(() => {});
    const { error: cleanupError } = await supabase
        .from('whatsapp_sessions')
        .delete()
        .eq('user_id', TEST_USER_ID);
    console.log(cleanupError
        ? `[verify] cleanup row delete failed: ${cleanupError.message}`
        : '[verify] cleanup ok — test row deleted again');

    if (gotQr) {
        console.log('[verify] RESULT: PASS — fresh user reached QR generation (handshake survived).');
        process.exit(0);
    }
    console.error(`[verify] RESULT: FAIL — no QR within ${QR_TIMEOUT_MS / 1000}s${closeMessage ? ` (closed: ${closeMessage})` : ''}.`);
    process.exit(1);
}

main().catch((error) => {
    console.error('[verify] unexpected failure:', error);
    process.exit(1);
});
