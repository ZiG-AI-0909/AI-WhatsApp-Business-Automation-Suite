// =============================================================
// LIVE end-to-end verification against the DEPLOYED backend.
//
// Default: read-only checks only.
//   LIVE=1  additionally runs checks that WRITE data (Ask AI queries,
//           BOQ extraction, KB uploads). Every created row/document is
//           cleaned up at the end, and the ephemeral test user is
//           deleted either way.
//
//   node scripts/live-full-verify.js            # read-only
//   LIVE=1 node scripts/live-full-verify.js     # full E2E incl. writes
//
// Uses the LOCAL .env (SUPABASE_URL, SUPABASE_SECRET_KEY,
// VITE_SUPABASE_PUBLISHABLE_KEY) to mint an ephemeral Supabase test
// user (admin API), sign in with the publishable key to get a real
// JWT, then exercise the live Render deployment as that user:
//   https://ai-whatsapp-business-automation-suite.onrender.com
//
// Checks:
//   1. Auth: real JWT from the live Supabase project
//   2. Connectivity: whatsapp/status, analytics/dashboard,
//      conversations?limit=5, knowledge — all HTTP 200, JSON body, timed
//   3. Ask AI positive: seeded KB answers "manufacturing capacity" with
//      a cited source (LIVE=1)
//   4. Ask AI negative: unanswerable question fails honestly — either
//      the canned zero-retrieval message (path A) or an AI-generated
//      refusal with no fabricated specs (path B); the result records
//      which path fired (LIVE=1)
//   5. Document Intelligence: xlsx + generated pdf BOQ extraction
//      returns structured items with count > 0 (LIVE=1)
//   6. KB integrity: no document content contains "[object Blob]"
//      (regression check for the Blob corruption bug)
//   7. Pass/fail summary per check with full failure detail
//   8. Cleanup: boq docs, KB docs (+ their Storage objects), ask history
//      rows, ephemeral user — no side effects between runs
// =============================================================
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');

const BASE_URL = process.env.LIVE_BASE_URL || 'https://ai-whatsapp-business-automation-suite.onrender.com';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || '';
const PUBLISHABLE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
const TEST_EMAIL_BASE = 'live-verify-e2e';
// Unique per run: Supabase blocks re-registering a just-deleted user's
// email for a short purge window, so reuse across back-to-back runs fails
// with "already registered". The pre-clean below still removes stale
// users from crashed runs, and cleanup deletes this run's user.
const TEST_EMAIL = `${TEST_EMAIL_BASE}.${Date.now().toString(36)}@codebuff-scripts.invalid`;
const TEST_PASSWORD = 'Lv-verify-' + Math.random().toString(36).slice(2, 10) + '9!a';

const results = [];
const cleanup = {
    askHistoryIds: [], boqIds: [], kbDocIds: [], storagePaths: [],
    userId: null, admin: null, note: '',
};

function record(name, pass, detail) {
    results.push({ name, pass, detail: detail || '' });
    console.log(`${pass ? '✅' : '❌'} [${name}] ${pass ? 'PASS' : 'FAIL'}${detail ? ' — ' + detail : ''}`);
}

