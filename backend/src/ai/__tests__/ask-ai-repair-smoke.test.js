// =============================================================
// Smoke test — Ask AI end-to-end repair + upload fixes.
//
// Proves, WITHOUT real Supabase or a real AI call:
//   1. downloadFromStorage converts supabase-js's Web Blob download
//      result into a Buffer. ROOT CAUSE: Blob.toString() is
//      Object.prototype.toString → the literal string "[object Blob]"
//      was stored as the document content, the doc looked fine in the
//      KB list, and retrieval could never match a single query.
//   2. The knowledge upload route stores REAL extracted text (decoded
//      from the multer memory buffer, per file type) and chunks it.
//   3. A pre-existing corrupted "[object Blob]" document with no
//      recovery source is deleted by the Ask AI pre-flight, and the
//      default company profile is then seeded — the exact production
//      failure shape (corrupt upload existed → seed marker written
//      without the user ever getting the seed doc).
//   4. A chunk-less document with valid content is repaired by
//      re-chunking; a user already holding the KB_DEFAULT_SEEDED
//      marker is not re-seeded on top of it.
//   5. addDocument sets status explicitly — docs it creates are
//      visible to retrieval even if the DB column default is missing
//      (the mock deliberately does NOT emulate a status default).
//   6. Empty-KB and no-matching-document answers are distinct and
//      actionable.
//
// Run: node backend/src/ai/__tests__/ask-ai-repair-smoke.test.js
// =============================================================
const assert = require('assert');

// ── Stub @supabase/supabase-js BEFORE any module loads ──────────
// Only middleware/upload.js constructs its own client (for Storage);
// DB access goes through the supabaseClient mock below. The stub's
// .storage is programmable so downloadFromStorage can be fed Blob /
// Buffer / Uint8Array fixtures and uploads can be observed.
const uploadedFiles = [];
const downloadFixtures = new Map(); // fileName → download() data

const supabaseJsPath = require.resolve('@supabase/supabase-js');
require.cache[supabaseJsPath] = {
    id: supabaseJsPath,
    filename: supabaseJsPath,
    loaded: true,
    exports: {
        createClient: () => ({
            storage: {
                from(_bucket) {
                    return {
                        async upload(fileName, buffer) {
                            uploadedFiles.push({ fileName, size: buffer.length });
                            return { data: { path: fileName }, error: null };
                        },
                        getPublicUrl(fileName) {
                            return { data: { publicUrl: `https://mock.storage/${fileName}` } };
                        },
                        async download(fileName) {
                            if (!downloadFixtures.has(fileName)) return { data: null, error: { message: 'not found' } };
                            return { data: downloadFixtures.get(fileName), error: null };
                        },
                        async remove() { return { data: [], error: null }; },
                    };
                },
            },
        }),
    },
};

// ── In-memory Supabase DB mock injected at the client boundary ──
// NOTE: no column-default emulation — a doc is only visible to
// retrieval if the application code sets status itself.
const state = { rows: { knowledge_documents: [], knowledge_chunks: [], ai_queries: [], app_settings: [] } };

