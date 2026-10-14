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
const { parseJsonField } = require('../utils/jsonField');

const OPT_OUT_PATTERNS = [
    /\bstop\b/i, /\bunsubscribe\b/i, /\bremove\s*me\b/i,
    /\bdon['\u2019]?t\s*(message|contact|text|whatsapp)\s*me\b/i,
    /\bno\s*more\s*(messages?|texts?)\b/i, /\bbandh\s*karo\b/i,
    /\bmat\s*bhejo\b/i, /\bnahi\s*chahiye\b/i,
];

function describeSendError(error) {
    const responseData = error?.response?.data;
    const providerError = responseData?.error;
    const message = [
        providerError?.message,
        responseData?.message,
        error?.output?.payload?.message,
        error?.message,
    ].find(value => typeof value === 'string' && value.trim());
    const status = error?.response?.status || error?.output?.statusCode;
    const code = providerError?.code || responseData?.error_code || error?.output?.payload?.code;
    const details = [
        status ? `HTTP ${status}` : null,
        message || 'Unknown WhatsApp send error',
        code ? `code ${code}` : null,
    ].filter(Boolean);
    return details.join(': ').slice(0, 1000);
}

function shouldRetrySendError(error) {
    const status = error?.response?.status || error?.output?.statusCode;
    if (status === 400) return false;
    return !/WhatsApp number is not registered/i.test(error?.message || '');
}

function isConnectionError(error) {
    const message = String(error?.message || '');
    if (/WhatsApp (?:session|Business API) is not connected|Reconnect WhatsApp|ensureConnected failed/i.test(message)) {
        return true;
    }
    const status = error?.response?.status || error?.output?.statusCode;
    return !status && /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|socket (?:closed|ended)|connection (?:closed|lost|reset)/i.test(message);
}

class MessageQueue {
    constructor() {
        this._queues = new Map();
        this._io = null;
        this._resumePageSize = 1000;
    }

    setIO(io) { this._io = io; }
    _worker(userId) { return this._queues.get(userId) || null; }
    _emit(event, data) {
        if (!this._ownerUserId) throw new Error('Cannot emit campaign event without an owner.');
        emitToUser(this._io, this._ownerUserId, event, data);
    }
    isRunning(userId) { const q = this._worker(userId); return !!q && q._running && !q._paused; }
    isPaused(userId) { return !!this._worker(userId)?._paused; }
    getCurrentCampaignId(userId) { return this._worker(userId)?._campaignId ?? null; }
    getCurrentOwnerUserId(userId) { return this._worker(userId)?._ownerUserId ?? null; }

    async start(campaignId, settings = {}, userId) {
        if (!userId) throw new Error('Campaign must be started by its owner.');
        if (this._worker(userId)?._running) throw new Error('A campaign is already running. Stop or pause it first.');
        const worker = Object.create(this);
        Object.assign(worker, { _campaignId: campaignId, _ownerUserId: userId, _provider: 'web', _running: true, _paused: false, _rateLimiter: new RateLimiter(settings), _io: this._io, _processPromise: null });
        this._queues.set(userId, worker);
        try {
            const campaign = await db.getById('campaigns', campaignId, userId);
            if (!campaign) throw new Error('Campaign not found');
            worker._provider = campaign.provider || 'web';
            await this._update(worker, 'campaigns', {
                status: 'running',
                started_at: campaign.started_at || new Date(),
                pause_reason: null,
                last_error: null,
                updated_at: new Date(),
            }, 'id = ? AND user_id = ?', [campaignId, userId]);
            worker._emit('campaign:started', { campaignId, name: campaign.name });
            this._startProcessor(worker);
        } catch (error) {
            worker._running = false;
            if (this._queues.get(userId) === worker) this._queues.delete(userId);
            throw error;
        }
    }

    async _update(worker, table, data, where, params) {
        try {
            return await db.update(table, data, where, params);
        } catch (error) {
            console.error(`[messageQueue] ${table} update failed for campaign ${worker?._campaignId ?? 'unknown'}:`, error);
            throw error;
        }
    }

    _startProcessor(worker) {
        worker._processPromise = worker._process().catch(error => this._handleProcessorCrash(worker, error));
        return worker._processPromise;
    }

    async _handleProcessorCrash(worker, error) {
        console.error('Campaign processor error:', error);
        worker._running = false;
        if (this._queues.get(worker._ownerUserId) === worker) this._queues.delete(worker._ownerUserId);
        try {
            await this._update(worker, 'campaigns', { status: 'failed', updated_at: new Date() }, 'id = ? AND user_id = ?', [worker._campaignId, worker._ownerUserId]);
        } catch (updateError) {
            console.error('[messageQueue] failed to mark crashed campaign failed:', updateError);
        }
        try {
            worker._emit('campaign:error', { campaignId: worker._campaignId, error: error.message });
        } catch (emitError) {
            console.error('[messageQueue] failed to emit campaign:error:', emitError);
        }
    }

    async pause(userId) {
        const worker = this._worker(userId); if (!worker?._campaignId) return;
        worker._paused = true;
        await this._update(worker, 'campaigns', { status: 'paused', updated_at: new Date() }, 'id = ? AND user_id = ?', [worker._campaignId, userId]);
        worker._emit('campaign:paused', { campaignId: worker._campaignId });
    }

    async resume(userId) {
        const worker = this._worker(userId); if (!worker?._running) throw new Error('No campaign is loaded. Start first.');
        worker._paused = false;
        await this._update(worker, 'campaigns', { status: 'running', updated_at: new Date() }, 'id = ? AND user_id = ?', [worker._campaignId, userId]);
        if (worker._processPromise === null) this._startProcessor(worker);
        worker._emit('campaign:resumed', { campaignId: worker._campaignId });
    }

    async stop(userId) {
        const worker = this._worker(userId); if (!worker?._campaignId) return;
        const campaignId = worker._campaignId;
        worker._running = false; worker._paused = false;
        try {
            await this._update(worker, 'campaign_contacts', { status: 'skipped' }, 'campaign_id = ? AND user_id = ? AND status IN (\'pending\', \'processing\')', [campaignId, userId]);
            await this._update(worker, 'campaigns', { status: 'stopped', completed_at: new Date(), updated_at: new Date() }, 'id = ? AND user_id = ?', [campaignId, userId]);
        } catch (e) { console.error('Campaign stop update failed:', e); throw e; }
        worker._emit('campaign:stopped', { campaignId });
        this._queues.delete(userId);
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
            // Unattended revival: a scheduled campaign may fire after the
            // 2h idle timeout dropped the socket. Try reconnecting from the
            // stored Supabase auth state BEFORE giving up — the existing
            // error message stays so the queue's retry/backoff and any
            // failure record look exactly like before when revival fails.
            const revived = await sessionManager.ensureConnected(
                userId,
                Number(process.env.WA_SEND_REVIVE_TIMEOUT_MS || 45000)
            );
            if (!revived) {
                throw new Error('Your WhatsApp session is not connected. Reconnect WhatsApp to continue this campaign.');
            }
        }
        return (phone, body, media) => sessionManager.sendMessage(userId, phone, body, null, media);
    }

    async _process() {
        while (this._running) {
            if (this._paused) { await this._sleep(500); continue; }
            const limitCheck = this._rateLimiter?.checkLimits() ?? { allowed: true };
            if (!limitCheck.allowed) { await this._sleep(60000); continue; }

            const campaignId = this._campaignId;
            const userId = this._ownerUserId;
            await this._update(this, 'campaign_contacts', { status: 'pending' }, 'campaign_id = ? AND user_id = ? AND status = ?', [campaignId, userId, 'processing']);

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
                const [sent, failed, optedOut, skipped] = await Promise.all(
                    ['sent', 'failed', 'opted_out', 'skipped'].map(status =>
                        db.count('campaign_contacts', 'campaign_id = ? AND user_id = ? AND status = ?', [campaignId, userId, status])
                    )
                );
                await this._update(this, 'campaigns', {
                    status: 'completed',
                    processed: sent + failed + optedOut + skipped,
                    sent,
                    failed,
                    opt_outs: optedOut,
                    completed_at: new Date(),
                    updated_at: new Date(),
                }, 'id = ? AND user_id = ?', [campaignId, userId]);
                this._emit('campaign:completed', { campaignId });
                this._running = false;
                this._queues.delete(userId);
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
                await this._update(this, 'campaign_contacts', { status: 'opted_out' }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
                const campaignRow = await db.getById('campaigns', campaignId, userId);
                await this._update(this, 'campaigns', { processed: (parseInt(campaignRow?.processed) || 0) + 1, opt_outs: (parseInt(campaignRow?.opt_outs) || 0) + 1, updated_at: new Date() }, 'id = ? AND user_id = ?', [campaignId, userId]);
                this._emitProgress(campaignId);
                continue;
            }

            const attempts = parseInt(contactItem.attempts) || 0;
            try {
                // SECURITY: resolve the send function to THIS user's own
                // session. If it isn't connected, the send fails — there is
                // deliberately no fallback to any other user's session.
                const send = await this._getSender(userId, this._provider || 'web');
                await this._update(this, 'campaign_contacts', { status: 'processing', attempts: attempts + 1 }, 'id = ? AND user_id = ? AND status = ?', [contactItem.id, userId, 'pending']);
                const buttons = parseJsonField(contactItem.buttons, []);
                const media = contactItem.media_path ? { path: contactItem.media_path, type: contactItem.media_type || 'image', filename: contactItem.media_filename, mimetype: contactItem.media_mimetype } : null;
                const result = await send(contactItem.phone, contactItem.rendered_message, media, buttons);
                const providerMessageId = result?.key?.id || result?.id?._serialized || result?.id || result?.messages?.[0]?.id || null;
                await this._update(this, 'campaign_contacts', { status: 'sent', provider_message_id: providerMessageId, sent_at: new Date(), retry_at: null }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
                const sentRow = await db.getById('campaigns', campaignId, userId);
                await this._update(this, 'campaigns', { processed: (parseInt(sentRow?.processed) || 0) + 1, sent: (parseInt(sentRow?.sent) || 0) + 1, updated_at: new Date() }, 'id = ? AND user_id = ?', [campaignId, userId]);
                this._rateLimiter?.recordSent();
            } catch (error) {
                const lastError = describeSendError(error);
                const retryable = shouldRetrySendError(error);
                const maxAttempts = Number(this._rateLimiter?.settings.retryCount ?? 2);
                const connectionError = isConnectionError(error);
                console.error(`[messageQueue] Send failed campaign=${campaignId} contact=${contactItem.id} class=${connectionError ? 'connection' : 'contact'} provider=${this._provider || 'web'} retryable=${retryable}: ${lastError}`);
                if (connectionError) {
                    await this._update(this, 'campaign_contacts', { status: 'pending', attempts, retry_at: null }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
                    await this._update(this, 'campaigns', {
                        status: 'paused',
                        pause_reason: 'whatsapp_disconnected',
                        last_error: lastError.slice(0, 500),
                        updated_at: new Date(),
                    }, 'id = ? AND user_id = ?', [campaignId, userId]);
                    this._running = false;
                    this._paused = true;
                    this._queues.delete(userId);
                    this._emit('campaign:paused', { campaignId, reason: 'whatsapp_disconnected', error: lastError });
                    return;
                }
                if (retryable && attempts + 1 <= maxAttempts) {
                    const retryDelay = Number(this._rateLimiter?.settings.retryDelay ?? 30000);
                    await this._update(this, 'campaign_contacts', { status: 'pending', last_error: lastError, retry_at: new Date(Date.now() + retryDelay) }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
                } else {
                    await this._update(this, 'campaign_contacts', { status: 'failed', last_error: lastError, retry_at: null }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
                    const failedRow = await db.getById('campaigns', campaignId, userId);
                    await this._update(this, 'campaigns', { processed: (parseInt(failedRow?.processed) || 0) + 1, failed: (parseInt(failedRow?.failed) || 0) + 1, updated_at: new Date() }, 'id = ? AND user_id = ?', [campaignId, userId]);
                }
            }
            this._emitProgress(campaignId);
            if (this._rateLimiter && this._running) await this._rateLimiter.wait();
        }
    }

    _emitProgress(campaignId) {
        db.getById('campaigns', campaignId, this._ownerUserId).then(campaign => {
            if (campaign) this._emit('campaign:progress', campaign);
        }).catch(error => console.error('[messageQueue] campaign progress lookup failed:', error));
    }

    _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    async resumeDisconnectedCampaigns(userId, candidates = null) {
        if (!userId) throw new Error('userId is required to resume disconnected campaigns.');
        let campaigns = candidates;
        if (!campaigns) {
            const result = await db.paginate(
                'campaigns',
                'user_id = ? AND status = ? AND pause_reason = ?',
                [userId, 'paused', 'whatsapp_disconnected'],
                'id',
                'asc',
                1000,
                0,
            );
            campaigns = result.data;
        }
        const campaign = campaigns.find(row => row.status === 'paused' && row.pause_reason === 'whatsapp_disconnected');
        if (!campaign) return null;

        try {
            if ((campaign.provider || 'web') === 'business') {
                const businessApiProvider = require('../whatsapp/businessApiProvider');
                if (businessApiProvider.getStatus(userId) !== 'connected') return null;
            } else {
                const sessionManager = require('../whatsapp/sessionManager');
                if (sessionManager.getStatus(userId) !== 'connected') {
                    const connected = await sessionManager.ensureConnected(userId, Number(process.env.WA_SEND_REVIVE_TIMEOUT_MS || 45000));
                    if (!connected || sessionManager.getStatus(userId) !== 'connected') return null;
                }
            }
            await this.start(campaign.id, parseJsonField(campaign.settings, {}), userId);
            return campaign.id;
        } catch (error) {
            console.error(`[messageQueue] Could not auto-resume disconnected campaign=${campaign.id} user=${userId}:`, error.message);
            return null;
        }
    }

    /**
     * Resume any campaign left running/paused by a restart. Ownership comes
     * from the row's own user_id — each resumed campaign sends only through
     * its owner's session.
     *
     * Returns { ok: boolean, resumed?: string|null } so server.js can RETRY
     * with backoff when the DB is unreachable at boot (never give up for
     * the whole process lifetime).
     *
     * Idempotent: a second call while a worker is already loaded (or while
     * the same campaign was already resumed) returns ok without starting a
     * second _process() loop for the same owner.
     */
    async resumeInterrupted(io) {
        this.setIO(io);

        const pageSize = this._resumePageSize || 1000;
        const campaigns = [];
        let offset = 0;
        try {
            while (true) {
                const page = await db.select('campaigns', '*', "status IN ('running', 'paused')", [], 'id', pageSize, offset);
                if (!page?.length) break;
                campaigns.push(...page);
                offset += page.length;
                if (page.length < pageSize) break;
            }
        } catch (error) {
            console.error('[messageQueue] resumeInterrupted: could not read campaigns — will retry:', error.message);
            return { ok: false, error: error.message };
        }
        campaigns.sort((a, b) => Number(a.id) - Number(b.id));
        const byOwner = new Map();
        for (const row of campaigns) {
            if (!row.user_id) {
                console.warn(`[messageQueue] campaign ${row.id} has no user_id; skipping resume`);
                continue;
            }
            if (!byOwner.has(row.user_id)) byOwner.set(row.user_id, []);
            byOwner.get(row.user_id).push(row);
        }

        let resumed = null;
        let alreadyRunning = false;
        for (const [userId, ownerCampaigns] of byOwner) {
            const connectionPaused = ownerCampaigns.filter(row => row.status === 'paused' && row.pause_reason === 'whatsapp_disconnected');
            if (connectionPaused.length) {
                const resumedId = await this.resumeDisconnectedCampaigns(userId, connectionPaused);
                if (resumedId !== null) {
                    resumed = resumed ?? resumedId;
                    continue;
                }
                ownerCampaigns.splice(0, ownerCampaigns.length, ...ownerCampaigns.filter(row => !connectionPaused.includes(row)));
            }
            const existingWorker = this._worker(userId);
            if (existingWorker?._running && existingWorker._campaignId) {
                alreadyRunning = true;
                for (const duplicate of ownerCampaigns) {
                    if (String(duplicate.id) === String(existingWorker._campaignId)) continue;
                    try {
                        await this._update(existingWorker, 'campaigns', {
                            status: 'stopped',
                            completed_at: new Date(),
                            updated_at: new Date(),
                        }, 'id = ? AND user_id = ?', [duplicate.id, userId]);
                    } catch (error) {
                        console.error(`[messageQueue] failed to stop duplicate interrupted campaign ${duplicate.id}:`, error);
                    }
                }
                continue;
            }

            const activeCampaign = ownerCampaigns[0];
            const worker = Object.create(this);
            const settings = parseJsonField(activeCampaign.settings, {});
            Object.assign(worker, { _campaignId: activeCampaign.id, _ownerUserId: userId, _running: true, _paused: activeCampaign.status === 'paused', _provider: activeCampaign.provider || 'web', _rateLimiter: new RateLimiter(settings), _io: this._io, _processPromise: null });
            this._queues.set(userId, worker);
            if (!worker._paused) this._startProcessor(worker);
            if (resumed === null) resumed = activeCampaign.id;

            for (const extra of ownerCampaigns.slice(1)) {
                try {
                    await this._update(worker, 'campaigns', { status: 'stopped', completed_at: new Date(), updated_at: new Date() }, 'id = ? AND user_id = ?', [extra.id, userId]);
                } catch (error) {
                    console.error(`[messageQueue] failed to stop duplicate interrupted campaign ${extra.id}:`, error);
                }
            }
        }

        if (resumed === null && alreadyRunning) return { ok: true, alreadyRunning: true };
        return { ok: true, resumed, ...(alreadyRunning ? { alreadyRunning: true } : {}) };
    }

    static isOptOut(message) { return OPT_OUT_PATTERNS.some(pattern => pattern.test(message)); }
}

module.exports = new MessageQueue();
module.exports.OPT_OUT_PATTERNS = OPT_OUT_PATTERNS;
module.exports.shouldRetrySendError = shouldRetrySendError;
module.exports.isConnectionError = isConnectionError;
