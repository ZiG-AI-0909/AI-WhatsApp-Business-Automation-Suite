// =============================================================
// Campaign message queue — per-user edition.
//
// Every campaign is owned by a user (campaigns.user_id). Messages
// are sent ONLY through that user's own WhatsApp session — never
// through another user's connection. If the owner's session is not
// connected, the item fails with a clear error (retry/backoff per
// rate limiter settings); there is no fallback path.
// =============================================================
const db = require('../database/db');
const contactService = require('../contacts/contactService');
const RateLimiter = require('./rateLimiter');
const { emitToUser } = require('../realtime');

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
        this._ownerUserId = null; // tenant isolation: owner of the loaded campaign
        this._provider = 'web';   // provider this campaign was created with
        this._rateLimiter = null;
        this._io = null;
        this._processPromise = null;
    }

    setIO(io) { this._io = io; }
    _emit(event, data) {
        if (this._ownerUserId) emitToUser(this._io, this._ownerUserId, event, data);
    }
    isRunning() { return this._running && !this._paused; }
    isPaused() { return this._paused; }
    getCurrentCampaignId() { return this._campaignId; }
    getCurrentOwnerUserId() { return this._ownerUserId; }

    async start(campaignId, settings = {}, userId = null) {
        if (this._running) throw new Error('A campaign is already running. Stop or pause it first.');
        if (!userId) throw new Error('Campaign must be started by its owner.');
        const campaign = await db.getById('campaigns', campaignId, userId);
        if (!campaign) throw new Error('Campaign not found');
        this._campaignId = campaignId;
        this._ownerUserId = userId;
        this._provider = campaign.provider || 'web';
        this._running = true;
        this._paused = false;
        this._rateLimiter = new RateLimiter(settings);
        await db.update('campaigns', {
            status: 'running',
            started_at: campaign.started_at || new Date(),
            updated_at: new Date(),
        }, 'id = ? AND user_id = ?', [campaignId, userId]);
        this._emit('campaign:started', { campaignId, name: campaign.name });
        this._processPromise = this._process().catch(error => {
            console.error('Campaign processor error:', error);
            db.update('campaigns', { status: 'failed', updated_at: new Date() }, 'id = ? AND user_id = ?', [campaignId, userId]);
            this._emit('campaign:error', { campaignId, error: error.message });
        });
    }

    pause() {
        if (!this._campaignId) return;
        this._paused = true;
        db.update('campaigns', { status: 'paused', updated_at: new Date() }, 'id = ? AND user_id = ?', [this._campaignId, this._ownerUserId]);
        this._emit('campaign:paused', { campaignId: this._campaignId });
    }

    resume() {
        if (!this._running) throw new Error('No campaign is loaded. Start first.');
        this._paused = false;
        db.update('campaigns', { status: 'running', updated_at: new Date() }, 'id = ? AND user_id = ?', [this._campaignId, this._ownerUserId]);
        this._emit('campaign:resumed', { campaignId: this._campaignId });
    }

    stop() {
        if (!this._campaignId) return;
        const campaignId = this._campaignId;
        const userId = this._ownerUserId;
        this._running = false;
        this._paused = false;
        db.update('campaign_contacts', { status: 'skipped' }, 'campaign_id = ? AND user_id = ? AND status IN (\'pending\', \'processing\')', [campaignId, userId]);
        db.update('campaigns', { status: 'stopped', completed_at: new Date(), updated_at: new Date() }, 'id = ? AND user_id = ?', [campaignId, userId]);
        this._emit('campaign:stopped', { campaignId });
        this._campaignId = null;
        this._ownerUserId = null;
        this._provider = 'web';
    }

    /**
     * Resolve the send function for THIS campaign owner and provider.
     * Sends only ever go through the owner's own session — there is
     * deliberately no fallback to any other user's connection.
     */
    async _getSender(userId, provider) {
        if (provider === 'business') {
            const businessApiProvider = require('../whatsapp/businessApiProvider');
            if (businessApiProvider.getStatus(userId) !== 'connected') {
                throw new Error('Your WhatsApp Business API is not connected. Reconnect it to continue this campaign.');
            }
            return (phone, body, media, buttons) => businessApiProvider.sendMessage(userId, phone, body, media, buttons);
        }
        const sessionManager = require('../whatsapp/sessionManager');
        if (sessionManager.getStatus(userId) !== 'connected') {
            throw new Error('Your WhatsApp session is not connected. Reconnect WhatsApp to continue this campaign.');
        }
        return (phone, body, media) => sessionManager.sendMessage(userId, phone, body, null, media);
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
            const userId = this._ownerUserId;
            db.update('campaign_contacts', { status: 'pending' }, 'campaign_id = ? AND user_id = ? AND status = ?', [campaignId, userId, 'processing']);

            const item = await db.select(
                'campaign_contacts',
                '*, contacts(phone), campaigns(media_path, media_type, media_filename, media_mimetype, buttons)',
                'campaign_id = ? AND user_id = ? AND status = ? AND (retry_at IS NULL OR retry_at <= ?)',
                [campaignId, userId, 'pending', new Date()],
                'id',
                1,
                0
            );

            if (!item || item.length === 0) {
                const remaining = await db.count('campaign_contacts', 'campaign_id = ? AND user_id = ? AND status IN (\'pending\', \'processing\')', [campaignId, userId]);
                if (remaining > 0) { await this._sleep(1000); continue; }
                db.update('campaigns', { status: 'completed', completed_at: new Date(), updated_at: new Date() }, 'id = ? AND user_id = ?', [campaignId, userId]);
                this._emit('campaign:completed', { campaignId });
                this._running = false;
                this._campaignId = null;
                this._ownerUserId = null;
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
            const contact = await contactService.findByPhone(contactItem.phone, userId);
            if (contact && !contact.marketing_opt_in) {
                db.update('campaign_contacts', { status: 'opted_out' }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
                const campaignRow = await db.getById('campaigns', campaignId, userId);
                db.update('campaigns', { processed: (parseInt(campaignRow?.processed) || 0) + 1, opt_outs: (parseInt(campaignRow?.opt_outs) || 0) + 1, updated_at: new Date() }, 'id = ? AND user_id = ?', [campaignId, userId]);
                this._emitProgress(campaignId);
                continue;
            }

            db.update('campaign_contacts', { status: 'processing', attempts: (parseInt(contactItem.attempts) || 0) + 1 }, 'id = ? AND user_id = ? AND status = ?', [contactItem.id, userId, 'pending']);
            try {
                // SECURITY: resolve the send function to THIS user's own
                // session. If it isn't connected, the send fails — there is
                // deliberately no fallback to any other user's session.
                const send = await this._getSender(userId, this._provider || 'web');
                let buttons = [];
                try { buttons = JSON.parse(contactItem.buttons || '[]'); } catch { buttons = []; }
                const media = contactItem.media_path ? { path: contactItem.media_path, type: contactItem.media_type || 'image', filename: contactItem.media_filename, mimetype: contactItem.media_mimetype } : null;
                const result = await send(contactItem.phone, contactItem.rendered_message, media, buttons);
                const providerMessageId = result?.key?.id || result?.id?._serialized || result?.id || result?.messages?.[0]?.id || null;
                db.update('campaign_contacts', { status: 'sent', provider_message_id: providerMessageId, sent_at: new Date(), retry_at: null }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
                const sentRow = await db.getById('campaigns', campaignId, userId);
                db.update('campaigns', { processed: (parseInt(sentRow?.processed) || 0) + 1, sent: (parseInt(sentRow?.sent) || 0) + 1, updated_at: new Date() }, 'id = ? AND user_id = ?', [campaignId, userId]);
                this._rateLimiter?.recordSent();
            } catch (error) {
                const maxAttempts = Number(this._rateLimiter?.settings.retryCount ?? 2);
                const attempts = (parseInt(contactItem.attempts) || 0) + 1;
                if (attempts <= maxAttempts) {
                    const retryDelay = Number(this._rateLimiter?.settings.retryDelay ?? 30000);
                    db.update('campaign_contacts', { status: 'pending', last_error: error.message, retry_at: new Date(Date.now() + retryDelay) }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
                } else {
                    db.update('campaign_contacts', { status: 'failed', last_error: error.message, retry_at: null }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
                    const failedRow = await db.getById('campaigns', campaignId, userId);
                    db.update('campaigns', { processed: (parseInt(failedRow?.processed) || 0) + 1, failed: (parseInt(failedRow?.failed) || 0) + 1, updated_at: new Date() }, 'id = ? AND user_id = ?', [campaignId, userId]);
                }
            }
            this._emitProgress(campaignId);
            if (this._rateLimiter && this._running) await this._rateLimiter.wait();
        }
    }

    _emitProgress(campaignId) {
        db.getById('campaigns', campaignId, this._ownerUserId).then(campaign => {
            if (campaign) this._emit('campaign:progress', campaign);
        });
    }

    _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    async resumeInterrupted(io) {
        this.setIO(io);
        // Resume any campaign left running/paused by a restart. Ownership
        // comes from the row's own user_id — each resumed campaign sends
        // only through its owner's session.
        const campaigns = await db.select('campaigns', '*', "status IN ('running', 'paused')", [], 'id', 10, 0);
        if (!campaigns || campaigns.length === 0) return;
        const activeCampaign = campaigns[0];
        this._campaignId = activeCampaign.id;
        this._ownerUserId = activeCampaign.user_id || null;
        if (!this._ownerUserId) {
            console.warn(`[messageQueue] campaign ${activeCampaign.id} has no user_id; skipping resume`);
            return;
        }
        this._running = true;
        this._paused = activeCampaign.status === 'paused';
        this._provider = activeCampaign.provider || 'web';
        let settings = {};
        try { settings = JSON.parse(activeCampaign.settings || '{}'); } catch {}
        this._rateLimiter = new RateLimiter(settings);
        if (!this._paused) this._processPromise = this._process().catch(console.error);
    }

    static isOptOut(message) { return OPT_OUT_PATTERNS.some(pattern => pattern.test(message)); }
}

module.exports = new MessageQueue();
module.exports.OPT_OUT_PATTERNS = OPT_OUT_PATTERNS;
