// =============================================================
// Supabase Server-Side Client
// Uses the SERVICE ROLE KEY — full admin access, bypasses RLS.
// NEVER expose this to the browser or frontend.
// =============================================================
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.warn(
        '[supabase] WARNING: SUPABASE_URL or SUPABASE_SECRET_KEY is not set. ' +
        'Database operations will fail until these are configured.'
    );
}

// Create the Supabase client with service role key
const supabase = (SUPABASE_URL && SUPABASE_SECRET_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
          auth: {
              persistSession: false,
              autoRefreshToken: false,
          },
          // Disable retries for predictable error handling
          retries: { count: 0 },
      })
    : null;

/**
 * Check if Supabase client is properly initialized
 */
function isAvailable() {
    return supabase !== null;
}

/**
 * Execute multiple queries in a transaction.
 * Supabase does not support traditional transactions via the JS client,
 * so we use the Postgres function approach or sequential operations with
 * manual rollback tracking.
 *
 * For simple cases, operations are sequential and we track errors.
 */
async function transaction(operations) {
    // Supabase JS client doesn't support native transactions.
    // For integrity-critical operations, consider using a Postgres function
    // or the replica role with explicit locking.
    // Here we execute sequentially and throw on first error.
    for (const op of operations) {
        const result = await op();
        if (result.error) throw result.error;
    }
}

/**
 * Helper: convert snake_case DB column names to match expected result shape.
 * Supabase returns all columns; this is mostly for consistency with existing code.
 */
function normalizeRow(row) {
    if (!row) return row;
    return row;
}

/**
 * Helper: parse JSON fields that are stored as text in Postgres
 */
function parseJsonFields(row, fields) {
    if (!row) return row;
    const result = { ...row };
    for (const field of fields) {
        if (result[field] !== null && result[field] !== undefined) {
            try {
                result[field] = JSON.parse(result[field]);
            } catch {
                // Leave as-is if parsing fails
            }
        }
    }
    return result;
}

module.exports = {
    supabase,
    isAvailable,
    transaction,
    normalizeRow,
    parseJsonFields,
};
