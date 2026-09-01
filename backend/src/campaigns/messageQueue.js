const db = require('../database/db');
const contactService = require('../contacts/contactService');
const RateLimiter = require('./rateLimiter');

const OPT_OUT_PATTERNS = [
    /\bstop\b/i, /\bunsubscribe\b/i, /\bremove\s*me\b/i,
    /\bdon['\u2019]?t\s*(message|contact|text|whatsapp)\s*me\b/i,
    /\bno\s*more\s*(messages?|texts?)\b/i, /\bbandh\s*karo\b/i,
    /\bmat\s*bhejo\b/i, /\bnahi\s*chahiye\b/i,
];

class MessageQueue {
    constructor() {
        this._running = false;
        this._paused = false;
        this._campaignId = null;
        this._rateLimiter = null;
        this._io = null;
        this._whatsappService = null;
        this._processPromise = null;
    }

    setIO(io) { this._io = io; }
    setWhatsApp(wa) { this._whatsappService = wa; }
    _emit(event, data) { this._io?.emit(event, data); }
    isRunning() { return this._running && !this._paused; }
    isPaused() { return this._paused; }
    getCurrentCampaignId() { return this._campaignId; }

    async start(campaignId, settings = {}) {
        if (this._running) throw new Error('A campaign is already running. Stop or pause it first.');
        const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
        if (!campaign) throw new Error('Campaign not found');
        this._campaignId = campaignId;
        this._running = true;
        this._paused = false;
        this._rateLimiter = new RateLimiter(settings);
        db.prepare("UPDATE campaigns SET status='running', started_at=COALESCE(started_at, datetime('now')), updated_at=datetime('now') WHERE id=?").run(campaignId);
        this._emit('campaign:started', { campaignId, name: campaign.name });
        this._processPromise = this._process().catch(error => {
            console.error('Campaign processor error:', error);
            db.prepare("UPDATE campaigns SET status='failed', updated_at=datetime('now') WHERE id=?").run(campaignId);
            this._emit('campaign:error', { campaignId, error: error.message });
        });
    }

    pause() {
        if (!this._campaignId) return;
        this._paused = true;
        db.prepare("UPDATE campaigns SET status='paused', updated_at=datetime('now') WHERE id=?").run(this._campaignId);
        this._emit('campaign:paused', { campaignId: this._campaignId });
    }

    resume() {
        if (!this._running) throw new Error('No campaign is loaded. Start first.');
        this._paused = false;
        db.prepare("UPDATE campaigns SET status='running', updated_at=datetime('now') WHERE id=?").run(this._campaignId);
        this._emit('campaign:resumed', { campaignId: this._campaignId });
    }

    stop() {
        if (!this._campaignId) return;
        const campaignId = this._campaignId;
        this._running = false;
        this._paused = false;
        const skipped = db.prepare("UPDATE campaign_contacts SET status='skipped' WHERE campaign_id=? AND status IN ('pending','processing')").run(campaignId).changes;
        db.prepare("UPDATE campaigns SET status='stopped', skipped=skipped+?, completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(skipped, campaignId);
        this._emit('campaign:stopped', { campaignId });
        this._campaignId = null;
    }

    async _process() {
        while (this._running) {
            if (this._paused) { await this._sleep(500); continue; }
            if (this._rateLimiter && !this._rateLimiter.isWithinBusinessHours()) {
                this._emit('campaign:waiting_hours', { campaignId: this._campaignId });
                await this._sleep(Math.min(this._rateLimiter.msUntilBusinessHours(), 60000));
                continue;
            }
            const limitCheck = this._rateLimiter?.checkLimits() ?? { allowed: true };
            if (!limitCheck.allowed) { await this._sleep(60000); continue; }

            const campaignId = this._campaignId;
            db.prepare("UPDATE campaign_contacts SET status='pending' WHERE campaign_id=? AND status='processing'").run(campaignId);
            const item = db.prepare(`
                SELECT cc.*, c.phone, ca.media_path, ca.media_type, ca.media_filename, ca.media_mimetype, ca.buttons
                FROM campaign_contacts cc
                JOIN contacts c ON c.id=cc.contact_id
                JOIN campaigns ca ON ca.id=cc.campaign_id
                WHERE cc.campaign_id=? AND cc.status='pending' AND (cc.retry_at IS NULL OR cc.retry_at <= datetime('now'))
                ORDER BY cc.id ASC LIMIT 1
            `).get(campaignId);
            if (!item) {
                const remaining = db.prepare("SELECT COUNT(*) as count FROM campaign_contacts WHERE campaign_id=? AND status IN ('pending','processing')").get(campaignId).count;
                if (remaining > 0) { await this._sleep(1000); continue; }
                db.prepare("UPDATE campaigns SET status='completed', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(campaignId);
                this._emit('campaign:completed', { campaignId });
                this._running = false;
                this._campaignId = null;
                break;
            }

            const contact = contactService.findByPhone(item.phone);
            if (contact && !contact.marketing_opt_in) {
                db.prepare("UPDATE campaign_contacts SET status='opted_out' WHERE id=?").run(item.id);
                db.prepare("UPDATE campaigns SET processed=processed+1, opt_outs=opt_outs+1, updated_at=datetime('now') WHERE id=?").run(campaignId);
                this._emitProgress(campaignId);
                continue;
            }

            db.prepare("UPDATE campaign_contacts SET status='processing', attempts=attempts+1 WHERE id=? AND status='pending'").run(item.id);
            try {
                if (!this._whatsappService || this._whatsappService.getStatus() !== 'connected') throw new Error('WhatsApp provider is not connected');
                let buttons = [];
                try { buttons = JSON.parse(item.buttons || '[]'); } catch { buttons = []; }
                const media = item.media_path ? { path: item.media_path, type: item.media_type || 'image', filename: item.media_filename, mimetype: item.media_mimetype } : null;
                const result = await this._whatsappService.sendMessage(item.phone, item.rendered_message, null, media, buttons);
                const providerMessageId = result?.key?.id || result?.id?._serialized || result?.id || result?.messages?.[0]?.id || null;
                db.prepare("UPDATE campaign_contacts SET status='sent', provider_message_id=?, sent_at=datetime('now'), retry_at=NULL WHERE id=?").run(providerMessageId, item.id);
                db.prepare("UPDATE campaigns SET processed=processed+1, sent=sent+1, updated_at=datetime('now') WHERE id=?").run(campaignId);
                this._rateLimiter?.recordSent();
            } catch (error) {
                const maxAttempts = Number(this._rateLimiter?.settings.retryCount ?? 2);
                const attempts = item.attempts + 1;
                if (attempts <= maxAttempts) {
                    const retryDelay = Number(this._rateLimiter?.settings.retryDelay ?? 30000);
                    db.prepare("UPDATE campaign_contacts SET status='pending', last_error=?, retry_at=datetime('now', '+' || ? || ' seconds') WHERE id=?").run(error.message, Math.ceil(retryDelay / 1000), item.id);
                } else {
                    db.prepare("UPDATE campaign_contacts SET status='failed', last_error=?, retry_at=NULL WHERE id=?").run(error.message, item.id);
                    db.prepare("UPDATE campaigns SET processed=processed+1, failed=failed+1, updated_at=datetime('now') WHERE id=?").run(campaignId);
                }
            }
            this._emitProgress(campaignId);
            if (this._rateLimiter && this._running) await this._rateLimiter.wait();
        }
    }

    _emitProgress(campaignId) {
        const campaign = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
        if (campaign) this._emit('campaign:progress', campaign);
    }

    _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    resumeInterrupted(whatsappService, io) {
        this.setIO(io);
        this.setWhatsApp(whatsappService);
        const campaign = db.prepare("SELECT * FROM campaigns WHERE status IN ('running','paused') ORDER BY id DESC LIMIT 1").get();
        if (!campaign) return;
        this._campaignId = campaign.id;
        this._running = true;
        this._paused = campaign.status === 'paused';
        this._rateLimiter = new RateLimiter(JSON.parse(campaign.settings || '{}'));
        if (!this._paused) this._processPromise = this._process().catch(console.error);
    }

    static isOptOut(message) { return OPT_OUT_PATTERNS.some(pattern => pattern.test(message)); }
}

module.exports = new MessageQueue();
