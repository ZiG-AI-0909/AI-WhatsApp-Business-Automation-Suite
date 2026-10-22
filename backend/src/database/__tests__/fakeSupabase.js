// =============================================================
// In-memory stand-in for the Supabase service-role client (tests only).
//
// Evaluates the PostgREST builder calls that db.js and the services make
// (eq/neq/gt/gte/lt/lte, like/ilike, in, is/not, or(), order, range,
// limit, single/maybeSingle, count/head and one-level embeds such as
// "*, contacts(phone)"), so tests run the real query code end to end.
// RPCs are supplied per test; unknown RPCs answer like a missing function.
// =============================================================

function same(a, b) {
    return String(a instanceof Date ? a.toISOString() : a) === String(b instanceof Date ? b.toISOString() : b);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function comparable(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string' && ISO_DATE.test(value)) return Date.parse(value);
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return value;
}

function compare(a, b) {
    const x = comparable(a);
    const y = comparable(b);
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x ?? '') < String(y ?? '') ? -1 : String(x ?? '') > String(y ?? '') ? 1 : 0;
}

function likeToRegex(pattern, flags = '') {
    const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*');
    return new RegExp(`^${escaped}$`, flags);
}

function parseInList(value) {
    if (Array.isArray(value)) return value;
    return String(value).replace(/^\(|\)$/g, '').split(',').map(item => item.replace(/^"|"$/g, ''));
}

function orPredicate(expression) {
    const parts = expression.split(/,(?![^()]*\))/);
    const tests = parts.map((part) => {
        const [column, op, ...rest] = part.split('.');
        const isNot = op === 'not';
        const realOp = isNot ? rest.shift() : op;
        const value = rest.join('.').replace(/^"|"$/g, '');
        let test;
        switch (realOp) {
            case 'eq': test = row => same(row[column], value); break;
            case 'neq': test = row => !same(row[column], value); break;
            case 'gt': test = row => row[column] != null && compare(row[column], value) > 0; break;
            case 'gte': test = row => row[column] != null && compare(row[column], value) >= 0; break;
            case 'lt': test = row => row[column] != null && compare(row[column], value) < 0; break;
            case 'lte': test = row => row[column] != null && compare(row[column], value) <= 0; break;
            case 'like': test = row => likeToRegex(value).test(String(row[column] ?? '')); break;
            case 'ilike': test = row => likeToRegex(value, 'i').test(String(row[column] ?? '')); break;
            case 'in': test = row => parseInList(value).some(item => same(row[column], item)); break;
            case 'is': test = row => row[column] == null; break;
            default: throw new Error(`fake supabase: unsupported or() operator ${realOp}`);
        }
        return isNot ? row => !test(row) : test;
    });
    return row => tests.some(test => test(row));
}

function singular(table) {
    return table.replace(/s$/, '');
}