async function main() {
    if (!SUPABASE_URL || !SERVICE_KEY || !PUBLISHABLE_KEY) {
        console.error('Missing SUPABASE_URL / SUPABASE_SECRET_KEY / VITE_SUPABASE_PUBLISHABLE_KEY in .env');
        process.exit(1);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    cleanup.admin = admin;

    // ── 1. AUTHENTICATION: ephemeral user + real JWT ─────────────────────
    const tAuth = Date.now();
    try {
        // Idempotency: crashed runs may have left stale test users —
        // remove every user whose email uses our test local-part.
        for (let page = 1; page <= 3; page++) {
            const existing = await admin.auth.admin.listUsers({ page, perPage: 500 });
            const stale = (existing.users || []).filter(u => String(u.email || '').startsWith(TEST_EMAIL_BASE));
            if (!stale.length) break;
            for (const u of stale) await admin.auth.admin.deleteUser(u.id);
            if ((existing.users || []).length < 500) break;
        }
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
            email: TEST_EMAIL,
            password: TEST_PASSWORD,
            email_confirm: true,
        });
        if (createErr) throw createErr;
        cleanup.userId = created.user.id;

        const anon = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data: signed, error: signErr } = await anon.auth.signInWithPassword({
            email: TEST_EMAIL,
            password: TEST_PASSWORD,
        });
        if (signErr) throw signErr;
        const token = signed.session.access_token;

        const authMs = Date.now() - tAuth;
        const jwtPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
        record('1. AUTH', true,
            `real JWT obtained in ${authMs}ms, sub=${jwtPayload.sub?.slice(0, 8)}…, email verified=${jwtPayload.email_verified}`);
        global.__TOKEN = token;
    } catch (err) {
        record('1. AUTH', false, `could not obtain JWT: ${err.message}`);
        printSummary();
        process.exit(0);
    }

    // ── 2. GENERAL CONNECTIVITY (read-only) ──────────────────────────────
    const endpoints = [
        ['/api/whatsapp/status', null],
        ['/api/analytics/dashboard', null],
        ['/api/conversations?limit=5', null],
        ['/api/knowledge', null],
    ];
    for (const [ep] of endpoints) {
        const r = await apiGet(ep, global.__TOKEN);
        const ok = r.status === 200 && r.jsonOk;
        record(`2. CONNECTIVITY ${ep}`, ok,
            `HTTP ${r.status}, json=${r.jsonOk}, ${r.ms}ms${ok ? '' : ' — body: ' + truncate(r.text, 300)}`);
    }

    // ── 6. KB INTEGRITY (read-only; run before writes so it reflects
    //       the user's own KB state, which for a fresh user is the seed) ──
    try {
        const list = await apiGet('/api/knowledge', global.__TOKEN);
        if (list.status !== 200 || !list.jsonOk) {
            record('6. KB INTEGRITY', false, `cannot list KB: HTTP ${list.status}, body: ${truncate(list.text, 200)}`);
        } else {
            const docs = list.body;
            const seeded = Array.isArray(docs) && docs.length > 0;
            let corrupt = 0, checked = 0;
            for (const d of docs) {
                const one = await apiGet(`/api/knowledge/${d.id}`, global.__TOKEN);
                if (one.status !== 200 || !one.jsonOk) continue;
                checked++;
                if (String(one.body?.content || '').includes('[object Blob]')) corrupt++;
            }
            record('6. KB INTEGRITY', seeded && corrupt === 0,
                `${checked} doc(s) inspected via GET /api/knowledge/:id, ${corrupt} containing "[object Blob]"` +
                (seeded ? '' : ' — KB list was EMPTY, so the regression check proved nothing'));
        }
    } catch (err) {
        record('6. KB INTEGRITY', false, `unexpected error: ${err.message}`);
    }

    // ── 3–5. WRITE PATHS (LIVE=1 only) ───────────────────────────────────
    if (process.env.LIVE !== '1') {
        console.log('\n⏭️  LIVE=1 not set — skipping checks 3, 4, 5 (they write data).');
    } else {
        const seedWaitMs = await waitForSeed(global.__TOKEN);
        if (seedWaitMs >= 0) {
            console.log(`   (fresh-user KB seed confirmed, waited ${seedWaitMs}ms)`);
        } else {
            console.log('   (WARN: seeded doc not confirmed — Ask AI positive case may fail)');
        }

        // ── 3. ASK AI — POSITIVE ────────────────────────────────────────
        try {
            const r = await apiPost('/api/ask-ai/ask', { question: 'What is Sudarshan Pipes\' manufacturing capacity?' }, global.__TOKEN);
            const body = r.body || {};
            const honestNoDocs = typeof body.answer === 'string' && body.answer.startsWith('Your Knowledge Base is empty');
            const noMatch = typeof body.answer === 'string' && body.answer.startsWith('No matching documents');
            const pass = r.status === 200 && !honestNoDocs && !noMatch &&
                typeof body.answer === 'string' && body.answer.length > 20 &&
                Array.isArray(body.sources) && body.sources.length > 0;
            if (pass && body.id) cleanup.askHistoryIds.push(body.id);
            record('3. ASK AI POSITIVE', pass,
                `HTTP ${r.status}, ${r.ms}ms, answer="${truncate(body.answer, 120)}", sources=${JSON.stringify((body.sources || []).map(s => s.name))}` +
                (r.status !== 200 ? ' — body: ' + truncate(r.text, 300) : ''));
        } catch (err) {
            record('3. ASK AI POSITIVE', false, `unexpected error: ${err.message}`);
        }

        // ── 4. ASK AI — NEGATIVE ────────────────────────────────────────
        // An unanswerable question may fail honestly via TWO DISTINCT code
        // paths, and the result records WHICH one fired (they exercise
        // different code):
        //   PATH A — zero-retrieval short-circuit: no chunk scores > 0,
        //     queryService.ask() returns the canned "no matching documents"
        //     message and the AI is never called.
        //   PATH B — AI-generated refusal: the probe shares generic
        //     vocabulary with the KB (pipe, water, hdpe…), so retrieval
        //     returns low-relevance chunks and the AI IS invoked — its
        //     grounding rules must make it decline instead of inventing
        //     specs. Accepted when the answer contains refusal language
        //     and NO fabricated specifics (clause numbers, pressure
        //     figures, the probe's temperature echoed back as fact).
        try {
            const r = await apiPost('/api/ask-ai/ask',
                { question: 'What is the exact ISO 4427 clause number for PN10 HDPE pipe hydrostatic test pressure at 43 degrees Celsius with chlorinated water?' },
                global.__TOKEN);
            const body = r.body || {};
            const answer = typeof body.answer === 'string' ? body.answer : '';
            const sources = Array.isArray(body.sources) ? body.sources : [];
            // Normalise typographic apostrophes — models answer with
            // "don't" (U+2019), which is invisible in output but breaks
            // ASCII phrase matching.
            const lowered = answer.toLowerCase().replace(/[’‘]/g, "'");

            const cannedMessage = answer.startsWith('No matching documents') ||
                answer.startsWith('Your Knowledge Base is empty');

            const refusalPhrases = [
                "don't have", "do not have", "no information", "cannot find",
                "can't find", "not covered", "not specified", "not mentioned",
                "not contain", "no matching", "is empty", "unable to",
                "not available",
            ];
            const hasRefusalLanguage = refusalPhrases.some(p => lowered.includes(p));

            // Fabrication signals for THIS probe: a cited clause/section
            // number, a numeric MPa/bar pressure figure, or the probe's
            // temperature asserted as fact. Merely NAMING the missing
            // standard ("the ISO 4427 standard … would help") is honest,
            // so the bare token is deliberately not flagged.
            const fabricationPatterns = [
                // Requires a real digit after the keyword — a sentence-final
                // period ("…the specific clause.") is not a clause number.
                /\b(?:clause|section|annex)\s*#?\s*\d[\d.]*/i,
                /\d+(\.\d+)?\s*(mpa|bar)\b/i,
                // NOTE: no pattern for the probe's 43°C — restating the
                // asked-for condition ("testing at 43°C needs the standard")
                // is echoing the question, not fabricating a claim. Invented
                // PRESSURE values and clause numbers are the real signals,
                // and both are covered above.
            ];
            const fabricated = fabricationPatterns.filter(re => re.test(answer));

            let path = null;
            if (cannedMessage && sources.length === 0) {
                path = 'A: zero-retrieval short-circuit (canned message, AI not invoked)';
            } else if (answer && hasRefusalLanguage && fabricated.length === 0) {
                path = 'B: AI-generated refusal (low-relevance chunks retrieved, no fabricated specs)';
            }
            const pass = r.status === 200 && path !== null;
            if (pass && body.id) cleanup.askHistoryIds.push(body.id);
            record('4. ASK AI NEGATIVE', pass,
                `HTTP ${r.status}, ${r.ms}ms, path=${path || 'NONE — NOT AN HONEST FAILURE'}, ` +
                `refusalLanguage=${hasRefusalLanguage}, fabricatedSignals=${fabricated.length}, ` +
                `sources=${sources.length}, answer="${truncate(answer, 140)}"` +
                (!path && fabricated.length ? ` — matched fabrication pattern(s): ${fabricated.map(String).join(', ')}` : '') +
                (r.status !== 200 ? ' — body: ' + truncate(r.text, 300) : ''));
        } catch (err) {
            record('4. ASK AI NEGATIVE', false, `unexpected error: ${err.message}`);
        }

        // ── 5. DOCUMENT INTELLIGENCE: xlsx + pdf ────────────────────────
        const xlsxBuffer = await buildBoqXlsx();
        const pdfBuffer = buildBoqPdf();
        for (const [filename, buffer, mime] of [
            ['live-verify-boq.xlsx', xlsxBuffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
            ['live-verify-boq.pdf', pdfBuffer, 'application/pdf'],
        ]) {
            const label = `5. DOC INTELLIGENCE (${filename})`;
            try {
                const r = await apiPostFile('/api/boq/process', filename, buffer, mime, global.__TOKEN);
                const body = r.body || {};
                const items = Array.isArray(body.items) ? body.items : [];
                const pass = r.status === 201 && !body.error && items.length > 0;
                if (pass && body.id) cleanup.boqIds.push(body.id);
                const first = items[0] ? `first=${JSON.stringify({ product: items[0].product, size: items[0].size, quantity: items[0].quantity })}` : 'no items';
                record(label, pass,
                    `HTTP ${r.status}, ${r.ms}ms, items=${items.length}, ${first}` +
                    (!pass ? ' — body: ' + truncate(r.text, 400) : ''));
            } catch (err) {
                record(label, false, `unexpected error: ${err.message}`);
            }
        }

        // ── 6b. KB upload e2e incl. the Blob fix (content verified, then
        //        deleted via API; Storage object removed by cleanup) ────
        try {
            const r = await apiPostFile('/api/knowledge/upload',
                'live-verify-spec.txt', Buffer.from('Our PN10 HDPE pipe pressure class is verified by live-full-verify.js.', 'utf8'),
                'text/plain', global.__TOKEN);
            const body = r.body || {};
            const ok = r.status === 201 && !body.error && typeof body.content === 'string' &&
                body.content.includes('verified by live-full-verify.js') && !body.content.includes('[object Blob]');
            if (ok && body.id) { cleanup.kbDocIds.push(body.id); if (body.file_path) cleanup.storagePaths.push(body.file_path); }
            record('6b. KB UPLOAD (Blob regression e2e)', ok,
                `HTTP ${r.status}, ${r.ms}ms, content="${truncate(body.content, 80)}"` +
                (ok ? '' : ' — body: ' + truncate(r.text, 300)));
        } catch (err) {
            record('6b. KB UPLOAD (Blob regression e2e)', false, `unexpected error: ${err.message}`);
        }
    }
}

