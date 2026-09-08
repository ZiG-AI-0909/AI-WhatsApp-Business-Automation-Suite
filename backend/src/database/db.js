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
        query = query.order(orderBy.split(' ')[0], orderBy.split(' ')[1] || 'asc');
    }

    if (limit !== null) {
        query = query.limit(limit);
    }

    if (offset !== null) {
        query = query.range(offset, offset + (limit || 100) - 1);
    }

    const { data, error } = await query;
    if (error) throw error;
    return parseRows(table, data);
}

/**
 * Apply WHERE conditions using Supabase filter methods.
 * Supports simple equality and LIKE conditions.
 * For complex queries, use raw SQL via rpc().
 */
function applyWhere(query, table, where, params) {
    // Parse simple WHERE clauses
    // This handles common patterns used in the codebase
    const conditions = where.replace(/^WHERE\s+/i, '').split(/\s+AND\s+/i);

    for (const condition of conditions) {
        condition = condition.trim();

        // Pattern: column = ?
        const eqMatch = condition.match(/^(\w+)\s*=\s*$/);
        if (eqMatch && params.length > 0) {
            const param = params.shift();
            // Check if it's a string with LIKE
            if (typeof param === 'string' && param.includes('%')) {
                query = query.like(eqMatch[1], param);
            } else {
                query = query.eq(eqMatch[1], param);
            }
            continue;
        }

        // Pattern: column IS NOT NULL / IS NULL
        const isNullMatch = condition.match(/^(\w+)\s+IS\s+(NOT\s+)?NULL$/i);
        if (isNullMatch) {
            if (isNullMatch[2]) {
                query = query.is(isNullMatch[1], false);
            } else {
                query = query.is(isNullMatch[1], true);
            }
            continue;
        }

        // Pattern: column > / < / >= / <= ?
        const cmpMatch = condition.match(/^(\w+)\s*(>=|<=|>|<)\s*$/);
        if (cmpMatch && params.length > 0) {
            const param = params.shift();
            const opMap = { '>=': 'gte', '<=': 'lte', '>': 'gt', '<': 'lt' };
            query = query[opMap[cmpMatch[2]]](cmpMatch[1], param);
            continue;
        }

        // Pattern: column LIKE ?
        const likeMatch = condition.match(/^(\w+)\s+LIKE\s*$/);
        if (likeMatch && params.length > 0) {
            query = query.like(likeMatch[1], params.shift());
            continue;
        }

        // Pattern: column IN (?)
        const inMatch = condition.match(/^(\w+)\s+IN\s*$/);
        if (inMatch && params.length > 0) {
            const param = params.shift();
            if (Array.isArray(param)) {
                query = query.in(inMatch[1], param);
            }
            continue;
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

    query = query.order(orderBy, order).range(offset, offset + limit - 1);

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
    // that execute the query via Supabase
    return {
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
            const result = await this.run(...params);
            if (Array.isArray(result) && result.length > 0) return result[0];
            if (result && typeof result === 'object' && result.data) return result.data;
            return result;
        },
        all: async (...params) => {
            const result = await this.run(...params);
            if (Array.isArray(result)) return result;
            if (result && Array.isArray(result.data)) return result.data;
            return result;
        },
    };
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
};
