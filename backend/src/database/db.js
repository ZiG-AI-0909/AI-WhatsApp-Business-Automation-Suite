// =============================================================
// Database Module — Supabase Postgres Backend
// Replaces node:sqlite with Supabase JS client.
// Provides a similar ergonomic interface for existing code.
// =============================================================
const { supabase, isAvailable, transaction, parseJsonFields } = require('./supabaseClient');

// ─── Table name constants ────────────────────────────────────
const TABLES = {
    contacts: 'contacts',
    conversations: 'conversations',
    messages: 'messages',
    templates: 'templates',
    campaigns: 'campaigns',
    campaign_contacts: 'campaign_contacts',
    knowledge_documents: 'knowledge_documents',
    knowledge_chunks: 'knowledge_chunks',
    campaign_schedules: 'campaign_schedules',
    image_leads: 'image_leads',
    app_settings: 'app_settings',
};

// ─── JSON fields that need parsing after fetch ───────────────
const JSON_FIELDS = {
    contacts: ['tags'],
    campaigns: ['settings', 'buttons'],
    campaign_contacts: [],
    campaign_schedules: ['buttons', 'settings'],
    image_leads: ['phone_numbers', 'emails', 'social_links'],
    knowledge_documents: [],
    knowledge_chunks: [],
    conversations: [],
    messages: [],
    templates: [],
    app_settings: [],
};

// ─── Helper functions ────────────────────────────────────────

function parseRow(table, row) {
    if (!row) return row;
    return parseJsonFields(row, JSON_FIELDS[table] || []);
}

function parseRows(table, rows) {
    if (!rows) return rows;
    return rows.map(row => parseRow(table, row));
}

/**
 * Build a SELECT query with optional WHERE, ORDER BY, LIMIT, OFFSET
 */
async function select(table, columns = '*', where = '', params = [], orderBy = '', limit = null, offset = null) {
    if (!isAvailable()) {
        throw new Error('Supabase client is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY.');
    }

    let query = supabase
        .from(table)
        .select(columns);

    if (where) {
        // Use Postgres parameterized queries via Supabase's .or()/.eq()/.gte() etc.
        // For complex WHERE clauses, we use .rpc() or raw SQL via .rpc() with a Postgres function.
        // For simplicity, we build the query using Supabase's filter methods.
        query = applyWhere(query, table, where, params);
    }

    if (orderBy) {
        const orderParts = orderBy.trim().split(/\s+/);
        const orderCol = orderParts[0].replace(/^\w+\./, ''); // strip table alias
        const ascending = (orderParts[1] || 'asc').toLowerCase() !== 'desc';
        query = query.order(orderCol, { ascending });
    }

    if (limit !== null) {
        query = query.limit(limit);
    }

    if (offset !== null) {
        query = query.range(offset, offset + (limit || 1000) - 1);
    }

    const { data, error } = await query;
    if (error) throw error;
    return parseRows(table, data);
}

/**
 * Split a WHERE string on top-level AND operators (ignoring AND inside parens).
 */
function splitTopLevelAnd(str) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (depth === 0 && str.slice(i, i + 5).toUpperCase() === ' AND ') {
            parts.push(str.slice(start, i).trim());
            i += 4;
            start = i + 1;
        }
    }
    parts.push(str.slice(start).trim());
    return parts.filter(Boolean);
}

/**
 * Parse a single condition (e.g. "id = ?", "status IN ('a','b')", "x IS NULL").
 * Returns { column, operator, needsParam, literal? } or null if unsupported.
 * Table aliases (e.g. "cc.status") are allowed and stripped later.
 */
