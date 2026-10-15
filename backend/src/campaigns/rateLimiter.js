/**
 * RateLimiter — Controls sending speed and business hours.
 * Does NOT simulate human typing to deceive WhatsApp.
 * Exists purely for reliable throughput and good customer experience.
 */

// Shared with schedulerService.estimateRun() so estimates and the real
// send loop evaluate business hours in the SAME timezone.
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

function resolveTimezone(settings = {}) {
    return settings.timezone || process.env.APP_TIMEZONE || DEFAULT_TIMEZONE;
}

/**
 * Get { hour, minute, weekday } in an explicit IANA timezone using only
 * built-in Intl — no new dependency. weekday follows getDay() 0=Sun…6=Sat.
 */
const zonedFormatters = new Map();

function zonedParts(date, timeZone) {
    // Constructing Intl.DateTimeFormat is expensive and window searches
    // call this thousands of times, so keep one formatter per timezone.
    let fmt = zonedFormatters.get(timeZone);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            weekday: 'short',
        });
        zonedFormatters.set(timeZone, fmt);
    }
    const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const hour = parseInt(parts.hour === '24' ? '0' : parts.hour, 10); // en-US can emit 24 for midnight
    const minute = parseInt(parts.minute, 10);
    const weekday = weekdays.indexOf(parts.weekday);
    return { hour, minute, weekday };
}

/** Minute-of-day positions for the configured window. */
function zonedWindowMinutes(settings, parts) {
    const [startH, startM] = settings.businessHoursStart.split(':').map(Number);
    const [endH, endM] = settings.businessHoursEnd.split(':').map(Number);
    return {
        startMin: startH * 60 + startM,
        endMin: endH * 60 + endM,
        nowMin: parts.hour * 60 + parts.minute,
    };
}

/** Is `date` inside the business-hours window in the given timezone? */
function zonedWithinBusinessHours(settings, date, timeZone) {
    if (!settings.businessHoursEnabled) return true;
    const parts = zonedParts(date, timeZone);
    if (!settings.businessDays.includes(parts.weekday)) return false;
    const { startMin, endMin, nowMin } = zonedWindowMinutes(settings, parts);
    return nowMin >= startMin && nowMin < endMin;
}

/**
 * Resolve a business-hours window plus send caps from a settings object —
 * one source of truth for the send loop and the scheduler's estimator.
 */
function resolveSendSettings(settings = {}) {
    return {
        delayBetweenMessages: Number(settings.delayBetweenMessages ?? 17500),
        businessHoursEnabled: settings.businessHoursEnabled ?? true,
        businessHoursStart: String(settings.businessHoursStart || '09:30'),
        businessHoursEnd: String(settings.businessHoursEnd || '18:30'),
        businessDays: (settings.businessDays && settings.businessDays.length) ? settings.businessDays : [1, 2, 3, 4, 5, 6], // Mon-Sat
        maxPerHour: Number(settings.maxPerHour ?? 50),
        maxPerDay: Number(settings.maxPerDay ?? 175),
        circuitBreakerThreshold: Number(settings.circuitBreakerThreshold ?? settings.consecutiveFailureLimit ?? 5),
        // Only send when it is also business hours where the recipient is.
        respectRecipientTimezone: settings.respectRecipientTimezone ?? true,
        // Optional cooldown: after `cooldownEvery` messages, wait
        // `cooldownMinutes` before continuing (0 = off).
        cooldownEvery: Math.max(0, Math.floor(Number(settings.cooldownEvery ?? 0)) || 0),
        cooldownMinutes: Math.max(0, Number(settings.cooldownMinutes ?? 10) || 0),
        // Pause when this share of the last 20 attempts failed (0 = off).
        failureRatePauseThreshold: Number(settings.failureRatePauseThreshold ?? 0.5),
        unregisteredRatePauseThreshold: Number(settings.unregisteredRatePauseThreshold ?? 0.4),
        // retryCount/retryDelay were read by the queue but never copied
        // here, so campaign values were silently replaced by defaults.
        retryCount: Number.isFinite(Number(settings.retryCount ?? 2)) ? Math.max(0, Math.floor(Number(settings.retryCount ?? 2))) : 2,
        retryDelay: Math.max(1000, Number(settings.retryDelay ?? 30000) || 30000),
        // Upper bound for exponential retry backoff.
        maxRetryDelay: Number(settings.maxRetryDelay ?? 3600000),
    };
}

/*
 * Jitter — wait() delays each send by delayBetweenMessages × a random
 * multiplier uniformly distributed over [0.7, 1.4] (0.7 + Math.random()*0.7).
 * Expected value of a uniform [a, b] range is (a + b) / 2 = 1.05, so an
 * estimator multiplying by 1.05 tracks the AVERAGE pacing of the queue.
 * Exported so estimators never hardcode a diverging number.
 */
const JITTER_MIN = 0.7;
const JITTER_MAX = 1.4;
const JITTER_EXPECTED = (JITTER_MIN + JITTER_MAX) / 2; // 1.05

class RateLimiter {
    constructor(settings = {}) {
        this.settings = resolveSendSettings(settings);
        this.settings.timezone = resolveTimezone(settings);
        this._hourCount = 0;
        this._hourReset = Date.now();
        this._dayCount = 0;
        this._dayReset = Date.now();
    }

    updateSettings(settings) {
        Object.assign(this.settings, resolveSendSettings(settings));
        if (settings.timezone !== undefined) this.settings.timezone = resolveTimezone(settings);
    }

    /**
     * Wait for the configured delay between messages.
     */
    async wait() {
        await new Promise(r => setTimeout(r, this.nextDelayMs()));
    }

