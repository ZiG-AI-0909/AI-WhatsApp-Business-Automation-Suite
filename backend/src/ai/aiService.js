// NOTE: env vars are loaded once by src/server.js from backend/.env —
// do not add a dotenv.config() here.
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Note: settings.json is no longer used (doesn't survive Render free tier restarts).
// AI settings now persist in Supabase app_settings table.
// The settings.js route handles reading/writing to Supabase and updating process.env.
// This is called on application startup to load any persisted settings.

/**
 * AIService — Provider-agnostic AI abstraction.
 * Reads AI_API_KEY, AI_BASE_URL, AI_MODEL from environment (or settings.json).
 * Uses OpenAI-compatible chat completions API.
 */
class AIService {
    constructor() {
        this.apiKey = process.env.AI_API_KEY;
        this.baseURL = process.env.AI_BASE_URL || 'https://integrate.api.nvidia.com/v1';
        this.model = process.env.AI_MODEL || 'deepseek-ai/deepseek-v4-flash-0731';
        this.maxRetries = 3;

        if (!this.apiKey) {
            console.warn('⚠️  AI_API_KEY not set. AI features will be disabled.');
        }
    }

    isAvailable() {
        return !!this.apiKey;
    }

    reconfigure() {
        this.apiKey = process.env.AI_API_KEY;
        this.baseURL = process.env.AI_BASE_URL || this.baseURL;
        this.model = process.env.AI_MODEL || this.model;
    }

    getModel() {
        return this.model;
    }

        /**
     * Retryability of a failed provider attempt. Transient = worth a second
     * try: aborts/timeouts and socket-level breaks, HTTP 429, HTTP 5xx.
     * A 400/401/403 or any other provider verdict is permanent.
     */
    _classifyProviderError(error) {
        const status = error?.response?.status || null;
        const code = error?.code || '';
        const transientNetworkCodes = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN'];
        if (status) {
            return {
                kind: 'provider',
                transient: status === 429 || status >= 500,
                status,
            };
        }
        const socketHangup = /socket hang up/i.test(error?.message || '');
        if (code === 'ECONNABORTED') return { kind: 'timeout', transient: true, status: null };
        if (transientNetworkCodes.includes(code) || socketHangup) return { kind: 'network', transient: true, status: null };
        return { kind: 'unknown', transient: false, status: null };
    }

    /**
     * Host of a base URL for LOGGING ONLY — never the key, never the
     * authorization header. Unparseable URLs degrade to a marker.
     */
    _hostOf(baseURL) {
        const raw = String(baseURL || '');
        try {
            return new URL(raw).host;
        } catch {
            try { return new URL(`https://${raw.replace(/^\/+/, '')}`).host; } catch { return 'unparseable-host'; }
        }
    }

    /**
     * Thinking-suppression capability routing. 'none' must reach any model
     * family that can honour it — not one hardcoded model id.
     *
     * Two mechanisms exist in the wild:
     *   - deepseek/qwen/glm/nemotron style: chat_template_kwargs.thinking
     *   - gpt-oss style: TOP-LEVEL OpenAI reasoning_effort (low|medium|high;
     *     there is no true "off" — 'none' maps to the minimum)
     * AI_SUPPORTS_THINKING_KWARGS=true forces the template-kwarg path,
     * =false disables suppression entirely (gateways that reject the kwarg).
     */
    _applyReasoningSuppression(payload, model, effort) {
        const flag = String(process.env.AI_SUPPORTS_THINKING_KWARGS || '').trim().toLowerCase();
        if (flag === 'false') return;
        const m = String(model || '').toLowerCase();
        if (flag === 'true' || /deepseek|qwen|glm|nemotron/.test(m)) {
            // COHERENT pairs only: 'none' sends thinking:false and NO
            // reasoning_effort value (the old thinking:false +
            // reasoning_effort:'low' mix was contradictory — some templates
            // honoured the effort and kept deliberating).
            if (effort === 'none') {
                payload.chat_template_kwargs = { thinking: false };
            } else {
                payload.chat_template_kwargs = { thinking: true, reasoning_effort: effort || 'high' };
            }
            return;
        }
        if (m.includes('gpt-oss')) {
            payload.reasoning_effort = effort === 'none' ? 'low' : (effort || 'medium');
        }
    }

    /**
     * Core completion — internal, used by all public methods.
     *
     * options.retries counts RETRIES AFTER the first attempt (0 = single
     * attempt, 1 = one retry, …). Callers that do not pass it keep the
     * historical 3-attempt default. Long flows pass a deadlineMs wall-clock
     * budget: per-attempt timeouts are clamped inside it and a retry is
     * only made when the remaining budget can still fund a usable attempt.
     */
    async _complete(messages, options = {}) {
        // Per-call credentials override instance defaults so each user's
        // own AI key/model/base URL is used for their conversations.
        const apiKey = options.apiKey || this.apiKey;
        const model = options.model || this.model;
        const baseURL = options.baseURL || this.baseURL;
        if (!apiKey) throw new Error('AI_API_KEY is not configured.');

        const retries = options.retries != null
            ? Math.max(0, Number(options.retries) || 0)
            : this.maxRetries - 1;
        const maxAttempts = retries + 1;
        const timeoutMs = Number(options.timeoutMs) || 30000;
        const deadlineMs = Number(options.deadlineMs) || 0;
        // Floor: never start an attempt (or a retry) that cannot get at
        // least this much of the remaining budget — a doomed 100ms call
        // would just burn the tail of the budget for nothing.
        const minAttemptMs = Math.max(1, Number(options.minAttemptMs) || 1000);
        const logLabel = options.logLabel || '';
        const promptChars = messages.reduce((n, m) => n + String(m?.content || '').length, 0);

        const payload = {
            model,
            messages,
            temperature: options.temperature ?? 0.7,
            top_p: options.topP ?? 0.95,
            max_tokens: options.maxTokens ?? 800,
        };

        // Reasoning-capable models burn the token budget on thinking when
        // asked for raw JSON. The pair must be COHERENT: reasoningEffort
        // 'none' sends thinking:false and NO reasoning_effort value (the old
        // thinking:false + reasoning_effort:'low' mix was contradictory —
        // some templates honoured the effort and kept deliberating). Any
        // explicit effort value turns thinking ON at that effort; chat
        // paths stay 'high' as before.
        if (options.reasoningEffort) {
            this._applyReasoningSuppression(payload, model, options.reasoningEffort);
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const attemptStart = Date.now();
            // Fit inside the caller's wall-clock budget when one is set.
            let attemptTimeout = timeoutMs;
            if (deadlineMs) {
                attemptTimeout = Math.min(attemptTimeout, Math.max(100, deadlineMs - attemptStart));
            }
            try {
                const response = await axios.post(
                    `${baseURL}/chat/completions`,
                    payload,
                    {
                        headers: {
                            Authorization: `Bearer ${apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        timeout: attemptTimeout,
                    }
                );
                const content = response.data?.choices?.[0]?.message?.content;
                if (typeof content !== 'string') {
                    const shapeError = new Error('AI provider returned an unexpected response shape (no message content).');
                    shapeError.aiKind = 'provider';
                    throw shapeError;
                }
                const requestId = response.headers?.['x-request-id'] || response.headers?.['x-bb-request-id'] || response.data?.id || '';
                if (logLabel) {
                    console.log(`[ai] ${logLabel} attempt ${attempt}/${maxAttempts} OK — HTTP ${response.status} in ${Date.now() - attemptStart}ms, model ${model}, host ${this._hostOf(baseURL)}, chars-in ${promptChars}, chars-out ${content.length}${requestId ? `, req-id ${requestId}` : ''}`);
                }
                return content.trim();
            } catch (error) {
                // The shape guard above throws its own classified error;
                // everything else comes from axios and is classified here.
                const info = error.aiKind === 'provider'
                    ? { kind: 'provider', transient: false, status: null }
                    : this._classifyProviderError(error);
                const elapsed = Date.now() - attemptStart;
                const providerStatus = info.status || error?.response?.status || null;
                const requestId = error?.response?.headers?.['x-request-id'] || error?.response?.headers?.['x-bb-request-id'] || error?.response?.data?.id || '';

                if (logLabel) {
                    const outcome = info.kind === 'timeout' ? 'TIMEOUT' : info.kind === 'network' ? 'NETWORK' : info.transient ? 'PROVIDER-RETRYABLE' : 'PROVIDER';
                    console.error(`[ai] ${logLabel} attempt ${attempt}/${maxAttempts} FAILED in ${elapsed}ms — ${outcome}${providerStatus ? ` HTTP ${providerStatus}` : ''} (model ${model}, host ${this._hostOf(baseURL)}${requestId ? `, req-id ${requestId}` : ''}): ${error.message}`);
                }
                // Provider error bodies go to the log, truncated — they carry
                // the real verdict (quota, model name, template problems).
                const providerBody = error?.response?.data != null ? JSON.stringify(error.response.data).slice(0, 500) : '';
                if (logLabel && providerBody) {
                    console.error(`[ai] ${logLabel} provider response body: ${providerBody}`);
                }

                const isLast = attempt === maxAttempts;
                const remaining = deadlineMs ? deadlineMs - Date.now() : Infinity;
                // No retry when: attempts exhausted, the failure is
                // permanent (400/401/403/unparseable), or the remaining
                // budget cannot fund a usable attempt (per-call floor).
                if (isLast || !info.transient || remaining < minAttemptMs) {
                    if (info.kind === 'provider' && providerStatus) {
                        // Surface the provider's own verdict, not axios's
                        // generic "Request failed with status code N".
                        const detail = error?.response?.data?.detail
                            || error?.response?.data?.error?.message
                            || (typeof error?.response?.data?.message === 'string' ? error.response.data.message : '')
                            || '';
                        if (detail) error.message = `AI provider error (HTTP ${providerStatus}): ${String(detail).slice(0, 300)}`;
                        else if (!providerBody) error.message = `AI provider error (HTTP ${providerStatus}).`;
                    }
                    if (info.kind === 'timeout' && !/timed out/i.test(error.message)) {
                        error.message = `AI provider timed out after ${Math.round(elapsed / 1000)}s.`;
                    }
                    if (info.kind === 'network') {
                        error.message = `AI provider connection failed (${error.message}).`;
                    }
                    error.aiKind = info.kind;
                    error.providerStatus = providerStatus;
                    error.providerRequestId = requestId;
                    error.providerBody = providerBody;
                    error.attempts = attempt;
                    throw error;
                }
                // Short jittered backoff when a deadline is in play (the
                // remaining budget is precious); legacy exponential backoff
                // otherwise (1s, 2s — same as the historical loop).
                const backoff = deadlineMs
                    ? Math.min(Math.max(200, remaining - minAttemptMs), 300 + Math.floor(Math.random() * 400))
                    : 1000 * Math.pow(2, attempt - 1);
                await new Promise((r) => setTimeout(r, backoff));
            }
        }
    }

    /**
     * Generate a customer-facing reply for an incoming WhatsApp message.
     * @param {string} systemPrompt - Business-specific system prompt
     * @param {Array} conversationHistory - [{role, content}]
     * @returns {string} AI reply
     */
    async generateReply(systemPrompt, conversationHistory, options = {}) {
        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
        ];
        return this._complete(messages, { temperature: 0.8, maxTokens: 600, ...options });
    }

    /**
     * Classify the intent of an incoming message.
     * @param {string} message
     * @returns {'product_query'|'quotation_request'|'human_request'|'opt_out'|'general'}
     */
    async classifyIntent(message) {
        const prompt = `Classify this WhatsApp message into exactly one of these categories:
- product_query: asking about specific products, sizes, specifications, availability
- quotation_request: asking for price, quote, cost, rate, estimate
- human_request: explicitly asking to talk to a person, agent, salesperson, or requesting a call
- opt_out: asking to stop messages, unsubscribe, remove from list
- general: greeting, general inquiry, or anything else

Message: "${message}"

Reply with ONLY the category name, nothing else.`;

        try {
            const result = await this._complete(
                [{ role: 'user', content: prompt }],
                { temperature: 0.1, maxTokens: 20 }
            );
            const valid = ['product_query', 'quotation_request', 'human_request', 'opt_out', 'general'];
            const clean = result.toLowerCase().trim();
            return valid.find(v => clean.includes(v)) || 'general';
        } catch {
            return 'general';
        }
    }

    /**
     * Extract product requirements from a conversation.
     * @param {Array} conversationHistory
     * @returns {object} {product, size, quantity, location, company, project}
     */
    async extractRequirements(conversationHistory) {
        const history = conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n');
        const prompt = `Extract product requirements from this conversation. Return ONLY valid JSON:
{
  "product": "",
  "size": "",
  "quantity": "",
  "location": "",
  "company": "",
  "project": ""
}
Only fill fields where you found actual information. Leave empty string if not found.

Conversation:
${history}`;

        try {
            const result = await this._complete(
                [{ role: 'user', content: prompt }],
                { temperature: 0.1, maxTokens: 300 }
            );
            const match = result.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
        } catch {}
        return {};
    }

    /**
     * Summarize a conversation in 1-2 sentences.
     * @param {Array} conversationHistory
     * @returns {string}
     */
    async summarize(conversationHistory) {
        const history = conversationHistory.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n');
        const prompt = `Summarize this WhatsApp business conversation in 1-2 sentences:\n\n${history}`;
        try {
            return await this._complete(
                [{ role: 'user', content: prompt }],
                { temperature: 0.3, maxTokens: 150 }
            );
        } catch {
            return 'Conversation summary unavailable.';
        }
    }
}

module.exports = new AIService();
