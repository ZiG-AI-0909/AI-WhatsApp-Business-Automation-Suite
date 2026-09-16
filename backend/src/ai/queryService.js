// =============================================================
// Ask AI — internal assistant for EMPLOYEES.
//
// Deliberately SEPARATE from the Knowledge Base and from the WhatsApp
// auto-reply flow (incomingMessageService.js):
//   - The Knowledge Base (knowledge_documents / knowledge_chunks) exists
//     to ground the CUSTOMER-FACING WhatsApp auto-reply only. Ask AI does
//     NOT read those tables — a user editing, corrupting, or emptying
//     their KB can never break or degrade this assistant.
//   - This assistant is an internal tool: it answers a team member's
//     questions about USING THE PLATFORM and about the COMPANY, from
//     built-in, code-owned knowledge (builtInKnowledge.js), and reports
//     exactly WHICH guide sections the answer drew from.
//
// Retrieval is synchronous and database-free: the happy path makes zero
// DB reads, so a missing/corrupted KB or a failed maintenance pass can
// never produce an HTTP 500 ("Something went wrong") from this feature.
// =============================================================
const db = require('../database/db');
const { resolveAiConfig } = require('../utils/aiConfig');
const { retrieveBuiltInSources } = require('./builtInKnowledge');

// ─── Conversational chat ──────────────────────────────────────
// The chat endpoint keeps MULTI-TURN context: the client replays the
// recent conversation with every request, so the server stays stateless
// (no new tables) and the same per-user credential + citation rules
// apply to every turn.
const MAX_HISTORY_MESSAGES = 12;

/** Keep only the last few clean user/assistant turns from the client. */
function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_HISTORY_MESSAGES)
        .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 2000) }))
        .filter((m) => m.content);
}

function buildChatPrompt(message, sources, history, websiteContext = '') {
    const context = sources
        .map(s => `[${s.docName}]\n${s.content}`)
        .join('\n\n---\n\n');
    const conversation = history.length
        ? history.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n') + '\n\n'
        : '';
    const websiteBlock = websiteContext
        ? `\nCOMPANY WEBSITE (sudarshanpipes.com) — current public information; use ONLY when the guides above do not answer the question, and attribute the answer to "the company website":\n${websiteContext}\n`
        : '';
    return `You are the built-in assistant inside the Sudarshan Pipes WhatsApp automation platform. You are chatting with a logged-in team member (never a customer) and help with THREE kinds of questions:\n1. How-to questions about using THIS platform — answer from the platform guide below and point them to the right page or tool (WhatsApp Connection, Inbox, Campaigns, Contacts, Templates, Knowledge Base, Ask AI, Document Intelligence, Image Extractor, Analytics, Settings).\n2. Company questions — answer from the company profile below.\n3. Company questions the built-in guides do not cover — when COMPANY WEBSITE content is provided below, answer from it and attribute it to "the company website".\n\nRules:\n- Ground every fact in the guides or website text below; never invent specifications, prices, or features.\n- When a fact comes from a built-in guide, cite it in square brackets, e.g. [Platform Guide (built-in)].\n- When COMPANY WEBSITE text is provided below and you use it, you MUST say the answer comes from the company website (write "the company website" in the answer).\n- If neither the guides nor the website text covers it, say so plainly instead of guessing, and suggest what to do or where to look.\n- Be conversational and brief (2-6 sentences); use short numbered steps when the user asks how to do something.\n- Continue the conversation naturally: "it", "that", or "also" refer to what came before.\n${websiteBlock}\nCONVERSATION SO FAR:\n${conversation}BUILT-IN GUIDES:\n${context || '(no matching sections)'}\n\nMESSAGE: ${message}`;
}

/**
 * Conversational turn. Retrieval runs over the current message PLUS the
 * recent user turns (so "how about bulk sends?" still finds the campaign
 * section). Each turn persists as one ai_queries row when the table is
 * reachable — history is best-effort and never blocks an answer.
 */
