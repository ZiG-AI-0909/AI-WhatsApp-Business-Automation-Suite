// =============================================================
// Salesperson Copilot — on-demand brief for a contact/conversation.
//
// DATA HONESTY (important): this system has NO quotations or deals
// data structure. The brief is built ONLY from data that exists:
//   - contact fields: name, company, city, email, tags, notes,
//     marketing opt-in, last message timestamp
//   - the contact's own WhatsApp conversation messages
// Any "products discussed" come from reading the message history —
// they are conversation mentions, NOT quotation records, and the
// brief labels them that way. Nothing is fabricated.
//
// Generation is on-demand (a button in the UI), not automatic, to
// control AI API cost. The deterministic summary works with no AI
// key configured; the AI narration step is additive.
// =============================================================
const db = require('../database/db');

const PRODUCT_MENTIONS = [
    'hdpe', 'upvc', 'pvc', 'cpvc', 'pipe', 'pipes', 'fitting', 'fittings',
    'elbow', 'tee', 'coupler', 'valve', 'bend', 'clamp', 'duct', 'casing',
    'gi pipe', 'ductile iron', 'swr', 'casing pipe',
];

const SIZE_PATTERN = /\b\d{1,4}(?:\.\d+)?\s*(?:mm|inch|inches|in|dn\s?\d{2,3}|"\b)\b/gi;

function parseTags(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Load the contact + their conversation messages for one user.
 * Returns null when the contact does not belong to this user.
 */
async function loadContext(userId, { contactId = null, conversationId = null } = {}) {
    let contact = null;
    if (contactId) {
        contact = await db.getById('contacts', contactId, userId);
    } else if (conversationId) {
        const conv = await db.getById('conversations', conversationId, userId);
        if (!conv) return null;
        contact = await db.getById('contacts', conv.contact_id, userId);
        if (contact) contact._conversation_id = conv.id;
    }
    if (!contact) return null;

    const contactIdNum = contact.id;
    // Messages only from THIS user's conversations with THIS contact.
    const conversations = await db.select(
        'conversations',
        'id, contact_id, status, ai_enabled, last_message_at, unread_count',
        'user_id = ? AND contact_id = ?',
        [userId, contactIdNum],
        'last_message_at',
        10,
        0
    );
    let messages = [];
    if (conversations.length > 0) {
        const convIds = conversations.map((c) => c.id);
        messages = await db.select(
            'messages',
            'conversation_id, direction, body, status, created_at',
            'user_id = ? AND conversation_id IN (?)',
            [userId, convIds],
            'created_at',
            100,
            0
        );
    }
    return { contact, conversations, messages };
}

/**
 * Deterministic, data-grounded brief sections. Never calls the AI.
 */
function buildBrief(context) {
    const { contact, conversations, messages } = context;
    const inbound = messages.filter((m) => m.direction === 'inbound');
    const outbound = messages.filter((m) => m.direction === 'outbound');

    // Products/pipe keywords actually mentioned in the message history.
    const mentionCounts = new Map();
    const sizeMentions = new Set();
    for (const message of messages) {
        const text = String(message.body || '').toLowerCase();
        for (const term of PRODUCT_MENTIONS) {
            if (text.includes(term)) mentionCounts.set(term, (mentionCounts.get(term) || 0) + 1);
        }
        const sizes = String(message.body || '').match(SIZE_PATTERN) || [];
        for (const size of sizes) sizeMentions.add(size.trim().toLowerCase());
    }
    const productsDiscussed = [...mentionCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([term, count]) => `${term} (${count} mention${count === 1 ? '' : 's'})`);

    // Open questions from the customer: their latest inbound messages that
    // look like questions, newest first.
    const openQuestions = inbound
        .filter((m) => /\?/.test(m.body || '') || /(price|quote|rate|available|stock|delivery|share|send|cost)/i.test(m.body || ''))
        .slice(-4)
        .reverse()
        .map((m) => String(m.body || '').trim().slice(0, 160));

    const lastActivity = messages.length > 0
        ? messages[messages.length - 1]
        : null;
    const waitingOnCustomer = lastActivity?.direction === 'outbound';

    return {
        contact: {
            id: contact.id,
            name: contact.name || '',
            phone: contact.phone,
            company: contact.company || '',
            city: contact.city || '',
            email: contact.email || null,
            tags: parseTags(contact.tags),
            notes: contact.notes || '',
            marketing_opt_in: !!contact.marketing_opt_in,
            last_message_at: contact.last_message_at || null,
        },
        conversation_summary: summarizeMessages(messages),
        conversation_stats: {
            total_messages: messages.length,
            inbound: inbound.length,
            outbound: outbound.length,
            conversation_count: conversations.length,
            conversation_status: conversations[0]?.status || 'none',
            last_direction: lastActivity?.direction || null,
            waiting_on_customer: waitingOnCustomer,
            last_message_at: lastActivity?.created_at || null,
        },
        // Labelled honestly: these are mentions in WhatsApp chat history,
        // NOT quotation/deal records (this system has no quotations data).
        products_discussed_from_chat: productsDiscussed,
        sizes_mentioned_in_chat: [...sizeMentions].slice(0, 8),
        suggested_talking_points: buildTalkingPoints(contact, { waitingOnCustomer, openQuestions, productsDiscussed, inboundCount: inbound.length, outboundCount: outbound.length, tags: parseTags(contact.tags) }),
        open_questions_from_customer: openQuestions,
        data_sources: ['contact fields', 'contact notes/tags', 'WhatsApp conversation history'],
    };
}

function summarizeMessages(messages) {
    if (messages.length === 0) {
        return 'No WhatsApp messages exchanged with this contact yet.';
    }
    const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
    const lastOutbound = [...messages].reverse().find((m) => m.direction === 'outbound');
    const parts = [];
    parts.push(`${messages.length} messages exchanged so far.`);
    if (lastOutbound) parts.push(`You last said: "${trim(lastOutbound.body)}"`);
    if (lastInbound) parts.push(`Their latest reply: "${trim(lastInbound.body)}"`);
    const endsWithCustomer = messages[messages.length - 1].direction === 'inbound';
    parts.push(endsWithCustomer
        ? 'The conversation currently waits on YOUR reply.'
        : 'The conversation currently waits on the customer.');
    return parts.join(' ');
}

function trim(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

function buildTalkingPoints(contact, { waitingOnCustomer, openQuestions, productsDiscussed, inboundCount, outboundCount, tags }) {
    const points = [];
    if (openQuestions.length > 0) {
        points.push('Answer the customer\'s outstanding questions before anything else — see the open questions list.');
    } else if (waitingOnCustomer) {
        points.push('You sent the last message — follow up politely if there has been no reply.');
    } else if (inboundCount > 0) {
        points.push('Check their latest message and reply — the ball is in your court.');
    }
    if (productsDiscussed.length > 0) {
        points.push(`Steer the chat toward what they already mentioned in WhatsApp (${productsDiscussed.slice(0, 3).join(', ')}) — these are chat mentions, not quotations.`);
    }
    if (contact.company) points.push(`Reference their business (${contact.company})${contact.city ? ` in ${contact.city}` : ''} to personalize the pitch.`);
    for (const tag of tags.slice(0, 3)) {
        points.push(`Contact is tagged "${tag}" — align the pitch with what that tag means for your pipeline.`);
    }
    if (contact.notes) {
        points.push('Re-read the contact notes before calling — they contain context you (or a colleague) saved earlier.');
    }
    if (inboundCount === 0 && outboundCount === 0) {
        points.push('No conversation history yet: open with their requirement, quantity, and delivery location.');
    }
    if (contact.marketing_opt_in === false) {
        points.push('This contact opted out of marketing — keep the conversation strictly to their own enquiries.');
    }
    return points.slice(0, 6);
}

/**
 * Optional AI narration on top of the deterministic brief. Returns null
 * when no AI key is configured (the deterministic brief is still complete
 * and useful without it).
 */
async function narrate(userId, brief) {
    const settings = {};
    try {
        const rows = await db.select('app_settings', 'key, value', 'user_id = ?', [userId], '', 100, 0);
        const { decryptSettingIfSecret } = require('../utils/encryption');
        for (const row of rows) settings[row.key] = decryptSettingIfSecret(row.key, row.value);
    } catch {
        // Settings unavailable → fall back to env resolution below.
    }
    const { resolveAiConfig } = require('../utils/aiConfig');
    const aiConfig = resolveAiConfig({
        storedKey: settings.AI_API_KEY,
        storedBaseURL: settings.AI_BASE_URL,
        envKey: process.env.AI_API_KEY,
        envBaseURL: process.env.AI_BASE_URL,
    });
    if (!aiConfig.apiKey) return null;

    const prompt = `You are briefing a salesperson 60 seconds before they contact a customer. Using ONLY the facts below (do not invent quotations, deals, prices, or history — this system has no quotation records), write a short brief in plain prose.

RULES:
- Reference WhatsApp chat mentions as "mentioned in chat", never as quotes or orders.
- Keep it under 120 words.
- End with the single most important next step.

FACTS:
${JSON.stringify({
        contact: brief.contact,
        stats: brief.conversation_stats,
        chat_summary: brief.conversation_summary,
        products_mentioned_in_chat: brief.products_discussed_from_chat,
        open_questions: brief.open_questions_from_customer,
        notes: brief.contact.notes,
        tags: brief.contact.tags,
    }, null, 2)}`;

    try {
        const aiService = require('../ai/aiService');
        return await aiService._complete(
            [{ role: 'user', content: prompt }],
            {
                apiKey: aiConfig.apiKey,
                baseURL: aiConfig.baseURL,
                model: settings.AI_MODEL || process.env.AI_MODEL,
                temperature: 0.4,
                maxTokens: 350,
            }
        );
    } catch (error) {
        console.error('[copilot] narration failed, returning deterministic brief:', error.message);
        return null;
    }
}

/**
 * Full on-demand brief: deterministic sections + optional AI narration.
 */
async function brief(userId, { contactId = null, conversationId = null, narrative = true } = {}) {
    const context = await loadContext(userId, { contactId, conversationId });
    if (!context) return null;
    const data = buildBrief(context);
    const aiSummary = narrative ? await narrate(userId, data) : null;
    return {
        ...data,
        ai_summary: aiSummary,
        ai_summary_available: aiSummary !== null,
        generated_at: new Date().toISOString(),
    };
}

module.exports = {
    loadContext,
    buildBrief,
    buildTalkingPoints,
    summarizeMessages,
    narrate,
    brief,
    PRODUCT_MENTIONS,
    SIZE_PATTERN,
};