function table(name) {
    if (!state.rows[name]) state.rows[name] = [];
    return {
        select(_cols, options = {}) {
            const filters = [];
            const headCount = !!(options.count && options.head);
            const run = async () => state.rows[name].filter(r => filters.every(f =>
                f.anyOf ? Array.isArray(f.val) && f.val.includes(r[f.col]) : r[f.col] === f.val));
            const builder = {
                eq(col, val) { filters.push({ col, val }); return builder; },
                in(col, vals) { filters.push({ col, val: vals, anyOf: true }); return builder; },
                order() { return builder; },
                limit() { return builder; },
                range() { return builder; },
                maybeSingle: async () => ({ data: (await run())[0] || null, error: null }),
                single: async () => ({ data: (await run())[0] || null, error: null }),
                async then(resolve) {
                    if (headCount) return resolve({ data: null, error: null, count: (await run()).length });
                    return resolve({ data: await run(), error: null });
                },
            };
            return builder;
        },
        insert(rowOrRows) {
            const isBatch = Array.isArray(rowOrRows);
            const apply = () => {
                if (isBatch) {
                    const stored = rowOrRows.map((r, i) => ({ ...r, id: state.rows[name].length + 1 + i }));
                    state.rows[name].push(...stored);
                    return stored;
                }
                const stored = { ...rowOrRows, id: state.rows[name].length + 1 };
                state.rows[name].push(stored);
                return [stored];
            };
            return {
                select() {
                    return {
                        // Thenable: awaited directly by db.insertMany (batch path).
                        then: (resolve) => resolve({ data: apply(), error: null }),
                        single: async () => ({ data: apply()[0], error: null }),
                    };
                },
            };
        },
        delete() {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push({ col, val }); return builder; },
                in(col, vals) { filters.push({ col, val: vals, anyOf: true }); return builder; },
                select: async () => {
                    state.rows[name] = state.rows[name].filter(r => !filters.every(f =>
                        f.anyOf ? Array.isArray(f.val) && f.val.includes(r[f.col]) : r[f.col] === f.val));
                    return { data: [], error: null };
                },
                async then(resolve) {
                    state.rows[name] = state.rows[name].filter(r => !filters.every(f =>
                        f.anyOf ? Array.isArray(f.val) && f.val.includes(r[f.col]) : r[f.col] === f.val));
                    return resolve({ data: [], error: null });
                },
            };
            return builder;
        },
        update(_data) {
            const filters = [];
            const builder = {
                eq(col, val) { filters.push({ col, val }); return builder; },
                select: async () => {
                    state.rows[name] = state.rows[name].map(r =>
                        filters.every(f => r[f.col] === f.val) ? { ...r, ..._data } : r);
                    return { data: state.rows[name].filter(r => filters.every(f => r[f.col] === f.val)), error: null };
                },
            };
            return builder;
        },
    };
}

const clientPath = require.resolve('../../database/supabaseClient');
require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
        supabase: { from: (name) => table(name) },
        isAvailable: () => true,
        transaction: async (ops) => { for (const op of ops) await op(); },
        normalizeRow: (r) => r,
        parseJsonFields: (r) => r,
    },
};

process.env.SUPABASE_URL = 'https://mock.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'mock-secret';
process.env.AI_API_KEY = 'env-test-key';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const uploadMiddleware = require('../../middleware/upload');
const db = require('../../database/db');
const seedService = require('../../knowledge/seedKnowledgeService');
const knowledgeBase = require('../../ai/knowledgeBase');
const queryService = require('../../ai/queryService');
const knowledgeRoute = require('../../routes/knowledge');

// Capture AI calls instead of hitting a real provider.
const realAiService = require('../../ai/aiService');
let aiCalls = [];
realAiService._complete = async (messages, options) => {
    aiCalls.push({ messages, options });
    return 'Answered from the knowledge base.';
};

const CORRUPT_USER = 'cccccccc-1111-1111-1111-111111111111';
const CHUNKLESS_USER = 'cccccccc-2222-2222-2222-222222222222';
const DELETED_SEED_USER = 'cccccccc-3333-3333-3333-333333333333';
const FRESH_USER = 'cccccccc-4444-4444-4444-444444444444';
const UPLOAD_USER = 'cccccccc-5555-5555-5555-555555555555';

