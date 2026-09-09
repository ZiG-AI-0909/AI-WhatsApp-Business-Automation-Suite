// Shared CORS origin policy for Express and Socket.IO.
// - Two fixed production Vercel domains.
// - Any Vercel preview deployment matching the project's slug pattern.
// - Local Vite dev server.
const ALLOWED_ORIGINS = [
    'https://ai-whats-app-business-automation-suite-zig-ai-0909s-projects.vercel.app',
    'https://ai-whats-app-business-automation-su-theta.vercel.app',
    'http://localhost:5173',
];
const VERCEL_PREVIEW_REGEX = new RegExp('^(https://ai-[a-z0-9-]+-whats-app-business-automation-suite-zig-ai-0909s-projects\\.vercel\\.app)$');

function isAllowedOrigin(origin) {
    // No Origin header = same-origin or non-browser client (curl, health checks, etc.).
    // Allow it through so public endpoints like /api/health work without a browser.
    if (!origin) return true;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    return VERCEL_PREVIEW_REGEX.test(origin);
}

module.exports = { ALLOWED_ORIGINS, VERCEL_PREVIEW_REGEX, isAllowedOrigin };
