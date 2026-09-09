// =============================================================
// Supabase-backed Baileys auth state — per-user replacement for
// useMultiFileAuthState. Stores the full auth state (creds +
// all keys) as a single JSONB doc in the whatsapp_sessions table,
// keyed by user_id.
//
// SECURITY: every read/write is scoped to the exact userId given.
// There is no global state here; a session can never touch
// another user's row.
//
// Buffer serialization: Baileys stores keys as Buffers. JSON has
// no Buffer type, so values are stored as { "$b": "<base64>" }
// and revived with Buffers.from(base64) on read — matching what
// Baileys expects (it only ever uses them as key material).
//
// Debouncing: Baileys fires creds.update very frequently (every
// pre-key rotation). Writes are coalesced: the latest state is
// kept in memory and flushed to Supabase after a short delay, so
// bursts become one write. Flushes are also forced before
// process exit and exposed for explicit await on logout.
// =============================================================
const { supabase, isAvailable } = require('../database/supabaseClient');

const TABLE = 'whatsapp_sessions';
const DEBOUNCE_MS = Number(process.env.WHATSAPP_AUTH_STATE_DEBOUNCE_MS || 5000);

// ---- Buffer <-> JSON helpers --------------------------------

const BUFFER_MARKER = '$b';

function serializeValue(value) {
    if (value === null || value === undefined) return value;
    if (Buffer.isBuffer(value)) return { [BUFFER_MARKER]: value.toString('base64') };
    if (value instanceof Uint8Array) return { [BUFFER_MARKER]: Buffer.from(value).toString('base64') };
    if (Array.isArray(value)) return value.map(serializeValue);
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
        return out;
    }
    return value;
}

function reviveValue(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(reviveValue);
    if (typeof value === 'object') {
        const marker = value[BUFFER_MARKER];
        if (typeof marker === 'string') return Buffer.from(marker, 'base64');
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = reviveValue(v);
        return out;
    }
    return value;
}

function serializeAuthState(state) {
    return JSON.stringify(serializeValue(state));
}

function reviveAuthState(json) {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    return reviveValue(parsed);
}

// ---- Auth state provider -------------------------------------

/**
 * Build a Baileys auth state (same contract as
 * useMultiFileAuthState) backed by the whatsapp_sessions table.
 * @param {string} userId - owner of this auth state (required)
 */
async function useSupabaseAuthState(userId) {
    if (!userId) throw new Error('[authState] userId is required');
    if (!isAvailable()) {
        throw new Error('[authState] Supabase is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY.');
    }

    let inMemory = null;      // latest state object (same reference Baileys mutates)
    let pendingFlush = null;  // timer for the debounced write
    let writing = false;
    let writeQueued = false;

    // Initial read — only this user's row.
    const { data, error } = await supabase
        .from(TABLE)
        .select('auth_state')
        .eq('user_id', userId)
        .maybeSingle();
    if (error) throw new Error(`[authState] Failed to load auth state: ${error.message}`);

    if (data?.auth_state) {
        inMemory = reviveAuthState(data.auth_state);
    } else {
        // Same shape useMultiFileAuthState starts with.
        inMemory = { creds: {}, keys: {} };
    }

    async function writeState() {
        if (writing) { writeQueued = true; return; }
        writing = true;
        try {
            const payload = serializeAuthState(inMemory);
            const { error: upsertError } = await supabase
                .from(TABLE)
                .upsert({
                    user_id: userId,
                    auth_state: payload, // jsonb column accepts the object directly
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'user_id' });
            if (upsertError) throw new Error(`[authState] Failed to persist auth state: ${upsertError.message}`);
        } finally {
            writing = false;
            if (writeQueued) { writeQueued = false; writeState().catch(() => {}); }
        }
    }

    function scheduleFlush() {
        if (pendingFlush) clearTimeout(pendingFlush);
        pendingFlush = setTimeout(() => {
            pendingFlush = null;
            writeState().catch((err) => console.error(`[authState:${userId}] flush failed:`, err.message));
        }, DEBOUNCE_MS);
    }

    const flush = async () => {
        if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = null; }
        await writeState();
    };

    const destroy = () => {
        if (pendingFlush) { clearTimeout(pendingFlush); pendingFlush = null; }
    };

    return {
        state: inMemory,
        saveCreds: () => { scheduleFlush(); }, // debounced; use flush() to force
        flush,
        destroy,
    };
}

/** Delete a user's stored auth state (explicit sign-out). */
async function deleteAuthState(userId) {
    if (!userId) throw new Error('[authState] userId is required');
    if (!isAvailable()) throw new Error('[authState] Supabase is not configured.');
    const { error } = await supabase.from(TABLE).delete().eq('user_id', userId);
    if (error) throw new Error(`[authState] Failed to delete auth state: ${error.message}`);
}

/** Check whether a user has persisted auth state (i.e. linked a number before). */
async function hasAuthState(userId) {
    if (!userId) return false;
    if (!isAvailable()) return false;
    const { data, error } = await supabase
        .from(TABLE)
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle();
    if (error) return false;
    return !!data;
}

module.exports = {
    useSupabaseAuthState,
    deleteAuthState,
    hasAuthState,
    serializeAuthState,
    reviveAuthState,
    serializeValue,
    reviveValue,
    BUFFER_MARKER,
    TABLE,
    DEBOUNCE_MS,
};
