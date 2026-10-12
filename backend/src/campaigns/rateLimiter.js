/**
 * RateLimiter — Controls sending speed and business hours.
 * Does NOT simulate human typing to deceive WhatsApp.
 * Exists purely for reliable throughput and good customer experience.
 */
class RateLimiter {
    constructor(settings = {}) {
        this.settings = {
            delayBetweenMessages: settings.delayBetweenMessages ?? 17500,  // ms between sends
            businessHoursEnabled: settings.businessHoursEnabled ?? true,
            businessHoursStart: settings.businessHoursStart ?? '09:30',
            businessHoursEnd: settings.businessHoursEnd ?? '18:30',
            businessDays: settings.businessDays ?? [1, 2, 3, 4, 5, 6], // Mon-Sat
            maxPerHour: settings.maxPerHour ?? 50,
            maxPerDay: settings.maxPerDay ?? 175,
            ...settings,
        };
        this._hourCount = 0;
        this._hourReset = Date.now();
        this._dayCount = 0;
        this._dayReset = Date.now();
    }

    updateSettings(settings) {
        Object.assign(this.settings, settings);
    }

    /**
     * Wait for the configured delay between messages.
     */
    async wait() {
        const delay = Number(this.settings.delayBetweenMessages) || 17500;
        const jitteredDelay = delay * (0.7 + Math.random() * 0.7);
        await new Promise(r => setTimeout(r, jitteredDelay));
    }

    /**
     * Check if we are currently within business hours.
     * @returns {boolean}
     */
    isWithinBusinessHours() {
        if (!this.settings.businessHoursEnabled) return true;

        const now = new Date();
        const day = now.getDay(); // 0=Sun, 1=Mon...6=Sat
        if (!this.settings.businessDays.includes(day)) return false;

        const [startH, startM] = this.settings.businessHoursStart.split(':').map(Number);
        const [endH, endM] = this.settings.businessHoursEnd.split(':').map(Number);
        const startMin = startH * 60 + startM;
        const endMin = endH * 60 + endM;
        const nowMin = now.getHours() * 60 + now.getMinutes();

        return nowMin >= startMin && nowMin < endMin;
    }

    /**
     * Get milliseconds until business hours start tomorrow.
     * @returns {number}
     */
    msUntilBusinessHours() {
        const now = new Date();
        const [startH, startM] = this.settings.businessHoursStart.split(':').map(Number);

        let next = new Date(now);
        next.setHours(startH, startM, 0, 0);

        // If today's start has passed, go to tomorrow
        if (next <= now) {
            next.setDate(next.getDate() + 1);
        }

        // Advance to a business day
        let attempts = 0;
        while (!this.settings.businessDays.includes(next.getDay()) && attempts < 7) {
            next.setDate(next.getDate() + 1);
            attempts++;
        }

        return Math.max(0, next.getTime() - now.getTime());
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
