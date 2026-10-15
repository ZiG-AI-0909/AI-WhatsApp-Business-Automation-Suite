// =============================================================
// Shared data access — which user's data a request may act on.
//
// Every service in this backend scopes queries to one user_id with the
// service-role client (RLS does not apply). Sharing therefore works by
// choosing that user_id per request: normally the signed-in user, or a
// data owner who shared their data with them (private.user_data_shares).
//
// The client may only ASK for a workspace (X-Data-Owner header / socket
// auth field). The answer always comes from the database function
// public.resolve_data_owner, executable by the service role only, so a
// user cannot grant themselves access by editing requests.
// =============================================================
const { supabase, isAvailable } = require('../database/supabaseClient');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Revoking a share takes effect within this window.
const CACHE_TTL_MS = Number(process.env.DATA_SHARE_CACHE_MS || 60_000);
const cache = new Map();

class DataAccessError extends Error {
    constructor(message, statusCode, code) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

function isUuid(value) {
    return typeof value === 'string' && UUID.test(value);
}

function isMissingFunction(error) {
    return ['PGRST202', '42883'].includes(error?.code);
}

/**
 * Resolve the user_id a request may act on.
 * @returns {Promise<string>} authUserId or the authorised owner id
 * @throws {DataAccessError} 403 when not shared, 503 when the migration is missing
 */
async function resolveDataOwner(authUserId, requestedOwnerId, { now = Date.now } = {}) {
    if (!requestedOwnerId || requestedOwnerId === authUserId) return authUserId;
    if (!isUuid(requestedOwnerId) || !isUuid(authUserId)) {
        throw new DataAccessError('You do not have access to this workspace.', 403, 'WORKSPACE_FORBIDDEN');
    }
    const key = `${authUserId}:${requestedOwnerId}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < CACHE_TTL_MS) {
        if (!cached.allowed) throw new DataAccessError('You do not have access to this workspace.', 403, 'WORKSPACE_FORBIDDEN');
        return requestedOwnerId;
    }
    if (!isAvailable()) throw new DataAccessError('Shared workspaces are unavailable: the database is not configured.', 503, 'WORKSPACE_UNAVAILABLE');

    const { data, error } = await supabase.rpc('resolve_data_owner', {
        p_auth_user_id: authUserId,
        p_requested_owner_id: requestedOwnerId,
    });
    if (error) {
        if (isMissingFunction(error)) {
            throw new DataAccessError('Shared workspaces need a database update: run supabase-shared-access-migration.sql in the Supabase SQL Editor.', 503, 'WORKSPACE_MIGRATION_PENDING');
        }
        throw new DataAccessError('Could not verify workspace access. Please try again.', 503, 'WORKSPACE_UNAVAILABLE');
    }
    const allowed = data === requestedOwnerId;
    cache.set(key, { allowed, at: now() });
    if (!allowed) throw new DataAccessError('You do not have access to this workspace.', 403, 'WORKSPACE_FORBIDDEN');
    return requestedOwnerId;
}

/** Workspaces shared with this user: [{ ownerUserId, ownerEmail, sharedAt }]. */
async function listDataOwners(authUserId) {
    if (!isUuid(authUserId) || !isAvailable()) return [];
    const { data, error } = await supabase.rpc('list_data_owners', { p_auth_user_id: authUserId });
    if (error) {
        if (isMissingFunction(error)) return [];
        throw error;
    }
    return (Array.isArray(data) ? data : []).map(row => ({
        ownerUserId: row.owner_user_id,
        ownerEmail: row.owner_email || '',
        sharedAt: row.shared_at || null,
    }));
}

function clearDataOwnerCache() {
    cache.clear();
}

module.exports = {
    DataAccessError,
    resolveDataOwner,
    listDataOwners,
    clearDataOwnerCache,
    isUuid,
    DATA_OWNER_HEADER: 'x-data-owner',
};