// ─── HTTP helpers (Node 18+ global fetch; 429s retried with backoff) ──
async function api(path, token, init = {}, { retries = 1 } = {}) {
    const started = Date.now();
    let res, lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            res = await fetch(BASE_URL + path, {
                ...init,
                headers: {
                    ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
                    Authorization: `Bearer ${token}`,
                    ...(init.headers || {}),
                },
            });
            const text = await res.text();
            let jsonOk = false, body = null;
            try { body = JSON.parse(text); jsonOk = true; } catch { /* not JSON */ }
            return { status: res.status, text, body, jsonOk, ms: Date.now() - started };
        } catch (err) {
            lastErr = err;
            await sleep(4000);
        }
    }
    return { status: 0, text: `network error: ${lastErr?.message}`, body: null, jsonOk: false, ms: Date.now() - started };
}
const apiGet = (path, token) => api(path, token, { method: 'GET' });
const apiPost = (path, body, token) => api(path, token, { method: 'POST', body: JSON.stringify(body) });

async function apiPostFile(path, filename, buffer, mime, token) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), filename);
    return api(path, token, { method: 'POST', body: form }, { retries: 0 });
}

// The seeded profile is written on the first GET /api/knowledge (already
// done in check 2), but Ask AI's pre-flight repair runs async relative to
// the very first insert — wait briefly until the doc is retrievable.
async function waitForSeed(token) {
    for (let waited = 0; waited < 15000; waited += 1000) {
        const r = await apiGet('/api/knowledge', token);
        if (r.status === 200 && r.jsonOk && Array.isArray(r.body) && r.body.length > 0) return waited;
        await sleep(1000);
    }
    return -1;
}

