// =============================================================
// ONE-TIME MIGRATION — encrypt pre-existing plaintext secrets.
//
// The encryption-at-rest change makes the app encrypt secret-bearing
// app_settings values (AI_API_KEY, RESEND_API_KEY, ...) and the
// whatsapp_sessions.auth_state blob on every write, and decrypt on
// read. Legacy plaintext rows keep working (decrypt passes them
// through) — but they remain plaintext at rest until THIS script
// has been run once.
//
// What it does:
//   1. app_settings — every row whose `key` is secret-bearing
//      (SECRET_SETTING_KEYS: AI_API_KEY, RESEND_API_KEY, APP_SECRET,
//      WABA_ACCESS_TOKEN, WEBHOOK_VERIFY_TOKEN, WABA_WEBHOOK_VERIFY_TOKEN)
//      and whose value is not already encrypted gets encrypted in place.
//   2. whatsapp_sessions — every auth_state blob that is not already
//      encrypted gets encrypted in place.
//
// Idempotent: already-encrypted values are skipped, so re-running is
// a safe no-op. A row is only rewritten when its value actually changes.
//
// Usage (run from backend/):
//   ENCRYPTION_KEY=<your key> SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//     node scripts/encrypt-existing-secrets.js [--dry-run]
//
// --dry-run (default when no flag given) only REPORTS what would
// change. Pass --apply to actually write.
//
// IMPORTANT: run this with the SAME ENCRYPTION_KEY the server uses.
// Encrypted with a different key, the data becomes unreadable to the
// app (decryption fails loudly rather than returning garbage).
// =============================================================
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { supabase, isAvailable } = require('../src/database/supabaseClient');
const {
    encrypt,
    isEncrypted,
    assertEncryptionKey,
    SECRET_SETTING_KEYS,
} = require('../src/utils/encryption');

const APPLY = process.argv.includes('--apply');

async function migrateAppSettings() {
    console.log('\n── app_settings ──────────────────────────────');
    const { data, error } = await supabase
        .from('app_settings')
        .select('user_id, key, value');
    if (error) throw new Error(`Failed to read app_settings: ${error.message}`);

    const secretRows = (data || []).filter((row) => SECRET_SETTING_KEYS.has(row.key));
    console.log(`Found ${secretRows.length} secret-bearing app_settings row(s) (of ${(data || []).length} total).`);

    let migrated = 0;
    let skipped = 0;
    for (const row of secretRows) {
        const value = typeof row.value === 'string' ? row.value : String(row.value ?? '');
        if (isEncrypted(value)) {
            skipped++;
            continue; // already encrypted — leave untouched
        }
        if (!value) {
            console.log(`  · skip empty value (user ${row.user_id}, key ${row.key})`);
            skipped++;
            continue;
        }
        if (!APPLY) {
            console.log(`  ~ WOULD encrypt (user ${row.user_id}, key ${row.key})`);
            migrated++;
            continue;
        }
        const { error: updateError } = await supabase
            .from('app_settings')
            .update({ value: encrypt(value) })
            .eq('user_id', row.user_id)
            .eq('key', row.key);
        if (updateError) {
            throw new Error(`Failed to update (user ${row.user_id}, key ${row.key}): ${updateError.message}`);
        }
        console.log(`  ✔ encrypted (user ${row.user_id}, key ${row.key})`);
        migrated++;
    }
    console.log(`app_settings: ${migrated} encrypted, ${skipped} already-encrypted/empty (skipped).`);
    return migrated;
}

async function migrateWhatsappSessions() {
    console.log('\n── whatsapp_sessions ─────────────────────────');
    const { data, error } = await supabase
        .from('whatsapp_sessions')
        .select('user_id, auth_state');
    if (error) throw new Error(`Failed to read whatsapp_sessions: ${error.message}`);

    const rows = data || [];
    console.log(`Found ${rows.length} whatsapp_sessions row(s).`);

    let migrated = 0;
    let skipped = 0;
    for (const row of rows) {
        const blob = row.auth_state;
        // auth_state is a jsonb column: PostgREST hands us whatever the
        // column held — a string (plaintext JSON or ciphertext) or an
        // object (legacy JSONB row). Encrypt the serialized form of both.
        const plaintext = typeof blob === 'string'
            ? (isEncrypted(blob) ? null : blob)
            : JSON.stringify(blob);
        if (plaintext === null) {
            skipped++;
            continue; // already encrypted (or nothing to do)
        }
        if (!plaintext || plaintext === '{}' || plaintext === 'null') {
            skipped++;
            continue;
        }
        if (!APPLY) {
            console.log(`  ~ WOULD encrypt (user ${row.user_id}, ${plaintext.length} bytes)`);
            migrated++;
            continue;
        }
        const { error: updateError } = await supabase
            .from('whatsapp_sessions')
            .update({ auth_state: encrypt(plaintext) })
            .eq('user_id', row.user_id);
        if (updateError) {
            throw new Error(`Failed to update (user ${row.user_id}): ${updateError.message}`);
        }
        console.log(`  ✔ encrypted (user ${row.user_id}, ${plaintext.length} bytes)`);
        migrated++;
    }
    console.log(`whatsapp_sessions: ${migrated} encrypted, ${skipped} already-encrypted/empty (skipped).`);
    return migrated;
}

async function main() {
    console.log(`Encryption-at-rest migration — mode: ${APPLY ? 'APPLY (writes enabled)' : 'DRY RUN (no writes; pass --apply to write)'}`);
    if (!isAvailable()) {
        console.error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY (and ENCRYPTION_KEY).');
        process.exit(1);
    }
    try {
        assertEncryptionKey(); // fail loudly BEFORE touching any data
        const a = await migrateAppSettings();
        const w = await migrateWhatsappSessions();
        console.log(`\n${APPLY ? 'DONE' : 'DRY RUN complete'}: ${a + w} row(s) ${APPLY ? 'encrypted' : 'would be encrypted'}.`);
        if (!APPLY && a + w > 0) {
            console.log('Re-run with --apply to write the changes.');
        }
        process.exit(0);
    } catch (error) {
        console.error('MIGRATION FAILED:', error.message);
        process.exit(1);
    }
}

main();
