// Live DB verification for the "[object Blob]" knowledge-corruption fix.
// Read-only by default. Set LIVE=1 to actually run the repair ladder
// (deletes unrecoverable docs, repairs/deletes doc 8, clears the marker
// for affected users so they get re-seeded).
const db = require('../src/database/db');
const seedService = require('../src/knowledge/seedKnowledgeService');
const queryService = require('../src/ai/queryService');

const LIVE = process.env.LIVE === '1';

function preview(s, n = 80) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t || '(empty)';
}

(async () => {
    if (!db.isAvailable()) {
        console.error('Supabase not configured — aborting.');
        process.exit(1);
    }

    // 1. All knowledge documents with chunk health.
    const docs = await db.select('knowledge_documents', 'id, user_id, name, category, content, file_path, status, created_at', '', [], 'id', 500, 0);
    console.log(`\n=== KNOWLEDGE DOCUMENTS (${docs.length}) ===`);
    const docHealth = [];
    for (const d of docs) {
        const chunks = await db.select('knowledge_chunks', 'content, chunk_index', 'document_id = ?', [d.id], 'chunk_index', 1000, 0);
        const corrupt = chunks.filter(c => !String(c.content || '').trim() || /^\[object .+\]$/.test(String(c.content).trim())).length;
        docHealth.push({ doc: d, chunkCount: chunks.length, corrupt });
        console.log(
            `#${d.id} [${d.status}] user=${String(d.user_id).slice(0, 8)}… "${d.name}" ` +
            `chunks=${chunks.length} corrupt=${corrupt} ` +
            `content=${preview(d.content, 60)}`
        );
    }

    // 2. Affected users (corrupt or chunk-less docs).
    const affectedUserIds = [...new Set(docHealth.filter(h => h.chunkCount === 0 || h.corrupt > 0).map(h => h.doc.user_id))];

    if (!LIVE) {
        console.log('\n(Read-only pass. Set LIVE=1 to run the repair ladder.)');
        console.log('Affected users who would be repaired:', affectedUserIds.length ? affectedUserIds : '(none)');
    } else {
        // 3. Run the real repair ladder per affected user.
        for (const userId of affectedUserIds) {
            console.log(`\n=== LIVE REPAIR for user ${userId} ===`);
            await seedService.repairUnusableDocuments(userId);
            await seedService.seedIfEmpty(userId);
        }

        // 4. Post-repair state.
        console.log('\n=== POST-REPAIR DOCUMENTS ===');
        for (const h of docHealth) {
            const fresh = await db.select('knowledge_documents', 'id, name, content, status', 'id = ?', [h.doc.id], 'id', 1, 0);
            if (fresh.length === 0) { console.log(`#${h.doc.id} "${h.doc.name}" — DELETED`); continue; }
            const chunks = await db.select('knowledge_chunks', 'content', 'document_id = ?', [h.doc.id], 'chunk_index', 1000, 0);
            console.log(`#${h.doc.id} "${fresh[0].name}" chunks=${chunks.length} content=${preview(fresh[0].content, 60)}`);
        }
        for (const userId of affectedUserIds) {
            const marker = await db.getOne('app_settings', 'key', 'KB_DEFAULT_SEEDED', userId);
            console.log(`user ${String(userId).slice(0, 8)}… KB_DEFAULT_SEEDED=${marker ? marker.value : '(absent)'}`);
        }
    }

    // 5. Prove retrieval works on real data — one query per sampled user.
    console.log('\n=== RETRIEVAL CHECK ===');
    const users = [...new Set(docs.map(d => d.user_id))].slice(0, 3);
    for (const userId of users) {
        const active = docs.filter(d => d.user_id === userId && d.status === 'active');
        if (!active.length) { console.log(`user ${String(userId).slice(0, 8)}…: no active docs`); continue; }
        const words = String(active[0].name + ' ' + (active[0].content || '')).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
        const probe = words[0] || active[0].name;
        const sources = await queryService.retrieveSources(userId, probe, 5);
        console.log(`user ${String(userId).slice(0, 8)}… probe="${probe}" → ${sources.length} source(s)`);
        for (const s of sources.slice(0, 2)) console.log(`   [${s.docName}] score=${s.score} ${preview(s.content, 70)}`);
    }

    console.log(LIVE ? '\n✅ LIVE VERIFICATION COMPLETE' : '\n✅ READ-ONLY INSPECTION COMPLETE');
    process.exit(0);
})().catch(err => { console.error('FAILED:', err); process.exit(1); });