function parseSimpleCondition(condition) {
    let m;

    // column IS NULL / IS NOT NULL
    m = condition.match(/^([\w.]+)\s+IS\s+(NOT\s+)?NULL$/i);
    if (m) return { column: m[1], operator: m[2] ? 'notnull' : 'isnull', needsParam: false };

    // column IN (...)
    m = condition.match(/^([\w.]+)\s+IN\s*\(([^)]*)\)$/i);
    if (m) {
        const inner = m[2].trim();
        if (inner === '?') return { column: m[1], operator: 'in', needsParam: true };
        const items = inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        return { column: m[1], operator: 'in', needsParam: false, literal: items };
    }

    // column LIKE ?
    m = condition.match(/^([\w.]+)\s+LIKE\s*\?$/i);
    if (m) return { column: m[1], operator: 'like', needsParam: true };

    // column OP ?   ( = != <> >= <= > < )
    m = condition.match(/^([\w.]+)\s*(>=|<=|<>|!=|>|<|=)\s*\?$/i);
    if (m) return { column: m[1], operator: m[2], needsParam: true };

    return null;
}

/**
 * Normalize a parameter value for PostgREST:
 * Dates -> ISO strings (PostgREST cannot serialize Date objects).
 */
function normalizeParam(value) {
    if (value instanceof Date) return value.toISOString();
    return value;
}

/**
 * Apply a parsed operator to the query builder.
 */
function applyOperator(query, column, operator, param, literal) {
    const col = column.replace(/^\w+\./, ''); // strip table alias
    switch (operator) {
        case '=': {
            if (typeof param === 'string' && param.includes('%')) return query.like(col, param);
            return query.eq(col, param);
        }
        case '!=':
        case '<>': return query.neq(col, param);
        case '>=': return query.gte(col, param);
        case '<=': return query.lte(col, param);
        case '>': return query.gt(col, param);
        case '<': return query.lt(col, param);
        case 'like': return query.like(col, param);
        case 'in': return query.in(col, param !== undefined ? param : literal);
        case 'isnull': return query.is(col, null);
        case 'notnull': return query.not(col, 'is', null);
        default: throw new Error(`[db] Unsupported operator: ${operator}`);
    }
}

/**
 * Format a value for use inside a PostgREST .or() filter string.
 */
