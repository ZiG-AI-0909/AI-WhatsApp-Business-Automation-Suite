// =============================================================
// Team & access — what each signed-in account may open, and whose data it
// works on (supabase-team-access-migration.sql).
//
//   * Areas (MODULES): every API route group requires one (requireModule).
//   * Super admins: the emails in SUPER_ADMIN_EMAILS (never demotable) plus
//     accounts promoted on the "Team & access" screen. They have every area.
//   * One company workspace: team members act on the data of
//     team_settings.company_owner_id (default: the first SUPER_ADMIN_EMAILS
//     account), through the same req.user.id the shared-workspace code
//     uses; req.user.sharedAccess keeps WhatsApp linking and API keys with
//     that owner (middleware/auth.requireDataOwnerSelf).
//   * An account with no team_members row has no access.
//
// ENFORCED only when the migration has run AND SUPER_ADMIN_EMAILS is set.
// Otherwise everything behaves as before: every account has every area
// except vendor KYC / technicians / storage, which stay with the KYC staff
// list (private.kyc_staff).
// =============================================================
const { supabase, isAvailable } = require('../database/supabaseClient');

const MODULES = ['whatsapp', 'documents', 'proforma', 'ask_ai', 'vendor_kyc', 'technicians', 'storage', 'settings'];
const KYC_STAFF_MODULES = new Set(['vendor_kyc', 'technicians', 'storage']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Changes made on the screen apply at once (the cache is cleared); this
// only bounds how long another server instance may use an older answer.
const CACHE_MS = Number(process.env.TEAM_ACCESS_CACHE_MS || 30_000);

const memberCache = new Map(); // authUserId → { at, row }
let settingsCache = null; // { at, enforced, companyOwnerId }

const isMissingSchema = (error) => ['42P01', 'PGRST205', 'PGRST202', '42883', 'PGRST204', '42703'].includes(error?.code);

/** Lower-case emails from SUPER_ADMIN_EMAILS (comma / space separated). */
function superAdminEmails() {
    return String(process.env.SUPER_ADMIN_EMAILS || '')
        .split(/[\s,;]+/)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.includes('@'));
}

function clearTeamCache() {
    memberCache.clear();
    settingsCache = null;
}

async function findAccountByEmail(email) {
    const { data, error } = await supabase.rpc('team_find_account', { p_email: String(email || '') });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row?.user_id ? { id: row.user_id, email: row.email } : null;
}

/** { enforced, companyOwnerId } — whether team access is on, and whose data the team uses. */
async function teamSettings({ now = Date.now } = {}) {
    if (settingsCache && now() - settingsCache.at < CACHE_MS) return settingsCache;
    const result = { at: now(), enforced: false, companyOwnerId: null };
    const envAdmins = superAdminEmails();
    if (envAdmins.length && isAvailable() && supabase) {
        const { data, error } = await supabase.from('team_settings').select('company_owner_id').eq('id', 1).maybeSingle();
        if (error) {
            if (!isMissingSchema(error)) throw error;
        } else {
            result.enforced = true;
            result.companyOwnerId = data?.company_owner_id || null;
            if (!result.companyOwnerId) {
                // Default company workspace: the first env super admin's account.
                for (const email of envAdmins) {
                    const account = await findAccountByEmail(email).catch(() => null);
                    if (account) { result.companyOwnerId = account.id; break; }
                }
            }
        }
    }
    settingsCache = result;
    return result;
}

async function memberRow(authUserId, { now = Date.now } = {}) {
    const cached = memberCache.get(authUserId);
    if (cached && now() - cached.at < CACHE_MS) return cached.row;
    const { data, error } = await supabase.from('team_members').select('user_id, is_super_admin, permissions').eq('user_id', authUserId).maybeSingle();
    if (error) throw error;
    memberCache.set(authUserId, { at: now(), row: data || null });
    return data || null;
}

/**
 * What this signed-in account may do.
 * @returns {Promise<{ enforced: boolean, superAdmin: boolean, envSuperAdmin: boolean,
 *   permissions: string[], companyOwnerId: string|null }>}
 */
async function loadAccess(authUserId, email) {
    const settings = await teamSettings();
    if (!settings.enforced) {
        return { enforced: false, superAdmin: false, envSuperAdmin: false, permissions: MODULES.filter((module) => !KYC_STAFF_MODULES.has(module)), companyOwnerId: null };
    }
    const envSuperAdmin = superAdminEmails().includes(String(email || '').toLowerCase());
    const row = UUID.test(String(authUserId || '')) ? await memberRow(authUserId) : null;
    const superAdmin = envSuperAdmin || Boolean(row?.is_super_admin);
    const permissions = superAdmin ? [...MODULES] : MODULES.filter((module) => (row?.permissions || []).includes(module));
    return { enforced: true, superAdmin, envSuperAdmin, permissions, companyOwnerId: settings.companyOwnerId };
}

/**
 * Whose data a request acts on when team access is on: the company
 * workspace for anyone with access; their own (empty) data otherwise.
 */
function dataOwnerFor(access, authUserId) {
    if (!access?.enforced || !access.companyOwnerId) return authUserId;
    return access.superAdmin || access.permissions.length ? access.companyOwnerId : authUserId;
}

/** May this request use `module`? (Legacy mode: KYC areas follow private.kyc_staff.) */
async function hasModule(req, module) {
    const access = req.access;
    if (access?.enforced) return access.permissions.includes(module);
    if (KYC_STAFF_MODULES.has(module)) {
        const { isKycStaff } = require('../kyc/kycService');
        return isKycStaff(req.user?.authId); // may throw KYC_MIGRATION_PENDING (503)
    }
    return true;
}

const AREA_LABELS = {
    whatsapp: 'WhatsApp', documents: 'Documents', proforma: 'Proforma', ask_ai: 'Ask AI',
    vendor_kyc: 'Vendor KYC forms', technicians: 'Technician registrations', storage: 'Storage', settings: 'Settings',
};

/** Express middleware (after requireAuth): 403 unless the account may use one of `modules`. */
function requireModule(...modules) {
    return async (req, res, next) => {
        try {
            for (const module of modules) if (await hasModule(req, module)) return next();
            return res.status(403).json({
                error: `You do not have access to ${AREA_LABELS[modules[0]] || modules[0]}. Ask a super admin to give you access.`,
                code: 'NO_ACCESS',
                area: modules[0],
            });
        } catch (error) {
            // e.g. KYC_MIGRATION_PENDING: pass the setup message through.
            if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, code: error.code });
            console.error('[team] access check failed:', error.message);
            return res.status(503).json({ error: 'Could not check your access. Please try again.', code: 'ACCESS_CHECK_FAILED' });
        }
    };
}

/** Only for paths matching `pattern` (for routers mounted on a shared prefix). */
function onlyFor(pattern, middleware) {
    return (req, res, next) => (pattern.test(req.path) ? middleware(req, res, next) : next());
}

function requireSuperAdmin(req, res, next) {
    if (req.access?.enforced && req.access.superAdmin) return next();
    return res.status(403).json({ error: 'Only a super admin can manage team access.', code: 'SUPER_ADMIN_ONLY' });
}

module.exports = {
    MODULES,
    AREA_LABELS,
    superAdminEmails,
    clearTeamCache,
    findAccountByEmail,
    teamSettings,
    loadAccess,
    dataOwnerFor,
    hasModule,
    requireModule,
    onlyFor,
    requireSuperAdmin,
};
