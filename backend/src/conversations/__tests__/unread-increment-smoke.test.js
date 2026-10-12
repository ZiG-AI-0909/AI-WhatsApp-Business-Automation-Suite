const assert = require('assert');
const fs = require('fs');
const path = require('path');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const CONVERSATION_ID = 101;
const owners = new Map([[CONVERSATION_ID, USER_A]]);
const dbCalls = [];
const rpcCalls = [];
let rpcError = null;
let warnings = [];

const dbPath = require.resolve('../../database/db');
require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
        insert: async (...args) => { dbCalls.push(['insert', ...args]); },
        update: async (...args) => { dbCalls.push(['update', ...args]); },
        getById: async (table, id, userId) => {
            dbCalls.push(['getById', table, id, userId]);
            return owners.get(id) === userId
                ? { id, user_id: userId, unread_count: 2 }
                : null;
        },
    },
};

const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
        supabase: {
            rpc: async (name, params) => {
                rpcCalls.push([name, params]);
                if (rpcError) return { data: null, error: rpcError };
                return {
                    data: owners.get(params.p_conversation_id) === params.p_user_id ? 3 : null,
                    error: null,
                };
            },
        },
        isAvailable: () => true,
    },
};

const originalWarn = console.warn;
console.warn = (...args) => { warnings.push(args); };
const conversationService = require('../conversationService');

async function saveInbound(userId) {
    return conversationService.saveMessage(
        CONVERSATION_ID, 'inbound', 'Incoming message', null, 'sent', {}, userId
    );
}

async function main() {
    const migrationPath = path.resolve(__dirname, '../../../../supabase-unread-increment-migration.sql');
    const migration = fs.readFileSync(migrationPath, 'utf8');
    assert.match(migration, /p_conversation_id\s+bigint/i);
    assert.match(migration, /p_user_id\s+uuid/i);
    assert.match(migration, /where id = p_conversation_id\s+and user_id = p_user_id/i);
    assert.match(migration, /revoke execute on function public\.increment_unread\(bigint, uuid\) from public, anon, authenticated/i);
    assert.match(migration, /grant execute on function public\.increment_unread\(bigint, uuid\) to service_role/i);

    await saveInbound(USER_A);
    assert.deepStrictEqual(rpcCalls[0], [
        'increment_unread',
        { p_conversation_id: CONVERSATION_ID, p_user_id: USER_A },
    ]);
    assert.strictEqual(dbCalls.filter(([method]) => method === 'getById').length, 0,
        'successful RPC avoids the read-then-write fallback');

    rpcError = new Error('function not deployed');
    await saveInbound(USER_A);
    assert.strictEqual(warnings.length, 1, 'RPC error is logged');
    assert.strictEqual(dbCalls.filter(([method]) => method === 'getById').length, 1,
        'RPC error runs the fallback read');
    const unreadUpdate = dbCalls.find((call) => call[0] === 'update' && call[2]?.unread_count !== undefined);
    assert.ok(unreadUpdate, 'fallback writes unread_count');
    assert.strictEqual(unreadUpdate[2].unread_count, 3, 'fallback increments existing unread count');

    dbCalls.length = 0;
    await saveInbound(USER_B);
    assert.deepStrictEqual(rpcCalls[2], [
        'increment_unread',
        { p_conversation_id: CONVERSATION_ID, p_user_id: USER_B },
    ], 'RPC receives user B as the owner filter');
    assert.strictEqual(dbCalls.filter((call) => call[0] === 'getById').length, 1,
        'RPC error fallback reads under user B scope');
    assert.strictEqual(dbCalls.some((call) => call[0] === 'update' && call[2]?.unread_count !== undefined), false,
        'user B cannot update user A conversation unread count');

    console.warn = originalWarn;
    console.log('✅ Unread increment RPC and tenant isolation smoke tests passed');
}

main().catch((error) => {
    console.warn = originalWarn;
    console.error('❌ TEST FAILED:', error);
    process.exitCode = 1;
});