    nextDelayMs() {
        const delay = Number(this.settings.delayBetweenMessages) || 17500;
        return delay * (JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN));
    }

    /**
     * @param {object} [overrides]
     * @param {number} [overrides.providerDailyLimit] WhatsApp's messaging-limit
     *   tier for the sending number (Business API); the stricter of it and
     *   maxPerDay applies.
     * @returns {{ allowed: boolean, reason: string, code?: string }}
     */
    async checkDatabaseLimits(db, userId, now = new Date(), overrides = {}) {
        if (!userId) throw new Error('userId is required to check campaign send limits.');
        const providerDaily = Number(overrides?.providerDailyLimit) > 0 ? Number(overrides.providerDailyLimit) : 0;
        const ownDaily = this.settings.maxPerDay > 0 ? this.settings.maxPerDay : 0;
        const maxPerDay = ownDaily && providerDaily ? Math.min(ownDaily, providerDaily) : (ownDaily || providerDaily);
        const checks = [];
        if (this.settings.maxPerHour > 0) {
            checks.push(db.count(
                'campaign_contacts',
                'user_id = ? AND status = ? AND sent_at >= ?',
                [userId, 'sent', new Date(now.getTime() - 3600000)],
            ));
        } else {
            checks.push(Promise.resolve(0));
        }
        if (maxPerDay > 0) {
            checks.push(db.count(
                'campaign_contacts',
                'user_id = ? AND status = ? AND sent_at >= ?',
                [userId, 'sent', new Date(now.getTime() - 86400000)],
            ));
        } else {
            checks.push(Promise.resolve(0));
        }
        const [hourCount, dayCount] = await Promise.all(checks);
        if (this.settings.maxPerHour > 0 && hourCount >= this.settings.maxPerHour) {
            return { allowed: false, reason: 'Hourly limit reached', code: 'hourly_limit' };
        }
        if (maxPerDay > 0 && dayCount >= maxPerDay) {
            const providerCap = providerDaily > 0 && maxPerDay === providerDaily && (!ownDaily || providerDaily < ownDaily);
            return providerCap
                ? { allowed: false, reason: 'WhatsApp daily messaging limit reached', code: 'provider_daily_limit' }
                : { allowed: false, reason: 'Daily limit reached', code: 'daily_limit' };
        }
        return { allowed: true, reason: '' };
    }

    /**
     * Check if we are currently within business hours — evaluated in the
     * configured IANA timezone (settings.timezone → APP_TIMEZONE →
     * Asia/Kolkata), never the server's local zone (UTC on Render).
     * @returns {boolean}
     */
    isWithinBusinessHours(at = new Date()) {
        return zonedWithinBusinessHours(this.settings, at, resolveTimezone(this.settings));
    }

    /**
     * Get milliseconds until business hours next open, evaluated in the
     * CONFIGURED timezone. Steps forward in 5-minute chunks testing each
     * candidate instant with the same zoned logic as
     * isWithinBusinessHours(), so midnight rollovers and weekdays that
     * differ between UTC and the target timezone are handled uniformly.
     * Capped at a 7-day walk; a config with no opening in a full week
     * falls back to 24h (unreachable with sane settings).
     * @param {Date} [from] — evaluation instant; defaults to now.
     * @returns {number}
     */
    msUntilBusinessHours(from = new Date()) {
        const now = from;
        const tz = resolveTimezone(this.settings);
        // Already inside the window right now → no wait.
        if (zonedWithinBusinessHours(this.settings, now, tz)) return 0;
        const maxSteps = 7 * 24 * 12; // a full week of 5-min steps
        for (let i = 1; i <= maxSteps; i++) {
            const candidate = new Date(now.getTime() + i * 5 * 60000);
            if (zonedWithinBusinessHours(this.settings, candidate, tz)) {
                // Walk back in 1-minute steps to the exact opening second
                // of this window: the first instant inside it whose
                // 1-minute predecessor is outside the window.
                let openAt = candidate.getTime();
                while (openAt - 60000 > now.getTime()) {
                    const prev = openAt - 60000;
                    if (zonedWithinBusinessHours(this.settings, new Date(prev), tz)) openAt = prev;
                    else break;
                }
                return Math.max(0, openAt - now.getTime());
            }
        }
        // Fallback for a pathological config with no opening in a week.
        return 24 * 3600000;
    }

    /**
     * Check if rate limits allow sending.
     * @returns {{ allowed: boolean, reason: string }}
     */
    checkLimits() {
        const now = Date.now();

        // Reset hourly counter
        if (now - this._hourReset > 3600000) {
            this._hourCount = 0;
            this._hourReset = now;
        }
        // Reset daily counter
        if (now - this._dayReset > 86400000) {
            this._dayCount = 0;
            this._dayReset = now;
        }

        if (this._hourCount >= this.settings.maxPerHour) {
            return { allowed: false, reason: 'Hourly limit reached' };
        }
        if (this._dayCount >= this.settings.maxPerDay) {
            return { allowed: false, reason: 'Daily limit reached' };
        }
        return { allowed: true, reason: '' };
    }

    recordSent() {
        this._hourCount++;
        this._dayCount++;
    }
}

module.exports = RateLimiter;
module.exports.DEFAULT_TIMEZONE = DEFAULT_TIMEZONE;
module.exports.resolveTimezone = resolveTimezone;
module.exports.zonedParts = zonedParts;
module.exports.resolveSendSettings = resolveSendSettings;
module.exports.zonedWithinBusinessHours = zonedWithinBusinessHours;
module.exports.JITTER_EXPECTED = JITTER_EXPECTED;
module.exports.JITTER_MIN = JITTER_MIN;
module.exports.JITTER_MAX = JITTER_MAX;
