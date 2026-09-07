require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

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
 *   2. Call supabase.auth.getUser(token) — validates against Supabase's JWKS
 *   3. Attach req.user = { id, email, ...metadata } for downstream route handlers
 *   4. Call next()
 *
 * On failure: respond with 401 JSON and do not call next().
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

    // Validate with Supabase
    try {
        const { data, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !data?.user) {
            return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
        }
        // Attach a clean user object — never trust IDs supplied in request bodies
        req.user = {
            id:    data.user.id,
            email: data.user.email,
            role:  data.user.role,
        };
        next();
    } catch (err) {
        console.error('[auth] Token validation error:', err.message);
        return res.status(401).json({ error: 'Authentication failed. Please sign in again.' });
    }
}

module.exports = { requireAuth };