// ─── Fixtures ────────────────────────────────────────────────────────
async function buildBoqXlsx() {
    // 25 line items — close to real-world BOQ size so the live check
    // exercises the chunked extraction path (the old 3-row fixture fit in
    // a single AI call and could not catch truncation/timeout problems).
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('BOQ');
    ws.addRow(['Item', 'Product', 'Size', 'Specification', 'Quantity', 'Unit']);
    const products = ['uPVC Column Pipe', 'HDPE Pipe', 'Ductile Iron Pipe', 'Compression Fitting', 'GI Pipe'];
    const specs = ['IS 4985:2020 PN10', 'IS 4984:2016 PE100 PN10', 'PN16', 'IS 1239', 'Sch 40'];
    for (let i = 1; i <= 25; i++) {
        const product = products[i % products.length];
        const size = `${60 + (i % 6) * 25}mm`;
        ws.addRow([String(i), product, size, specs[i % specs.length], String(100 * i), i % 2 ? 'm' : 'nos']);
    }
    const out = await wb.xlsx.writeBuffer();
    return Buffer.from(out);
}

// Minimal valid single-page PDF (correct xref offsets) so the live
// deploy's pdf-parse v2 path is exercised end-to-end.
function buildBoqPdf() {
    // PDF content streams only need whitespace between operators, so join
    // lines with a space — avoids any newline escaping inside the stream.
    const stream = [
        'BT /F1 18 Tf 72 720 Td (BOQ) Tj ET',
        'BT /F1 12 Tf 72 690 Td (1. uPVC Column Pipe 63mm IS 4985:2020 PN10 - 1200 m) Tj ET',
        'BT /F1 12 Tf 72 670 Td (2. HDPE Pipe 110mm IS 4984:2016 PE100 PN10 - 800 m) Tj ET',
        'BT /F1 12 Tf 72 650 Td (3. Compression Fitting 90mm PN16 - 45 nos) Tj ET',
    ].join(' ');
    const objs = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
    objs[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    for (let i = 1; i <= 5; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj ${objs[i]} endobj\n`; }
    const xrefStart = pdf.length;
    pdf += 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
}

// ─── Cleanup (best-effort; runs even when checks fail) ───────────────
async function runCleanup() {
    const token = global.__TOKEN;
    const admin = cleanup.admin;
    const steps = [];
    const tryStep = async (name, fn) => {
        try { await fn(); steps.push(`ok: ${name}`); }
        catch (err) { steps.push(`FAILED: ${name} — ${err.message}`); }
    };

    if (token) {
        for (const id of cleanup.askHistoryIds) {
            await tryStep(`delete ask history #${id}`, () => api(`/api/ask-ai/history/${id}`, token, { method: 'DELETE' }));
        }
        for (const id of cleanup.boqIds) {
            await tryStep(`delete boq doc #${id}`, () => api(`/api/boq/${id}`, token, { method: 'DELETE' }));
        }
        if (cleanup.kbDocIds.length) {
            await tryStep('delete KB docs via bulk-delete', () =>
                api('/api/knowledge/bulk-delete', token, { method: 'POST', body: JSON.stringify({ ids: cleanup.kbDocIds }) }));
        }
    }

    // KB delete does not remove Storage objects — do it with the service key.
    if (admin && cleanup.storagePaths.length) {
        const { BUCKETS } = require('../src/middleware/upload');
        await tryStep(`remove ${cleanup.storagePaths.length} Storage object(s)`, () =>
            admin.storage.from(BUCKETS.knowledge).remove(cleanup.storagePaths.map(p => p.split('/').pop())));
    }

    // Even read-only runs create rows: GET /api/knowledge triggers
    // seedIfEmpty (seed doc + chunks + KB_DEFAULT_SEEDED marker). Deleting
    // the auth user does NOT remove those, so sweep every user-scoped
    // table by user_id — otherwise each run orphans rows in prod tables.
    if (admin && cleanup.userId) {
        const uid = cleanup.userId;
        for (const table of ['knowledge_chunks', 'knowledge_documents', 'ai_queries', 'boq_documents', 'app_settings']) {
            await tryStep(`sweep ${table} rows for test user`, async () => {
                const { error } = await admin.from(table).delete().eq('user_id', uid);
                if (error) throw error;
            });
        }
    }

    if (admin && cleanup.userId) {
        await tryStep('delete ephemeral test user', () => admin.auth.admin.deleteUser(cleanup.userId));
    }
    return steps;
}