async function chat(userId, message, rawHistory = [], { maxChunks = 5 } = {}) {
    const trimmed = String(message || '').trim();
    if (!trimmed) throw new Error('Type a message first.');
    if (trimmed.length > 2000) throw new Error('Message is too long (max 2000 characters).');
    const history = sanitizeHistory(rawHistory);

    // Retrieval query: the current message with recent user turns folded
    // in, so pronoun-heavy follow-ups still retrieve the right section.
    const priorUserText = history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ');
    const sources = retrieveBuiltInSources(`${priorUserText} ${trimmed}`.trim(), maxChunks);

    // Fallback order: built-in guides first; when they have no match for a
    // COMPANY question, fall back to the company website (cached, capped)
    // instead of refusing — clearly labeled so the model can attribute the
    // answer to the website rather than fake-cite a guide. Platform how-to
    // questions never touch the website.
    let websiteContext = '';
    if (sources.length === 0) {
        try {
            websiteContext = await require('./websiteContext').getWebsiteContext();
        } catch { /* never fail a chat turn on the website fetch */ }
        if (!websiteContext) {
            return {
                id: null,
                answer: "I couldn't find anything in my built-in guides about that. Try rephrasing — or for company-specific questions beyond the profile, check the company website. I'd rather say that than guess.",
                sources: [],
                stored: false,
            };
        }
    }

    const answer = await completeForUser(userId, buildChatPrompt(trimmed, sources, history, websiteContext), 'ask-ai chat');

    const usingWebsite = sources.length === 0 && !!websiteContext;
    const namedSources = usingWebsite
        ? [{ id: 'website', name: 'Company website (sudarshanpipes.com)' }]
        : sources.map((s) => ({ id: s.docName, name: s.docName, score: s.score }));
    const stored = await persistQuery(userId, trimmed, answer, usingWebsite ? ['Company website (sudarshanpipes.com)'] : namedSources.map((s) => s.name));

    return {
        id: stored ? stored.id : null,
        answer,
        sources: namedSources,
        stored: !!stored,
    };
}

/**
 * Ask the internal assistant a question. Retrieves from built-in
 * knowledge, generates an answer with the caller's AI credentials, and
 * persists the query (answer + sources) so it appears in history.
 */
async function ask(userId, question, { maxChunks = 5 } = {}) {
    const trimmed = String(question || '').trim();
    if (!trimmed) throw new Error('Type a question first.');
    if (trimmed.length > 2000) throw new Error('Question is too long (max 2000 characters).');

    const sources = retrieveBuiltInSources(trimmed, maxChunks);
    if (sources.length === 0) {
        // The honest no-match answer — no AI call, nothing stored.
        return {
            id: null,
            answer: "I couldn't find anything in my built-in guides about that. Try rephrasing — or for company-specific questions beyond the profile, check the company website. I'd rather say that than guess.",
            sources: [],
            stored: false,
        };
    }

    const prompt = `You are an internal assistant for the team. Answer the team member's question using ONLY the company knowledge below — it may cover how to use this platform OR the company profile. Never invent specifications, prices, or standards.\n\nRules:\n- When a fact comes from a guide section, mention the section name in square brackets, e.g. [Platform Guide (built-in)].\n- If the built-in guides do not contain the answer, say so plainly instead of guessing.\n- Keep the answer short and factual (2-6 sentences).\n\nCOMPANY KNOWLEDGE:\n${sources.map(s => `[${s.docName}]\n${s.content}`).join('\n\n---\n\n')}\n\nQUESTION: ${trimmed}`;

    const answer = await completeForUser(userId, prompt, 'ask-ai');

    // Persist so the user can revisit past questions. Sources are stored
    // as names, so history stays auditable. History is best-effort: a DB
    // problem never blocks an answer.
    const stored = await persistQuery(userId, trimmed, answer, sources.map(s => s.docName));

    return {
        id: stored ? stored.id : null,
        question: trimmed,
        answer,
        sources: sources.map(s => ({ id: s.docName, name: s.docName, score: s.score })),
        stored: !!stored,
    };
}

