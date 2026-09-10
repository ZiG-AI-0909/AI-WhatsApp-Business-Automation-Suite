// =============================================================
// Per-user AI credential resolution — never-mix guarantee.
//
// SECURITY: a tenant-controlled AI_BASE_URL must never be combined
// with the SERVER's own env-level AI_API_KEY. A malicious tenant
// could point their base URL at infrastructure they control and
// steal the shared server key out of the Authorization header.
//
// resolveAiConfig() therefore only ever pairs credentials that
// belong together:
//   - tenant API key + tenant base URL  (tenant's own provider)
//   - env API key  + env base URL       (server defaults)
// If a tenant sets a custom base URL WITHOUT their own API key, the
// env key is never sent to that URL: the request falls back to the
// env base URL (or the built-in NVIDIA default) so it stays with the
// server's own provider. `customURLIgnored` lets callers surface a
// hint that the custom URL was ignored.
// =============================================================

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/**
 * @param {object} input
 * @param {string} input.storedKey - tenant's own AI_API_KEY from app_settings
 * @param {string} input.storedBaseURL - tenant's AI_BASE_URL from app_settings
 * @param {string} input.envKey - server-level AI_API_KEY from process.env
 * @param {string} input.envBaseURL - server-level AI_BASE_URL from process.env
 * @returns {{ apiKey: string, baseURL: string, usingCustomProvider: boolean, customURLIgnored: boolean }}
 */
function resolveAiConfig({ storedKey = '', storedBaseURL = '', envKey = '', envBaseURL = '' } = {}) {
    const userKey = (storedKey || '').trim();
    const userURL = (storedBaseURL || '').trim();
    const serverKey = (envKey || '').trim();
    const serverURL = (envBaseURL || '').trim();

    // Tenant configured their own key → their credentials win wholesale.
    // A custom URL is safe here because it only ever receives the
    // tenant's OWN key.
    if (userKey) {
        return {
            apiKey: userKey,
            baseURL: userURL || serverURL || DEFAULT_BASE_URL,
            usingCustomProvider: Boolean(userURL),
            customURLIgnored: false,
        };
    }

    // No tenant key → the server's key may only talk to the server's own
    // endpoint, never a tenant-supplied URL.
    return {
        apiKey: serverKey,
        baseURL: serverURL || DEFAULT_BASE_URL,
        usingCustomProvider: false,
        customURLIgnored: Boolean(userURL),
    };
}

module.exports = { resolveAiConfig, DEFAULT_BASE_URL };