function findRoute(router, method, routePath) {
    const layer = router.stack.find(l => l.route?.path === routePath && l.route?.methods?.[method]);
    assert.ok(layer, `${method.toUpperCase()} ${routePath} route exists`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function test1_downloadConvertsBlobToBuffer() {
    console.log('▶ Test 1: downloadFromStorage returns a Buffer for Blob/Buffer/Uint8Array');
    downloadFixtures.set('blob.txt', new Blob([Buffer.from('Downloaded HDPE specs PN10')], { type: 'text/plain' }));
    const fromBlob = await uploadMiddleware.downloadFromStorage('knowledge-documents', 'blob.txt');
    assert.ok(Buffer.isBuffer(fromBlob), 'Blob result converted to Buffer');
    assert.strictEqual(fromBlob.toString('utf8'), 'Downloaded HDPE specs PN10');

    downloadFixtures.set('buf.txt', Buffer.from('raw buffer passthrough'));
    const fromBuffer = await uploadMiddleware.downloadFromStorage('knowledge-documents', 'buf.txt');
    assert.ok(Buffer.isBuffer(fromBuffer), 'Buffer result stays a Buffer');

    downloadFixtures.set('u8.txt', new Uint8Array([72, 68, 80, 69]));
    const fromU8 = await uploadMiddleware.downloadFromStorage('knowledge-documents', 'u8.txt');
    assert.ok(Buffer.isBuffer(fromU8), 'Uint8Array result converted to Buffer');
    assert.strictEqual(fromU8.toString('utf8'), 'HDPE');

    downloadFixtures.set('bad.bin', { notBytes: true });
    await assert.rejects(
        () => uploadMiddleware.downloadFromStorage('knowledge-documents', 'bad.bin'),
        /unexpected storage response type/,
        'garbage response type fails loudly instead of producing "[object Blob]"',
    );

    // The historical bug, stated explicitly: a Blob's toString() is the
    // corruption string that reached production as document content.
    const blob = new Blob([Buffer.from('real bytes')]);
    assert.strictEqual(blob.toString(), '[object Blob]', 'documents the failure mode this fix prevents');
    console.log('✅ Test 1 passed\n');
}

async function test2_uploadRouteStoresRealText() {
    console.log('▶ Test 2: knowledge upload stores extracted text, chunked for retrieval');
    const handler = findRoute(knowledgeRoute, 'post', '/upload');
    const text = 'Our uPVC column pipes are manufactured per IS 4985:2020 with a PN10 pressure class and 6-inch diameter availability.';
    const req = {
        user: { id: UPLOAD_USER },
        body: {},
        file: { buffer: Buffer.from(text, 'utf8'), originalname: 'product-specs.txt', mimetype: 'text/plain' },
    };
    let status = null;
    let body = null;
    await handler(req, {
        json: (d) => { body = d; },
        status(code) { status = code; return { json: (d) => { body = d; } }; },
    });

    assert.strictEqual(status, 201, `upload succeeded (got ${status}: ${JSON.stringify(body)})`);
    assert.strictEqual(body.content, text, 'doc content is the real file text, not "[object Blob]"');
    assert.strictEqual(uploadedFiles.length, 1, 'original file still stored in Supabase Storage');

    const chunks = state.rows.knowledge_chunks.filter(c => c.user_id === UPLOAD_USER);
    assert.ok(chunks.length >= 1, 'document chunked for retrieval');
    assert.ok(chunks.some(c => c.content.includes('PN10')), 'chunks contain the real spec text');

    const sources = await queryService.retrieveSources(UPLOAD_USER, 'PN10 pressure class');
    assert.ok(sources.length > 0, 'uploaded doc is immediately retrievable');
    assert.strictEqual(sources[0].docName, 'product-specs.txt');
    console.log('✅ Test 2 passed\n');
}

async function test3_corruptDocDeletedThenSeeded() {
    console.log('▶ Test 3: "[object Blob]" doc deleted by pre-flight, then seed fills the gap');
    // Production shape: doc row exists (marker already written because the
    // corrupt doc counted as "user has documents"), one garbage chunk.
    // Explicit high ids: rows pushed directly bypass the mock's auto-id
    // insert and must not collide with ids assigned by earlier tests.
    state.rows.knowledge_documents.push({
        id: 901,
        user_id: CORRUPT_USER, name: 'Sudarshan pipes', category: 'general',
        content: '[object Blob]', status: 'active', file_path: null,
    });
    state.rows.knowledge_chunks.push({ document_id: 901, user_id: CORRUPT_USER, content: '[object Blob]', chunk_index: 0 });
    state.rows.app_settings.push({ key: 'KB_DEFAULT_SEEDED', value: 'true', user_id: CORRUPT_USER });

    const before = await queryService.retrieveSources(CORRUPT_USER, 'manufacturing capacity MTPA');
    assert.strictEqual(before.length, 0, 'precondition: corrupted doc matches nothing');

    await seedService.ensureReadyForAsk(CORRUPT_USER);

    const docsAfter = state.rows.knowledge_documents.filter(d => d.user_id === CORRUPT_USER);
    assert.strictEqual(docsAfter.length, 1, 'corrupt doc deleted, seed profile created');
    assert.strictEqual(docsAfter[0].name, seedService.SEED_DOC_NAME, 'replacement is the default company profile');

    const sources = await queryService.retrieveSources(CORRUPT_USER, 'manufacturing capacity MTPA');
    assert.ok(sources.length > 0, 'post-repair retrieval works');
    assert.ok(sources.some(s => s.content.includes('MTPA')), 'sources carry the capacity facts');
    console.log('✅ Test 3 passed\n');
}

async function test4_chunklessDocRepaired() {
    console.log('▶ Test 4: chunk-less doc with valid content is re-chunked; marker respected');
    state.rows.knowledge_documents.push({
        id: 902,
        user_id: CHUNKLESS_USER, name: 'My Specs', category: 'general',
        content: 'Our 6-inch HDPE pipe has a pressure class of PN10.', status: 'active', file_path: null,
    });
    state.rows.app_settings.push({ key: 'KB_DEFAULT_SEEDED', value: 'true', user_id: CHUNKLESS_USER });

    await seedService.ensureReadyForAsk(CHUNKLESS_USER);

    const docs = state.rows.knowledge_documents.filter(d => d.user_id === CHUNKLESS_USER);
    assert.strictEqual(docs.length, 1, 'existing user keeps exactly their own doc');
    assert.strictEqual(docs[0].name, 'My Specs', 'seed profile NOT injected (marker present)');

    const chunks = state.rows.knowledge_chunks.filter(c => c.user_id === CHUNKLESS_USER);
    assert.ok(chunks.length >= 1, 'chunks rebuilt from the doc content');

    const sources = await queryService.retrieveSources(CHUNKLESS_USER, 'pressure class PN10');
    assert.ok(sources.length > 0, 'repaired doc is retrievable');
    assert.strictEqual(sources[0].docName, 'My Specs');
    console.log('✅ Test 4 passed\n');
}

async function test5_addDocumentSetsStatusExplicitly() {
    console.log('▶ Test 5: addDocument rows are active without relying on a DB default');
    await knowledgeBase.addDocument(FRESH_USER, 'Explicit status doc', 'general', 'Compression fittings come in PN16 rated variants.');
    const doc = state.rows.knowledge_documents.find(d => d.user_id === FRESH_USER);
    assert.strictEqual(doc.status, 'active', 'status written by the application, not a column default');

    const sources = await queryService.retrieveSources(FRESH_USER, 'compression fittings PN16');
    assert.ok(sources.length > 0, 'doc visible to retrieval');
    console.log('✅ Test 5 passed\n');
}

async function test6_emptyVsNoMatchAnswers() {
    console.log('▶ Test 6: empty-KB and no-matching-doc answers are distinct');
    aiCalls = [];

    // Marker present but zero documents (user deleted everything) → the
    // honest "your KB is empty" message.
    state.rows.app_settings.push({ key: 'KB_DEFAULT_SEEDED', value: 'true', user_id: DELETED_SEED_USER });
    const empty = await queryService.ask(DELETED_SEED_USER, 'what is your delivery lead time');
    assert.strictEqual(empty.stored, false, 'nothing stored without sources');
    assert.match(empty.answer, /Knowledge Base is empty/i, 'empty KB gets the seeding hint');

    // A user WITH documents but no lexical match → "no matching documents".
    // (Every token is deliberately absent from the uploaded uPVC doc.)
    const noMatch = await queryService.ask(UPLOAD_USER, 'galvanized steel conduit coil prices');
    assert.match(noMatch.answer, /No matching documents/i, 'non-empty KB gets the no-match message');

    // Full happy path still reaches the AI exactly once and stores history.
    aiCalls = [];
    const answered = await queryService.ask(FRESH_USER, 'compression fittings PN16');
    assert.strictEqual(answered.stored, true, 'answered query persisted');
    assert.ok(answered.sources.some(s => s.name === 'Explicit status doc'), 'sources returned with answer');
    assert.strictEqual(aiCalls.length, 1, 'exactly one AI call');

    // Pre-flight ran once per user: a second ask does no repair/seed work
    // (no extra app_settings marker writes beyond the first call).
    const markersBefore = state.rows.app_settings.filter(r => r.user_id === FRESH_USER && r.key === 'KB_DEFAULT_SEEDED').length;
    await queryService.ask(FRESH_USER, 'compression fittings PN16');
    const markersAfter = state.rows.app_settings.filter(r => r.user_id === FRESH_USER && r.key === 'KB_DEFAULT_SEEDED').length;
    assert.strictEqual(markersAfter, markersBefore, 'steady-state asks perform no seeding work');
    console.log('✅ Test 6 passed\n');
}

async function main() {
    try {
        await test1_downloadConvertsBlobToBuffer();
        await test2_uploadRouteStoresRealText();
        await test3_corruptDocDeletedThenSeeded();
        await test4_chunklessDocRepaired();
        await test5_addDocumentSetsStatusExplicitly();
        await test6_emptyVsNoMatchAnswers();
        console.log('🎉 ALL ASK-AI REPAIR SMOKE TESTS PASSED');
        process.exit(0);
    } catch (error) {
        console.error('❌ TEST FAILED:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
