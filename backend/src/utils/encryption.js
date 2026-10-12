// =============================================================
// Encryption at rest — AES-256-GCM for secrets stored in Supabase.
//
// Encrypts tenant secrets (AI/Resend API keys, WhatsApp tokens, the
// Baileys auth state) before they reach the database and decrypts on
// read. ENCRYPTION_KEY comes from the environment; the server REFUSES
// to start without it (assertEncryptionKey in server.js) and encrypt()
// refuses to run without it — we never silently store plaintext.
//
// Ciphertext format (versioned for future key rotation):
//   v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>
//
// decrypt() tolerates legacy plaintext (returns it unchanged) so reads
// keep working during the transition window, before the one-time
// migration script (scripts/encrypt-existing-secrets.js) has run.
// =============================================================
const crypto = require('crypto');

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const PREFIX = 'v1:';

// app_settings keys whose values must never touch the database as
// plaintext. WABA_* / APP_SECRET are currently env-only but covered
// defensively in case they are ever persisted per-user.
const SECRET_SETTING_KEYS = new Set([
    'AI_API_KEY',
    'RESEND_API_KEY',
    'WABA_ACCESS_TOKEN',
    'APP_SECRET',
    'WEBHOOK_VERIFY_TOKEN',
    'WABA_WEBHOOK_VERIFY_TOKEN',
]);

let cachedKey = null;

function assertEncryptionKey() {
    if (!process.env.ENCRYPTION_KEY) {
        throw new Error(
            '[encryption] ENCRYPTION_KEY is not set. Refusing to run: secrets would be stored as plaintext. ' +
            'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
            'and set it in the environment (Render env vars / local .env) before starting the server.',
        );
    }
}

function getEncryptionKey() {
    if (cachedKey) return cachedKey;
    assertEncryptionKey();
    const raw = process.env.ENCRYPTION_KEY.trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        cachedKey = Buffer.from(raw, 'hex');
    } else {
        // Passphrase-style key: derive 32 bytes deterministically.
        cachedKey = crypto.scryptSync(raw, 'sudarshan-saas-encryption-v1', 32);
    }
    return cachedKey;
}

/**
 * Encrypt plaintext. Empty values pass through unchanged.
 * @param {string} plaintext
 * @returns {string} versioned ciphertext string
 */
function encrypt(plaintext) {
    if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext ?? '';
    assertEncryptionKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(CIPHER, getEncryptionKey(), iv);
    const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * Decrypt a value produced by encrypt(). Legacy plaintext values are
 * returned unchanged so pre-migration rows remain readable.
 * @param {string} value
 * @returns {string} decrypted plaintext
 */
function decrypt(value) {
    if (typeof value !== 'string' || !isEncrypted(value)) return value;
    try {
        const [ivB64, tagB64, dataB64] = value.slice(PREFIX.length).split(':');
        const decipher = crypto.createDecipheriv(CIPHER, getEncryptionKey(), Buffer.from(ivB64, 'base64'));
        decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
    } catch (error) {
        throw new Error(
            '[encryption] Decryption failed — the stored value was encrypted with a different ENCRYPTION_KEY ' +
            'or the ciphertext was corrupted. Do not change ENCRYPTION_KEY once set. (' + error.message + ')',
        );
    }
}

/** True if the value carries our versioned ciphertext prefix. */
function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX) && value.split(':').length === 4;
}

/** Encrypt an app_settings value if its key is secret-bearing. */
function encryptSettingIfSecret(key, value) {
    return SECRET_SETTING_KEYS.has(key) ? encrypt(value) : value;
}

/** Decrypt an app_settings value if its key is secret-bearing (legacy passthrough). */
function decryptSettingIfSecret(key, value) {
    return SECRET_SETTING_KEYS.has(key) ? decrypt(value) : value;
}

module.exports = {
    encrypt,
    decrypt,
    isEncrypted,
    assertEncryptionKey,
    SECRET_SETTING_KEYS,
    encryptSettingIfSecret,
    decryptSettingIfSecret,
};
