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
function keyByUser(req) {
    return req.user?.id ? `u:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`;
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

// General authenticated mutations — coarse cost/cost-abuse backstop.
function mutationLimiter(req, res, next) { return _mutation(req, res, next); }
const _mutation = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    keyGenerator: keyByUser,
    ...json429('Too many requests. Slow down.'),
});

module.exports = { webhookLimiter, sendLimiter, aiExtractLimiter, mutationLimiter };