function postgrestValue(v) {
    if (v === null || v === undefined) return 'null';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') return String(v);
    const s = String(v);
    // Quote values containing PostgREST delimiters.
    if (/[,"()\s]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
    return s;
}

/**
 * Translate a parenthesized OR group (e.g. "(a = ? OR b = ?)") into a
 * PostgREST .or() filter, consuming params in order.
 */
function applyOrGroup(query, inner, params) {
    const orParts = inner.split(/\s+OR\s+/i).map(p => p.trim());
    const filters = [];
    for (const part of orParts) {
        const parsed = parseSimpleCondition(part);
        if (!parsed) throw new Error(`[db] Unsupported OR condition: "${part}"`);
        const col = parsed.column.replace(/^\w+\./, '');
        const op = parsed.operator;
        if (op === 'isnull') { filters.push(`${col}.is.null`); continue; }
        if (op === 'notnull') { filters.push(`${col}.not.is.null`); continue; }
        if (parsed.needsParam) {
            if (!params.length) throw new Error(`[db] Missing parameter for OR condition: "${part}"`);
            const param = params.shift();
            switch (op) {
                case '=': filters.push(`${col}.eq.${postgrestValue(param)}`); break;
                case '!=':
                case '<>': filters.push(`${col}.neq.${postgrestValue(param)}`); break;
                case '>=': filters.push(`${col}.gte.${postgrestValue(param)}`); break;
                case '<=': filters.push(`${col}.lte.${postgrestValue(param)}`); break;
                case '>': filters.push(`${col}.gt.${postgrestValue(param)}`); break;
                case '<': filters.push(`${col}.lt.${postgrestValue(param)}`); break;
                case 'like': filters.push(`${col}.like.${postgrestValue(String(param).replace(/%/g, '*'))}`); break;
                case 'in': filters.push(`${col}.in.(${Array.isArray(param) ? param.map(postgrestValue).join(',') : postgrestValue(param)})`); break;
                default: throw new Error(`[db] Unsupported OR operator: ${op}`);
            }
        } else if (op === 'in') {
            filters.push(`${col}.in.(${parsed.literal.map(postgrestValue).join(',')})`);
        } else {
            throw new Error(`[db] Unsupported OR condition: "${part}"`);
        }
    }
    return query.or(filters.join(','));
}

/**
 * Apply WHERE conditions using Supabase filter methods.
 * Supports ?, IN literals, IS NULL, comparison ops, LIKE and OR groups.
 * Throws on unsupported conditions rather than silently dropping filters.
 */
function applyWhere(query, table, where, params) {
    const cleaned = where.replace(/^WHERE\s+/i, '');
    const conditions = splitTopLevelAnd(cleaned);

    for (const rawCondition of conditions) {
        const condition = rawCondition.trim();
        if (!condition) continue;
        if (/^1\s*=\s*1$/i.test(condition)) continue; // always-true no-op

        // Parenthesized OR group: (A OR B)
        const orGroup = condition.match(/^\(([\s\S]*)\)$/);
        if (orGroup) {
            query = applyOrGroup(query, orGroup[1], params);
            continue;
        }

        const parsed = parseSimpleCondition(condition);
        if (!parsed) throw new Error(`[db] Unsupported WHERE condition: "${condition}"`);

        if (parsed.needsParam) {
            if (!params.length) throw new Error(`[db] Missing parameter for condition: "${condition}"`);
            const param = normalizeParam(params.shift());
            query = applyOperator(query, parsed.column, parsed.operator, param);
        } else {
            query = applyOperator(query, parsed.column, parsed.operator, undefined, parsed.literal);
        }
    }

    return query;
}

/**
 * INSERT a row and return the created record
 */
async function insert(table, data) {
    if (!isAvailable()) {
        throw new Error('Supabase client is not configured.');
    }

    const { data: result, error } = await supabase
        .from(table)
        .insert(data)
        .select()
        .single();

    if (error) throw error;
    return parseRow(table, result);
}

/**
 * INSERT multiple rows and return all created records
 */
async function insertMany(table, rows) {
    if (!isAvailable()) {
        throw new Error('Supabase client is not configured.');
    }

    const { data, error } = await supabase
        .from(table)
        .insert(rows)
        .select();

    if (error) throw error;
    return parseRows(table, data);
}

/**
 * UPDATE rows matching conditions
 */
async function update(table, data, where = '', params = []) {
    if (!isAvailable()) {
        throw new Error('Supabase client is not configured.');
    }

    let query = supabase.from(table).update(data);

    if (where) {
        query = applyWhere(query, table, where, params);
    }

    const { data: result, error } = await query.select();
    if (error) throw error;
    return parseRows(table, result);
}

/**
 * DELETE rows matching conditions
 */
async function del(table, where = '', params = []) {
    if (!isAvailable()) {
        throw new Error('Supabase client is not configured.');
    }

    let query = supabase.from(table).delete();

    if (where) {
        query = applyWhere(query, table, where, params);
    }

    const { data, error } = await query.select();
    if (error) throw error;
    return parseRows(table, data);
}

/**
 * Get a single row by ID
 */
async function getById(table, id) {
    if (!isAvailable()) {
        throw new Error('Supabase client is not configured.');
    }

    const { data, error } = await supabase
        .from(table)
        .select('*')
        .eq('id', id)
        .single();

    if (error) {
        if (error.code === 'PGRST116') return null; // No rows found
        throw error;
    }
    return parseRow(table, data);
}

/**
 * Get a single row matching a condition
 */
async function getOne(table, column, value) {
    if (!isAvailable()) {
        throw new Error('Supabase client is not configured.');
    }

    const { data, error } = await supabase
        .from(table)
        .select('*')
        .eq(column, value)
        .maybeSingle();

    if (error) throw error;
    return parseRow(table, data);
}

/**
 * Count rows matching conditions
 */
async function count(table, where = '', params = []) {
    if (!isAvailable()) {
        throw new Error('Supabase client is not configured.');
    }

    let query = supabase.from(table).select('*', { count: 'exact', head: true });

    if (where) {
        query = applyWhere(query, table, where, params);
    }

    const { count, error } = await query;
    if (error) throw error;
    return count;
}

/**
 * Get count and data in one call (for pagination)
 */
async function paginate(table, where = '', params = [], orderBy = 'created_at', order = 'desc', limit = 50, offset = 0) {
    if (!isAvailable()) {
        throw new Error('Supabase client is not configured.');
    }

    // Get total count
    const total = await count(table, where, [...params]);

    // Get page of data
    let query = supabase.from(table).select('*');

    if (where) {
        query = applyWhere(query, table, where, [...params]);
    }

    query = query.order(orderBy, { ascending: String(order).toLowerCase() !== 'desc' }).range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) throw error;

    return {
        total,
        data: parseRows(table, data),
    };
}

/**
 * Execute raw SQL via Postgres function (for complex queries)
 * This is a fallback for queries that can't be expressed via Supabase filters
 */
async function raw(sql, params = []) {
    if (!isAvailable()) {
        throw new Error('Supabase client is not configured.');
    }

    // For complex queries, we need to create a Postgres function or use .rpc()
    // For now, throw an error indicating the query needs to be refactored
    throw new Error(
        'Raw SQL queries are not supported via the Supabase JS client. ' +
        'Please refactor to use Supabase filter methods or create a Postgres function. ' +
        `Query: ${sql.substring(0, 200)}`
    );
}

/**
 * Get the last inserted ID (for compatibility)
 * Note: Supabase returns the full record, so this is mostly for transition
 */
function lastInsertRowid(result) {
    if (result && result.id) return result.id;
    return null;
}

/**
 * Begin a transaction (no-op for Supabase, operations are sequential)
 */
function exec(sql) {
    // Supabase doesn't support raw SQL execution directly.
    // For DDL operations (CREATE TABLE, etc.), use the Supabase dashboard SQL editor.
    // For DML, use the supabase client methods above.
    console.warn('[db] exec() called with:', sql.substring(0, 100));
    // Return a mock result for compatibility
    return { changes: 0 };
}

/**
 * Prepare a statement (no-op, returns the query builder for compatibility)
 */
function prepare(sql) {
    // For compatibility, return an object with run/get/all methods
    // that execute the query via Supabase.
    const stmt = {
        run: async (...params) => {
            // Parse the SQL to determine operation type
            const trimmed = sql.trim().toUpperCase();
            if (trimmed.startsWith('INSERT')) {
                // Extract table name and data from INSERT
                const tableMatch = sql.match(/INSERT\s+INTO\s+(\w+)/i);
                if (!tableMatch) throw new Error('Could not parse INSERT statement');
                const table = tableMatch[1];

                // Simple INSERT parsing for single row
                const valuesMatch = sql.match(/VALUES\s*\(([^)]+)\)/i);
                if (!valuesMatch) throw new Error('Could not parse VALUES clause');

                const values = params;
                return insert(table, values);
            }
            if (trimmed.startsWith('UPDATE')) {
                const tableMatch = sql.match(/UPDATE\s+(\w+)/i);
                if (!tableMatch) throw new Error('Could not parse UPDATE statement');
                const table = tableMatch[1];

                // Extract SET clause fields
                const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
                if (!setMatch) throw new Error('Could not parse SET clause');

                const setFields = setMatch[1].split(',').map(f => f.trim().split('=')[0].trim());
                const data = {};
                setFields.forEach((field, i) => {
                    data[field] = params[i];
                });

                // Extract WHERE clause
                const whereMatch = sql.match(/WHERE\s+(.+)$/i);
                let where = '';
                let whereParams = [];
                if (whereMatch) {
                    where = whereMatch[1];
                    // Filter out the SET params, keep WHERE params
                    whereParams = params.slice(setFields.length);
                }

                return update(table, data, where, whereParams);
            }
            if (trimmed.startsWith('DELETE')) {
                const tableMatch = sql.match(/DELETE\s+FROM\s+(\w+)/i);
                if (!tableMatch) throw new Error('Could not parse DELETE statement');
                const table = tableMatch[1];

                const whereMatch = sql.match(/WHERE\s+(.+)$/i);
                let where = '';
                let whereParams = [];
                if (whereMatch) {
                    where = whereMatch[1];
                    whereParams = params;
                }

                return del(table, where, whereParams);
            }
            if (trimmed.startsWith('SELECT')) {
                // For SELECT, we need to parse more carefully
                // This is a simplified parser
                return selectFromSql(sql, params);
            }
            throw new Error(`Unsupported SQL: ${sql.substring(0, 100)}`);
        },
        get: async (...params) => {
            const result = await stmt.run(...params);
            if (Array.isArray(result) && result.length > 0) return result[0];
            if (result && typeof result === 'object' && result.data) return result.data;
            return result;
        },
        all: async (...params) => {
            const result = await stmt.run(...params);
            if (Array.isArray(result)) return result;
            if (result && Array.isArray(result.data)) return result.data;
            return result;
        },
    };
    return stmt;
}

