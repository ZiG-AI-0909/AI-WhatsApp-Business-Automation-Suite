// =============================================================
// HTTP rate limiting — protects expensive/sensitive endpoints
// from brute force, scraping, and runaway cost amplification.
//
// Notes:
// - Auth is client-side Supabase (no server login endpoint exists),
//   so auth brute-force is absorbed by Supabase's own rate limits.
//   The unauthenticated surface we own is the Meta webhook, which
//   gets a tight limit (it should only ever hear from Meta).
// - AI auto-replies are triggered by incoming webhook messages and
//   cannot be invoked directly over HTTP; the webhook limit plus
//   image-extraction limits bound direct AI spend from HTTP.
// - Keys: user id for authenticated routes, IP for public ones.
// =============================================================
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Key by user id for authenticated requests; for anything unauthenticated
// (should only be the webhook), key by subnet-normalized IP so IPv6
// clients can't sidestep the limit by rotating within a /64.
// In a shared workspace req.user.id is the data owner; limits follow the
// signed-in person (authId) so a colleague neither uses up nor escapes the
// owner's budget.
function keyByUser(req) {
    const actor = req.user?.authId || req.user?.id;
    return actor ? `u:${actor}` : `ip:${ipKeyGenerator(req.ip)}`;
}
const json429 = (msg) => ({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: msg }),
});

// Meta webhook — public. Should only ever receive legitimate payloads.
function webhookLimiter(req, res, next) { return _webhook(req, res, next); }
const _webhook = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    ...json429('Too many webhook requests.'),
});

// Manual WhatsApp sends (conversations/:id/send) and session actions —
// each is a paid WhatsApp send or a session lifecycle operation.
function sendLimiter(req, res, next) { return _send(req, res, next); }
const _send = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    keyGenerator: keyByUser,
    ...json429('Too many send requests. Wait a moment and try again.'),
});

// AI image extraction — NVIDIA vision calls per upload; 20-file batches
// make this the most expensive authenticated endpoint per request.
function aiExtractLimiter(req, res, next) { return _aiExtract(req, res, next); }
const _aiExtract = rateLimit({
    windowMs: 5 * 60 * 1000,
    limit: 30,
    keyGenerator: keyByUser,
    ...json429('Image extraction limit reached. Try again in a few minutes.'),
});

// Text AI queries (Ask AI, copilot briefs) — one paid AI call per request;
// tighter than mutations but looser than image extraction.
function aiQueryLimiter(req, res, next) { return _aiQuery(req, res, next); }
const _aiQuery = rateLimit({
    windowMs: 60 * 1000,
    limit: 15,
    keyGenerator: keyByUser,
    ...json429('AI query limit reached. Wait a minute and try again.'),
});

// General authenticated mutations — coarse cost/cost-abuse backstop.
function mutationLimiter(req, res, next) { return _mutation(req, res, next); }
const _mutation = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    keyGenerator: keyByUser,
    ...json429('Too many requests. Slow down.'),
});

// Public vendor KYC form — no auth, up to 35 MB of uploads per request, so
// it is keyed by IP and kept tight. A vendor normally submits once; the
// allowance covers retries after validation errors and a shared office IP.
function kycSubmitLimiter(req, res, next) { return _kycSubmit(req, res, next); }
const _kycSubmit = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: Number(process.env.KYC_SUBMIT_LIMIT_PER_HOUR || 10),
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip)}`,
    ...json429('Too many form submissions from this network. Please try again in an hour.'),
});

module.exports = { webhookLimiter, sendLimiter, aiExtractLimiter, aiQueryLimiter, mutationLimiter, kycSubmitLimiter };
