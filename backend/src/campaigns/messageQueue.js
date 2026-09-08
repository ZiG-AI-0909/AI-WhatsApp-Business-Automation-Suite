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
        const campaign = await db.getById('campaigns', campaignId);
        if (!campaign) throw new Error('Campaign not found');
        this._campaignId = campaignId;
        this._running = true;
        this._paused = false;
        this._rateLimiter = new RateLimiter(settings);
        await db.update('campaigns', {
            status: 'running',
            started_at: campaign.started_at || new Date(),
            updated_at: new Date(),
        }, 'id = ?', [campaignId]);
        this._emit('campaign:started', { campaignId, name: campaign.name });
        this._processPromise = this._process().catch(error => {
            console.error('Campaign processor error:', error);
            db.update('campaigns', { status: 'failed', updated_at: new Date() }, 'id = ?', [campaignId]);
            this._emit('campaign:error', { campaignId, error: error.message });
        });
    }

    pause() {
        if (!this._campaignId) return;
        this._paused = true;
        db.update('campaigns', { status: 'paused', updated_at: new Date() }, 'id = ?', [this._campaignId]);
        this._emit('campaign:paused', { campaignId: this._campaignId });
    }

    resume() {
        if (!this._running) throw new Error('No campaign is loaded. Start first.');
        this._paused = false;
        db.update('campaigns', { status: 'running', updated_at: new Date() }, 'id = ?', [this._campaignId]);
        this._emit('campaign:resumed', { campaignId: this._campaignId });
    }

    stop() {
        if (!this._campaignId) return;
        const campaignId = this._campaignId;
        this._running = false;
        this._paused = false;
        db.update('campaign_contacts', { status: 'skipped' }, 'campaign_id = ? AND status IN (\'pending\', \'processing\')', [campaignId]);
        db.update('campaigns', { status: 'stopped', completed_at: new Date(), updated_at: new Date() }, 'id = ?', [campaignId]);
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
            db.update('campaign_contacts', { status: 'pending' }, 'campaign_id = ? AND status = ?', [campaignId, 'processing']);

            const item = await db.select(
                'campaign_contacts',
                '*, contacts(phone), campaigns(media_path, media_type, media_filename, media_mimetype, buttons)',
                'campaign_id = ? AND status = ? AND (retry_at IS NULL OR retry_at <= ?)',
                [campaignId, 'pending', new Date()],
                'id',
                1,
                0
            );

            if (!item || item.length === 0) {
                const remaining = await db.count('campaign_contacts', 'campaign_id = ? AND status IN (\'pending\', \'processing\')', [campaignId]);
                if (remaining > 0) { await this._sleep(1000); continue; }
                db.update('campaigns', { status: 'completed', completed_at: new Date(), updated_at: new Date() }, 'id = ?', [campaignId]);
                this._emit('campaign:completed', { campaignId });
                this._running = false;
                this._campaignId = null;
                break;
            }

            // PostgREST returns embedded resources as nested objects
            // (contacts, campaigns); flatten them back to the flat shape
            // the rest of _process() expects.
            const rawItem = item[0];
            const contactItem = {
                id: rawItem.id,
                campaign_id: rawItem.campaign_id,
                contact_id: rawItem.contact_id,
                rendered_message: rawItem.rendered_message,
                status: rawItem.status,
                attempts: rawItem.attempts,
                last_error: rawItem.last_error,
                sent_at: rawItem.sent_at,
                provider_message_id: rawItem.provider_message_id,
                retry_at: rawItem.retry_at,
                phone: rawItem.contacts?.phone || '',
                media_path: rawItem.campaigns?.media_path || null,
                media_type: rawItem.campaigns?.media_type || null,
                media_filename: rawItem.campaigns?.media_filename || null,
                media_mimetype: rawItem.campaigns?.media_mimetype || null,
                buttons: rawItem.campaigns?.buttons || '[]',
            };
            const contact = contactService.findByPhone(contactItem.phone);
            if (contact && !contact.marketing_opt_in) {
                db.update('campaign_contacts', { status: 'opted_out' }, 'id = ?', [contactItem.id]);
                db.update('campaigns', { processed: (parseInt((await db.getById('campaigns', campaignId)).processed) || 0) + 1, opt_outs: (parseInt((await db.getById('campaigns', campaignId)).opt_outs) || 0) + 1, updated_at: new Date() }, 'id = ?', [campaignId]);
                this._emitProgress(campaignId);
                continue;
            }

            db.update('campaign_contacts', { status: 'processing', attempts: (parseInt(contactItem.attempts) || 0) + 1 }, 'id = ? AND status = ?', [contactItem.id, 'pending']);
            try {
                if (!this._whatsappService || this._whatsappService.getStatus() !== 'connected') throw new Error('WhatsApp provider is not connected');
                let buttons = [];
                try { buttons = JSON.parse(contactItem.buttons || '[]'); } catch { buttons = []; }
                const media = contactItem.media_path ? { path: contactItem.media_path, type: contactItem.media_type || 'image', filename: contactItem.media_filename, mimetype: contactItem.media_mimetype } : null;
                const result = await this._whatsappService.sendMessage(contactItem.phone, contactItem.rendered_message, null, media, buttons);
                const providerMessageId = result?.key?.id || result?.id?._serialized || result?.id || result?.messages?.[0]?.id || null;
                db.update('campaign_contacts', { status: 'sent', provider_message_id: providerMessageId, sent_at: new Date(), retry_at: null }, 'id = ?', [contactItem.id]);
                db.update('campaigns', { processed: (parseInt((await db.getById('campaigns', campaignId)).processed) || 0) + 1, sent: (parseInt((await db.getById('campaigns', campaignId)).sent) || 0) + 1, updated_at: new Date() }, 'id = ?', [campaignId]);
                this._rateLimiter?.recordSent();
            } catch (error) {
                const maxAttempts = Number(this._rateLimiter?.settings.retryCount ?? 2);
                const attempts = (parseInt(contactItem.attempts) || 0) + 1;
                if (attempts <= maxAttempts) {
                    const retryDelay = Number(this._rateLimiter?.settings.retryDelay ?? 30000);
                    db.update('campaign_contacts', { status: 'pending', last_error: error.message, retry_at: new Date(Date.now() + retryDelay) }, 'id = ?', [contactItem.id]);
                } else {
                    db.update('campaign_contacts', { status: 'failed', last_error: error.message, retry_at: null }, 'id = ?', [contactItem.id]);
                    db.update('campaigns', { processed: (parseInt((await db.getById('campaigns', campaignId)).processed) || 0) + 1, failed: (parseInt((await db.getById('campaigns', campaignId)).failed) || 0) + 1, updated_at: new Date() }, 'id = ?', [campaignId]);
                }
            }
            this._emitProgress(campaignId);
            if (this._rateLimiter && this._running) await this._rateLimiter.wait();
        }
    }

    _emitProgress(campaignId) {
        db.getById('campaigns', campaignId).then(campaign => {
            if (campaign) this._emit('campaign:progress', campaign);
        });
    }

    _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    async resumeInterrupted(whatsappService, io) {
        this.setIO(io);
        this.setWhatsApp(whatsappService);
        const campaign = await db.select('campaigns', '*', "status IN ('running', 'paused')", [], 'id', 1, 0);
        if (!campaign || campaign.length === 0) return;
        const activeCampaign = campaign[0];
        this._campaignId = activeCampaign.id;
        this._running = true;
        this._paused = activeCampaign.status === 'paused';
        this._rateLimiter = new RateLimiter(JSON.parse(activeCampaign.settings || '{}'));
        if (!this._paused) this._processPromise = this._process().catch(console.error);
    }

    static isOptOut(message) { return OPT_OUT_PATTERNS.some(pattern => pattern.test(message)); }
}

module.exports = new MessageQueue();
