// =============================================================
// Team & access — what super admins change on the "Team & access" screen
// (routes/team.js). Accounts are found by their registered email; only
// the backend's service role can read auth.users (team_list_accounts /
// team_find_account in supabase-team-access-migration.sql).
// =============================================================
const { supabase } = require('../database/supabaseClient');
const access = require('./teamAccess');

class TeamError extends Error {
    constructor(message, statusCode = 400, code = 'TEAM_ERROR', fields) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.fields = fields;
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dbError(error, message) {
    if (['42P01', 'PGRST205', 'PGRST202', '42883', 'PGRST204', '42703'].includes(error?.code)) {
        return new TeamError('Team & access needs a database update: run supabase-team-access-migration.sql in the Supabase SQL Editor.', 503, 'TEAM_MIGRATION_PENDING');
    }
    console.error(`[team] ${message}: ${error?.code || ''} ${error?.message || error}`);
    return new TeamError(message, 500, 'TEAM_DB_ERROR');
}

/** Known areas only, each once, in the standard order. */
function cleanPermissions(list) {
    if (!Array.isArray(list)) throw new TeamError('Choose the areas this person may open.', 400, 'TEAM_INVALID', { permissions: 'Choose from the list.' });
    const unknown = list.filter((item) => !access.MODULES.includes(item));
    if (unknown.length) throw new TeamError(`Unknown area: ${unknown.join(', ')}.`, 400, 'TEAM_INVALID', { permissions: 'Choose from the list.' });
    return access.MODULES.filter((module) => list.includes(module));
}

async function listAccounts() {
    const settings = await access.teamSettings();
    const [{ data: accounts, error: accountsError }, { data: members, error: membersError }] = await Promise.all([
        supabase.rpc('team_list_accounts'),
        supabase.from('team_members').select('user_id, is_super_admin, permissions, updated_at, updated_by_email'),
    ]);
    if (accountsError) throw dbError(accountsError, 'Could not load the accounts.');
    if (membersError) throw dbError(membersError, 'Could not load team access.');
    const envAdmins = access.superAdminEmails();
    const byUser = new Map((members || []).map((row) => [row.user_id, row]));
    const rows = (accounts || []).map((account) => {
        const member = byUser.get(account.user_id);
        const envSuperAdmin = envAdmins.includes(String(account.email || '').toLowerCase());
        const superAdmin = envSuperAdmin || Boolean(member?.is_super_admin);
        return {
            user_id: account.user_id,
            email: account.email,
            created_at: account.created_at,
            last_sign_in_at: account.last_sign_in_at,
            super_admin: superAdmin,
            env_super_admin: envSuperAdmin,
            permissions: superAdmin ? [...access.MODULES] : access.MODULES.filter((module) => (member?.permissions || []).includes(module)),
            company_owner: account.user_id === settings.companyOwnerId,
            updated_at: member?.updated_at || null,
            updated_by_email: member?.updated_by_email || null,
        };
    });
    const owner = rows.find((row) => row.company_owner) || null;
    return {
        enforced: settings.enforced,
        modules: access.MODULES.map((key) => ({ key, label: access.AREA_LABELS[key] })),
        company_owner: owner ? { user_id: owner.user_id, email: owner.email } : null,
        accounts: rows,
    };
}

async function accountById(userId) {
    if (!UUID.test(String(userId || ''))) throw new TeamError('Account not found.', 404, 'TEAM_NOT_FOUND');
    const { data, error } = await supabase.rpc('team_list_accounts');
    if (error) throw dbError(error, 'Could not load the account.');
    const account = (data || []).find((row) => row.user_id === userId);
    if (!account) throw new TeamError('Account not found.', 404, 'TEAM_NOT_FOUND');
    return { id: account.user_id, email: account.email };
}

/**
 * Set one account's areas and super-admin flag (creates the row if needed).
 * An env super admin cannot be demoted; nobody can demote themselves (so a
 * super admin can never lock themselves out by accident).
 */
async function setAccess(account, { permissions, is_super_admin: superAdmin }, actor) {
    const clean = cleanPermissions(permissions ?? []);
    const envAdmin = access.superAdminEmails().includes(String(account.email || '').toLowerCase());
    const makeSuper = Boolean(superAdmin);
    if (envAdmin && !makeSuper) {
        throw new TeamError(`${account.email} is a super admin set on the server (SUPER_ADMIN_EMAILS) and cannot be changed here.`, 400, 'TEAM_ENV_SUPER_ADMIN');
    }
    if (account.id === actor.authId && !makeSuper) {
        throw new TeamError('You cannot remove your own super admin access. Ask another super admin.', 400, 'TEAM_SELF_DEMOTE');
    }
    const row = { is_super_admin: makeSuper && !envAdmin, permissions: clean, updated_at: new Date().toISOString(), updated_by_email: actor.email || null };
    const { data: existing, error: lookupError } = await supabase.from('team_members').select('user_id').eq('user_id', account.id).maybeSingle();
    if (lookupError) throw dbError(lookupError, 'Could not save team access.');
    const { error } = existing
        ? await supabase.from('team_members').update(row).eq('user_id', account.id)
        : await supabase.from('team_members').insert({ user_id: account.id, ...row });
    if (error) throw dbError(error, 'Could not save team access.');
    access.clearTeamCache();
    console.log(`[team] ${actor.email || actor.authId} set access for ${account.email}: ${makeSuper ? 'super admin' : clean.join(', ') || 'none'}`);
}

/** Give access to the account registered with `email`. */
async function addByEmail({ email, permissions, is_super_admin: superAdmin }, actor) {
    const address = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new TeamError('Enter the email this person signed up with.', 400, 'TEAM_INVALID', { email: 'Enter a valid email.' });
    let account;
    try {
        account = await access.findAccountByEmail(address);
    } catch (error) {
        throw dbError(error, 'Could not look up the email.');
    }
    if (!account) {
        throw new TeamError('No account is registered with this email yet. Ask them to sign up in the app first, then add them here.', 404, 'TEAM_NO_ACCOUNT', { email: 'No account with this email.' });
    }
    await setAccess(account, { permissions, is_super_admin: superAdmin }, actor);
    return account;
}

async function updateAccess(userId, body, actor) {
    const account = await accountById(userId);
    await setAccess(account, body, actor);
    return account;
}

/** Remove every area from an account (back to "waiting for access"). */
async function removeAccess(userId, actor) {
    const account = await accountById(userId);
    if (access.superAdminEmails().includes(String(account.email || '').toLowerCase())) {
        throw new TeamError(`${account.email} is a super admin set on the server and cannot be removed here.`, 400, 'TEAM_ENV_SUPER_ADMIN');
    }
    if (account.id === actor.authId) throw new TeamError('You cannot remove your own access.', 400, 'TEAM_SELF_DEMOTE');
    const { error } = await supabase.from('team_members').delete().eq('user_id', account.id);
    if (error) throw dbError(error, 'Could not remove access.');
    access.clearTeamCache();
    console.log(`[team] ${actor.email || actor.authId} removed all access from ${account.email}`);
    return account;
}

/** Whose data the team works on: the account registered with `email`. */
async function setCompanyOwner(email, actor) {
    let account;
    try {
        account = await access.findAccountByEmail(String(email || '').trim());
    } catch (error) {
        throw dbError(error, 'Could not look up the email.');
    }
    if (!account) throw new TeamError('No account is registered with this email.', 404, 'TEAM_NO_ACCOUNT', { email: 'No account with this email.' });
    const { error } = await supabase.from('team_settings')
        .update({ company_owner_id: account.id, updated_at: new Date().toISOString(), updated_by_email: actor.email || null })
        .eq('id', 1);
    if (error) throw dbError(error, 'Could not change the company workspace.');
    access.clearTeamCache();
    console.log(`[team] ${actor.email || actor.authId} set the company workspace to ${account.email}`);
    return account;
}

module.exports = { TeamError, listAccounts, addByEmail, updateAccess, removeAccess, setCompanyOwner, cleanPermissions };
