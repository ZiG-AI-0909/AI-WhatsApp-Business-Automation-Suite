// =============================================================
// Validation for campaign settings that change how messages are sent.
// Unknown keys pass through unchanged (older settings keep working);
// the keys below are clamped to safe ranges or rejected with a clear
// message instead of silently changing sending behaviour.
// =============================================================
const { parseJsonField } = require('../utils/jsonField');

// WhatsApp template names: lowercase letters, digits and underscores.
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
// Language codes as WhatsApp Manager shows them: en, en_US, pt_BR, zh_CN …
const TEMPLATE_LANGUAGE = /^[A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,4})?$/;
const MAX_TEMPLATE_PARAMS = 20;

function settingsError(message) {
    return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Normalise an approved-template setting:
 * { name, language, bodyParams: ['{{name}}', 'Diwali offer', …] }.
 * Returns null when no template is configured.
 */
function sanitizeTemplate(value, { strict = false } = {}) {
    const template = parseJsonField(value, value);
    if (!template || typeof template !== 'object') return null;
    const name = String(template.name || '').trim();
    if (!name) return null;
    if (!TEMPLATE_NAME.test(name)) {
        if (strict) throw settingsError('Template name may only contain lowercase letters, numbers and underscores, exactly as it appears in WhatsApp Manager.');
        return null;
    }
    const language = String(template.language || 'en').trim();
    if (!TEMPLATE_LANGUAGE.test(language)) {
        if (strict) throw settingsError('Template language must be a code such as en, en_US or hi.');
        return null;
    }
    // Blank lines from the editor are not variables.
    const params = (Array.isArray(template.bodyParams) ? template.bodyParams : [])
        .filter(param => String(param ?? '').trim() !== '');
    if (strict && params.length > MAX_TEMPLATE_PARAMS) throw settingsError(`A template can use at most ${MAX_TEMPLATE_PARAMS} variables.`);
    return {
        name,
        language,
        bodyParams: params.slice(0, MAX_TEMPLATE_PARAMS).map(param => String(param ?? '').slice(0, 1024)),
    };
}

function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

/** Validate the sending-safety keys of a campaign settings object. */
function sanitizeCampaignSettings(settings = {}) {
    const input = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
    const output = { ...input };
    if ('cooldownEvery' in input) output.cooldownEvery = Math.floor(clamp(input.cooldownEvery, 0, 1000, 0));
    if ('cooldownMinutes' in input) output.cooldownMinutes = clamp(input.cooldownMinutes, 1, 240, 10);
    if ('respectRecipientTimezone' in input) {
        output.respectRecipientTimezone = !(input.respectRecipientTimezone === false || input.respectRecipientTimezone === 'false');
    }
    if ('failureRatePauseThreshold' in input) output.failureRatePauseThreshold = clamp(input.failureRatePauseThreshold, 0, 1, 0.5);
    if ('unregisteredRatePauseThreshold' in input) output.unregisteredRatePauseThreshold = clamp(input.unregisteredRatePauseThreshold, 0, 1, 0.4);
    if ('waTemplate' in input) {
        const template = sanitizeTemplate(input.waTemplate, { strict: true });
        if (template) output.waTemplate = template;
        else delete output.waTemplate;
    }
    return output;
}

module.exports = { sanitizeTemplate, sanitizeCampaignSettings };