function createFakeSupabase({ rpc = {} } = {}) {
    const store = {};
    let nextId = 10_000;

    function from(table) {
        store[table] ||= [];
        const state = { op: 'select', columns: '*', filters: [], order: [], limit: null, range: null, single: null, count: false, head: false, payload: null, embeds: {} };
        const embed = name => (state.embeds[name] ||= {});
        const b = {
            select(columns = '*', options = {}) {
                if (state.op === 'select') state.columns = columns;
                if (options.count) state.count = true;
                if (options.head) state.head = true;
                return b;
            },
            insert(rows) { state.op = 'insert'; state.payload = rows; return b; },
            update(data) { state.op = 'update'; state.payload = data; return b; },
            delete() { state.op = 'delete'; return b; },
            eq(column, value) { state.filters.push(row => same(row[column], value)); return b; },
            neq(column, value) { state.filters.push(row => !same(row[column], value)); return b; },
            gt(column, value) { state.filters.push(row => row[column] != null && compare(row[column], value) > 0); return b; },
            gte(column, value) { state.filters.push(row => row[column] != null && compare(row[column], value) >= 0); return b; },
            lt(column, value) { state.filters.push(row => row[column] != null && compare(row[column], value) < 0); return b; },
            lte(column, value) { state.filters.push(row => row[column] != null && compare(row[column], value) <= 0); return b; },
            like(column, value) { state.filters.push(row => likeToRegex(value).test(String(row[column] ?? ''))); return b; },
            ilike(column, value) { state.filters.push(row => likeToRegex(value, 'i').test(String(row[column] ?? ''))); return b; },
            in(column, values) { state.filters.push(row => parseInList(values).some(value => same(row[column], value))); return b; },
            is(column, value) { state.filters.push(row => (value === null ? row[column] == null : row[column] === value)); return b; },
            not(column, op, value) {
                if (op === 'in') {
                    state.filters.push(row => !parseInList(value).some(item => same(row[column], item)));
                    return b;
                }
                if (op !== 'is' || value !== null) throw new Error('fake supabase: unsupported not()');
                state.filters.push(row => row[column] != null);
                return b;
            },
            or(expression) { state.filters.push(orPredicate(expression)); return b; },
            order(column, { ascending = true, referencedTable } = {}) {
                if (referencedTable) embed(referencedTable).order = [column, ascending];
                else state.order.push([column, ascending]);
                return b;
            },
            limit(count, { referencedTable } = {}) {
                if (referencedTable) embed(referencedTable).limit = count;
                else state.limit = count;
                return b;
            },
            range(fromIndex, toIndex, { referencedTable } = {}) {
                if (referencedTable) embed(referencedTable).range = [fromIndex, toIndex];
                else state.range = [fromIndex, toIndex];
                return b;
            },
            single() { state.single = 'single'; return b; },
            maybeSingle() { state.single = 'maybe'; return b; },
            then(resolve, reject) { return Promise.resolve().then(execute).then(resolve, reject); },
        };

        function attachEmbeds(row) {
            const out = { ...row };
            for (const match of String(state.columns).matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
                const related = match[1];
                store[related] ||= [];
                const fk = `${singular(related)}_id`;
                if (fk in row) {
                    out[related] = store[related].find(candidate => same(candidate.id, row[fk])) || null;
                } else {
                    let children = store[related].filter(candidate => same(candidate[`${singular(table)}_id`], row.id));
                    const options = state.embeds[related] || {};
                    if (options.order) children = [...children].sort((x, y) => compare(x[options.order[0]], y[options.order[0]]) * (options.order[1] ? 1 : -1));
                    if (options.limit != null) children = children.slice(0, options.limit);
                    out[related] = children;
                }
            }
            return out;
        }

        function execute() {
            const rows = store[table];
            const matches = rows.filter(row => state.filters.every(test => test(row)));
            let data;
            if (state.op === 'insert') {
                const input = Array.isArray(state.payload) ? state.payload : [state.payload];
                const inserted = input.map(row => ({ created_at: new Date().toISOString(), ...row, id: row.id ?? nextId++ }));
                rows.push(...inserted);
                data = inserted.map(row => ({ ...row }));
            } else if (state.op === 'update') {
                for (const row of matches) Object.assign(row, state.payload);
                data = matches.map(row => ({ ...row }));
            } else if (state.op === 'delete') {
                store[table] = rows.filter(row => !matches.includes(row));
                data = matches;
            } else {
                let selected = [...matches];
                for (const [column, ascending] of [...state.order].reverse()) {
                    selected.sort((x, y) => compare(x[column], y[column]) * (ascending ? 1 : -1));
                }
                const count = selected.length;
                if (state.range) selected = selected.slice(state.range[0], state.range[1] + 1);
                if (state.limit != null) selected = selected.slice(0, state.limit);
                if (state.head) return { data: null, count, error: null };
                data = selected.map(attachEmbeds);
                if (state.count) return finish(data, count);
            }
            return finish(data);
        }

        function finish(data, count = null) {
            if (state.single) {
                const list = Array.isArray(data) ? data : [data];
                if (list.length === 1) return { data: list[0], count, error: null };
                if (list.length === 0 && state.single === 'maybe') return { data: null, count, error: null };
                return { data: null, count, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
            }
            return { data, count, error: null };
        }

        return b;
    }

    async function callRpc(name, params = {}) {
        if (rpc[name]) return rpc[name](params, store);
        return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
    }

    return { store, from, rpc: callRpc, rpcs: rpc };
}

/** RPCs from the campaign migrations, implemented over the fake store. */
const campaignRpcs = {
    recount_campaign_counters({ p_campaign_id: campaignId, p_user_id: userId }, store) {
        const rows = (store.campaign_contacts || []).filter(row => same(row.campaign_id, campaignId) && same(row.user_id, userId));
        const count = status => rows.filter(row => row.status === status).length;
        const totals = { sent: count('sent'), failed: count('failed'), opt_outs: count('opted_out'), skipped: count('skipped') };
        totals.processed = totals.sent + totals.failed + totals.opt_outs + totals.skipped;
        const campaign = (store.campaigns || []).find(row => same(row.id, campaignId) && same(row.user_id, userId));
        if (!campaign) return { data: [], error: null };
        Object.assign(campaign, totals, { updated_at: new Date().toISOString() });
        return { data: [totals], error: null };
    },
    recount_campaign_delivery({ p_campaign_id: campaignId, p_user_id: userId }, store) {
        const rows = (store.campaign_contacts || []).filter(row => same(row.campaign_id, campaignId) && same(row.user_id, userId));
        const totals = {
            delivered: rows.filter(row => ['delivered', 'read'].includes(row.delivery_status)).length,
            read_count: rows.filter(row => row.delivery_status === 'read').length,
        };
        const campaign = (store.campaigns || []).find(row => same(row.id, campaignId) && same(row.user_id, userId));
        if (campaign) Object.assign(campaign, totals);
        return { data: [totals], error: null };
    },
    claim_campaign_to_run({ p_user_id: userId, p_campaign_id: campaignId, p_expected_status: expected }, store) {
        const campaigns = store.campaigns || [];
        if (campaigns.some(row => same(row.user_id, userId) && row.status === 'running')) return { data: [], error: null };
        const candidate = campaigns.find(row => same(row.id, campaignId) && same(row.user_id, userId)
            && ['draft', 'stopped', 'paused', 'queued'].includes(row.status)
            && (!expected || row.status === expected));
        if (!candidate) return { data: [], error: null };
        Object.assign(candidate, { status: 'running', pause_reason: null, last_error: null, completed_at: null, queue_position: null });
        return { data: [{ ...candidate }], error: null };
    },
};

/** Point the shared service-role client at the fake (db.js keeps its reference). */
function installFakeSupabase(fake) {
    const { supabase } = require('../supabaseClient');
    if (!supabase) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY before installing the fake.');
    supabase.from = fake.from;
    supabase.rpc = fake.rpc;
    return supabase;
}

module.exports = { createFakeSupabase, installFakeSupabase, campaignRpcs };