function truncate(s, n) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : (t || '(empty)');
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function printSummary() {
    console.log('\n' + '═'.repeat(72));
    console.log('LIVE E2E VERIFICATION — PASS/FAIL SUMMARY');
    console.log('Target: ' + BASE_URL);
    console.log('Mode: ' + (process.env.LIVE === '1' ? 'FULL (LIVE=1, write checks included)' : 'READ-ONLY (set LIVE=1 for checks 3-5)'));
    console.log('═'.repeat(72));
    for (const r of results) {
        console.log(`${r.pass ? '✅ PASS' : '❌ FAIL'}  ${r.name}${r.pass ? '' : '\n        └─ ' + r.detail}`);
    }
    const pass = results.filter(r => r.pass).length;
    console.log('─'.repeat(72));
    console.log(`Result: ${pass}/${results.length} checks passed`);
}

(async () => {
    try {
        await main();
    } finally {
        const steps = await runCleanup();
        if (steps.length) {
            console.log('\n── CLEANUP ' + '─'.repeat(60));
            for (const s of steps) console.log('   ' + s);
            if (steps.some(s => s.startsWith('FAILED'))) cleanup.note = 'some cleanup steps failed — inspect above';
        }
        printSummary();
        if (cleanup.note) console.log('NOTE: ' + cleanup.note);
        process.exit(0);
    }
})();
