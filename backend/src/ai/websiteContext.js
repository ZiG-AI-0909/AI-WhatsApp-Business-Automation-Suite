// =============================================================
// Website fallback context for Ask AI chat.
//
// When the Knowledge Base has no match for a chat message, the assistant
// may ground its answer in the company website instead of refusing. The
// site text is fetched once, stripped to plain text, capped, and cached
// in-process (TTL) so a conversation doesn't hammer the website.
//
// Never throws: a website outage degrades to the honest "not in the
// Knowledge Base" answer rather than failing the chat turn.
// =============================================================

const WEBSITE_URL = 'https://www.sudarshanpipes.com';
const FETCH_TIMEOUT_MS = 8000;
const MAX_TEXT_CHARS = 6000;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let cache = { text: null, fetchedAt: 0 };

function stripHtml(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Fetch (or reuse cached) website text. Resolves to '' on any failure.
 * ASK_AI_WEBSITE_URL env override exists for tests and staging.
 */
async function getWebsiteContext() {
    const url = (process.env.ASK_AI_WEBSITE_URL || WEBSITE_URL).trim();
    if (cache.text && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.text;
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'SudarshanPipes-Assistant/1.0 (internal assistant)' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            redirect: 'follow',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = stripHtml(await response.text()).slice(0, MAX_TEXT_CHARS);
        if (text) {
            cache = { text, fetchedAt: Date.now() };
            console.log(`[askAi] website context fetched (${text.length} chars) from ${url}`);
        }
    } catch (error) {
        console.warn(`[askAi] website context unavailable (${error.message}) — chat falls back to KB-only`);
    }
    return cache.text || '';
}

/** Test hook: drop the cached page so a fetch actually happens. */
function _resetCache() {
    cache = { text: null, fetchedAt: 0 };
}

module.exports = { getWebsiteContext, stripHtml, _resetCache, WEBSITE_URL, MAX_TEXT_CHARS };
