require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });
const axios = require('axios');

/**
 * AIService — Provider-agnostic AI abstraction.
 * Reads AI_API_KEY, AI_BASE_URL, AI_MODEL from environment.
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
     * Core completion — internal, used by all public methods.
     */
    async _complete(messages, options = {}) {
        if (!this.apiKey) throw new Error('AI_API_KEY is not configured.');

        const payload = {
            model: this.model,
            messages,
            temperature: options.temperature ?? 0.7,
            top_p: options.topP ?? 0.95,
            max_tokens: options.maxTokens ?? 800,
        };

        if (this.model === 'deepseek-ai/deepseek-v4-flash-0731') {
            payload.chat_template_kwargs = {
                thinking: true,
                reasoning_effort: options.reasoningEffort || 'high',
            };
        }

        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                const response = await axios.post(
                    `${this.baseURL}/chat/completions`,
                    payload,
                    {
                        headers: {
                            Authorization: `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                        },
                        timeout: 30000,
                    }
                );
                return response.data.choices[0].message.content.trim();
            } catch (error) {
                const isLast = attempt === this.maxRetries - 1;
                if (isLast) {
                    const providerDetail = error.response?.data?.detail || error.response?.data?.error?.message;
                    if (providerDetail) {
                        throw new Error(`NVIDIA AI provider error: ${providerDetail}`);
                    }
                    throw error;
                }
                await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
            }
        }
    }

    /**
     * Generate a customer-facing reply for an incoming WhatsApp message.
     * @param {string} systemPrompt - Business-specific system prompt
     * @param {Array} conversationHistory - [{role, content}]
     * @returns {string} AI reply
     */
    async generateReply(systemPrompt, conversationHistory) {
        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
        ];
        return this._complete(messages, { temperature: 0.8, maxTokens: 600 });
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