/**
 * Resolve AI credentials and run ONE completion. Same never-mix resolver
 * as before (a tenant-controlled base URL never receives the server's
 * own env key). ASK_AI_API_KEY (optionally ASK_AI_API_MODEL) is a
 * DEDICATED server override for this feature; a stored user key still
 * wins (tenant BYO beats server defaults).
 */
async function completeForUser(userId, prompt, logLabel) {
    let rows = {};
    try {
        rows = await loadUserSettings(userId);
    } catch { /* fall through with empty settings */ }
    const aiConfig = resolveAiConfig({
        storedKey: rows.AI_API_KEY,
        storedBaseURL: rows.AI_BASE_URL,
        envKey: (process.env.ASK_AI_API_KEY || '').trim() || process.env.AI_API_KEY,
        envBaseURL: process.env.AI_BASE_URL,
    });
    if (!aiConfig.apiKey) {
        throw new Error('AI is not configured. Set AI_API_KEY on the server or in Settings.');
    }
    const model = (rows.AI_MODEL || '').trim()
        || (process.env.ASK_AI_API_MODEL || '').trim()
        || (process.env.AI_MODEL || '').trim()
        || undefined;
    const aiService = require('./aiService');
    return aiService._complete(
        [{ role: 'user', content: prompt }],
        {
            apiKey: aiConfig.apiKey,
            baseURL: aiConfig.baseURL,
            model,
            temperature: 0.2,
            maxTokens: 600,
            // Short factual answers — no reasoning phase. Reasoning models
            // otherwise burn the token budget deliberating and can leak the
            // raw thinking process into the user-facing answer.
            reasoningEffort: 'none',
            logLabel,
        }
    );
}

/**
 * Best-effort history persistence. ai_queries is ONLY this feature's
 * history log — its availability must never block an answer, so any
 * storage failure (missing table after a deploy, RLS hiccup, …) degrades
 * to "not stored" instead of a 500 ("Something went wrong").
 */
async function persistQuery(userId, question, answer, sourceNames) {
    try {
        return await db.insert('ai_queries', {
            question,
            answer,
            source_doc_ids: JSON.stringify([]),
            source_doc_names: JSON.stringify(sourceNames),
            user_id: userId,
        });
    } catch (error) {
        console.warn(`[askAi] history not stored (non-fatal): ${error.message}`);
        return null;
    }
}

async function loadUserSettings(userId) {
    const settings = {};
    try {
        const rows = await db.select('app_settings', 'key, value', 'user_id = ?', [userId], '', 100, 0);
        const { decryptSettingIfSecret } = require('../utils/encryption');
        for (const row of rows) settings[row.key] = decryptSettingIfSecret(row.key, row.value);
    } catch (error) {
        console.error('[askAi] failed to load settings:', error.message);
    }
    return settings;
}

async function listHistory(userId, limit = 30) {
    const rows = await db.select(
        'ai_queries',
        'id, question, answer, source_doc_names, created_at',
        'user_id = ?',
        [userId],
        'created_at',
        limit,
        0
    );
    // Newest first for display.
    return rows.reverse().map(row => ({
        ...row,
        source_doc_names: parseJsonArray(row.source_doc_names),
    }));
}

async function deleteHistory(id, userId) {
    const deleted = await db.del('ai_queries', 'id = ? AND user_id = ?', [id, userId]);
    if (!deleted || deleted.length === 0) throw new Error('Query not found.');
    return true;
}

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

module.exports = {
    buildAnswerPrompt: (question, sources) => `COMPANY KNOWLEDGE:\n${sources.map(s => `[${s.docName}]\n${s.content}`).join('\n\n---\n\n')}\n\nQUESTION: ${question}`,
    ask,
    chat,
    sanitizeHistory,
    listHistory,
    deleteHistory,
};