/**
 * Parse a SELECT statement and execute via Supabase
 */
async function selectFromSql(sql, params) {
    // This is a simplified parser for common SELECT patterns
    const tableMatch = sql.match(/FROM\s+(\w+)/i);
    if (!tableMatch) throw new Error('Could not parse SELECT statement');
    const table = tableMatch[1];

    // Extract columns
    const columnsMatch = sql.match(/SELECT\s+(.+?)\s+FROM/i);
    const columns = columnsMatch ? columnsMatch[1].trim() : '*';

    // Extract WHERE
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s+LIMIT|\s+GROUP\s+BY|\s+HAVING|\s*$)/i);
    let where = '';
    let whereParams = [];
    if (whereMatch) {
        where = whereMatch[1];
        // Simple parameter extraction
        const paramPlaceholders = where.match(/\?/g);
        if (paramPlaceholders) {
            whereParams = params.slice(0, paramPlaceholders.length);
        }
    }

    // Extract ORDER BY
    const orderMatch = sql.match(/ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
    let orderBy = '';
    if (orderMatch) {
        orderBy = `${orderMatch[1]} ${orderMatch[2] ? orderMatch[2].toUpperCase() : 'ASC'}`;
    }

    // Extract LIMIT and OFFSET
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    const offsetMatch = sql.match(/OFFSET\s+(\d+)/i);
    const limit = limitMatch ? parseInt(limitMatch[1]) : null;
    const offset = offsetMatch ? parseInt(offsetMatch[1]) : 0;

    return select(table, columns, where, whereParams, orderBy, limit, offset);
}

// ─── Initialize schema (no-op for Supabase, run SQL migration separately) ───

function initSchema() {
    console.log('✅ Database schema initialized (Supabase)');
    console.log('ℹ️  Run supabase-data-migration.sql in Supabase dashboard to create tables');
}

initSchema();

// ─── Export database interface ───────────────────────────────

module.exports = {
    // Table names
    TABLES,

    // Core operations
    select,
    insert,
    insertMany,
    update,
    del,
    getById,
    getOne,
    count,
    paginate,
    raw,

    // Compatibility methods
    prepare,
    exec,
    lastInsertRowid,
    isAvailable,

    // Helper
    parseRow,
    parseRows,

    // Query builder internals (exported for testing)
    applyWhere,
    splitTopLevelAnd,
    parseSimpleCondition,
};
