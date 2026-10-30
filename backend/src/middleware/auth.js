// NOTE: env vars are loaded once by src/server.js from backend/.env —
// do not add a dotenv.config() here.
const { createClient } = require('@supabase/supabase-js');
const { resolveDataOwner, DataAccessError, DATA_OWNER_HEADER } = require('../security/dataOwner');
const { loadAccess, dataOwnerFor } = require('../security/teamAccess');

// ─── Supabase server-side client ──────────────────────────────────────────────
// Uses the SECRET key — never exposed to the browser.
// Only initialised once at startup; safe to reuse across requests.
const SUPABASE_URL        = process.env.SUPABASE_URL        || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.warn(
        '[auth] WARNING: SUPABASE_URL or SUPABASE_SECRET_KEY is not set. ' +
        'All authenticated API routes will return 503 until these are configured.'
    );
}

const supabaseAdmin = (SUPABASE_URL && SUPABASE_SECRET_KEY)
    ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

// ─── AUTH_DISABLED bypass ─────────────────────────────────────────────────────
// Keep the escape hatch for local development / demos, but emit a loud warning.
// Do NOT set AUTH_DISABLED=true in production.
const AUTH_DISABLED = process.env.AUTH_DISABLED === 'true';
if (AUTH_DISABLED) {
    console.warn(
        '[auth] WARNING: AUTH_DISABLED=true — all API routes are unprotected. ' +
        'This must NOT be used in production.'
    );
}

/**
 * Express middleware — validates the Supabase JWT from the Authorization header.
 *
 * Flow:
 *   1. Extract Bearer token from "Authorization: Bearer <token>"
 *   2. Call supabase.auth.getClaims(token) — verifies the JWT LOCALLY against
 *      the cached JWKS when the project uses asymmetric signing keys (no
 *      network round trip), and automatically falls back to the auth server
 *      for legacy HS256 projects. This keeps the auth server out of the hot
 *      path: the dashboard fires several authenticated calls on load (status,
 *      dashboard analytics, conversations, onboarding) plus 10s polls, and
 *      each one previously paid a full getUser() round trip to Supabase.
 *   3. Attach req.user = { id, email, role } from the verified claims
 *   4. Call next()
 *
 * On failure: respond with 401 JSON and do not call next().
 *
 * Trade-off (documented by Supabase): local verification trusts tokens until
 * they expire (~1h default); immediate session revocation is only enforced by
 * the auth server. Sign-out still clears the client token, so this matches
 * Supabase's recommended backend setup.
 */
async function requireAuth(req, res, next) {
    // Development bypass — never allow in production
    if (AUTH_DISABLED) {
        req.user = { id: 'dev-bypass', email: 'dev@local', role: 'authenticated' };
        return next();
    }

    if (!supabaseAdmin) {
        return res.status(503).json({
            error: 'Authentication service is not configured. ' +
                   'Set SUPABASE_URL and SUPABASE_SECRET_KEY on the server.',
        });
    }

    // Extract token
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required. Please sign in.' });
    }
    const token = header.slice(7).trim();

    // Validate locally (asymmetric keys) or via the auth server (legacy HS256)
    try {
        const { data, error } = await supabaseAdmin.auth.getClaims(token);
        const claims = data?.claims;
        if (error || !claims?.sub) {
            return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
        }
        // Shared workspaces: req.user.id is the user whose DATA this request
        // acts on — the signed-in user, or an owner who shared their data
        // with them (verified in the database, never trusted from the
        // header). req.user.authId is always the signed-in user.
        //
        // Team & access (security/teamAccess.js), once enabled, replaces
        // that choice: everyone with access works on the company workspace
        // and the X-Data-Owner header is ignored. req.access says which
        // areas the account may open (routes check it with requireModule).
        let access;
        try {
            access = await loadAccess(claims.sub, claims.email);
        } catch (accessError) {
            console.error('[auth] team access check failed:', accessError.message);
            return res.status(503).json({ error: 'Could not check your access. Please try again.', code: 'ACCESS_CHECK_FAILED' });
        }
        let dataOwnerId = claims.sub;
        if (access.enforced) {
            dataOwnerId = dataOwnerFor(access, claims.sub);
        } else {
            try {
                const requestedOwner = (typeof req.get === 'function' ? req.get(DATA_OWNER_HEADER) : req.headers?.[DATA_OWNER_HEADER]) || null;
                dataOwnerId = await resolveDataOwner(claims.sub, requestedOwner ? String(requestedOwner).trim() : null);
            } catch (accessError) {
                if (accessError instanceof DataAccessError) {
                    return res.status(accessError.statusCode).json({ error: accessError.message, code: accessError.code });
                }
                throw accessError;
            }
        }
        // Attach a clean user object — never trust IDs supplied in request bodies.
        // Claims carry the same identity fields the /user endpoint returned.
        req.user = {
            id:     dataOwnerId,
            authId: claims.sub,
            email:  claims.email,
            role:   claims.role,
            sharedAccess: dataOwnerId !== claims.sub,
        };
        req.access = access;
        next();
    } catch (err) {
        console.error('[auth] Token validation error:', err.message);
        return res.status(401).json({ error: 'Authentication failed. Please sign in again.' });
    }
}

/**
 * Owner-only routes: account credentials and connections (AI/email keys,
 * WhatsApp linking, Business API tokens) are never managed through a
 * shared workspace, even though shared users can work with the data.
 */
function requireDataOwnerSelf(req, res, next) {
    if (req.user?.sharedAccess) {
        return res.status(403).json({
            error: 'Only the account owner can change settings or the WhatsApp connection of this workspace.',
            code: 'OWNER_ONLY',
        });
    }
    next();
}

module.exports = { requireAuth, requireDataOwnerSelf, supabaseAdmin };
