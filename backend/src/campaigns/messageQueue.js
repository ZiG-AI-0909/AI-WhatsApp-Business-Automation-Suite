// =============================================================
// Campaign message queue — per-user edition.
//
// Every campaign is owned by a user (campaigns.user_id). Messages
// are sent ONLY through that user's own WhatsApp session — never
// through another user's connection. If the owner's session is not
// connected, the item fails with a clear error (retry/backoff per
// rate limiter settings); there is no fallback path.
// =============================================================
const crypto = require('crypto');
const db = require('../database/db');
const contactService = require('../contacts/contactService');
const RateLimiter = require('./rateLimiter');
const { emitToUser } = require('../realtime');
const { parseJsonField } = require('../utils/jsonField');
const campaignMediaStorage = require('./campaignMediaStorage');
const fieldRenderer = require('./fieldRenderer');
const sendPolicy = require('./sendPolicy');
const { nextSendWindow } = require('./recipientTime');
const { sanitizeTemplate } = require('./campaignSettings');
const { INTERRUPTED_PREFIX } = require('./deliveryTracker');
const campaignLog = require('./campaignLog');
const providerRegistry = require('../whatsapp/providerRegistry');
const { isCampaignDeliveryMigrationAvailable } = require('../database/campaignDeliveryMigrationGuard');

// A row left in 'processing' by a crash or restart may already have been
// delivered, so it is never resent automatically.
const INTERRUPTED_MESSAGE = `${INTERRUPTED_PREFIX} (server restart or crash) before WhatsApp confirmed it. It was not resent automatically because it may already have been delivered; use "Retry failed" only if the contact did not receive it.`;
const NO_LOCAL_HOURS_MESSAGE = 'Skipped: your business hours never overlap with business hours in this recipient\'s country, so the message could not be sent at a reasonable local time.';
// Minimum pause after a rate-limit response, even without Retry-After.
const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
const HEALTH_CHECK_INTERVAL_MS = 10 * 60_000;

// Same shape as Baileys' own ids (3EB0 + 18 hex). Assigned before sending
// and reused for retries, so a receipt can prove an interrupted send went
// out and WhatsApp treats a retried copy as the same message.
function newWebMessageId() {
    return `3EB0${crypto.randomBytes(9).toString('hex').toUpperCase()}`;
}

function renderTemplateParam(param, fields) {
    return fieldRenderer.render(String(param ?? ''), fields, { strict: false })
        .replace(/\{\{\s*\w+\s*\}\}/g, '')
        .trim();
}

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
    const requestConfig = error?.response?.config || error?.config;
    const requestUrl = requestConfig?.url;
    let requestLocation = null;
    if (requestUrl) {
        try {
            const fullUrl = new URL(requestUrl, requestConfig.baseURL);
            requestLocation = `${fullUrl.host}${fullUrl.pathname}`;
        } catch {
            requestLocation = String(requestUrl).split('?')[0].slice(0, 200);
        }
    }
    let bodySnippet = '';
    if (responseData !== undefined && responseData !== null) {
        const body = typeof responseData === 'string' ? responseData : JSON.stringify(responseData);
        bodySnippet = body
            .replace(/bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
            .replace(/("(?:access_token|refresh_token|token|authorization|password)"\s*:\s*")[^"]*"/gi, '$1[redacted]"')
            .replace(/([?&](?:access_token|token|key)=)[^&\s]+/gi, '$1[redacted]')
            .replace(/\s+/g, ' ')
            .slice(0, 240);
    }
    let safeMessage = String(message || 'Unknown WhatsApp send error')
        .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
            try {
                const url = new URL(value);
                return `${url.host}${url.pathname}`;
            } catch {
                return '[redacted URL]';
            }
        })
        .replace(/bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
        .replace(/((?:access[_-]?token|refresh[_-]?token|token|password|authorization)\s*[=:]\s*)[^,\s;]+/gi, '$1[redacted]');
    if (status) safeMessage = safeMessage.replace(new RegExp(`^HTTP ${status}:?\\s*`, 'i'), '');
    const details = [
        status ? `HTTP ${status}` : null,
        requestLocation,
        safeMessage,
        code ? `code ${code}` : null,
        bodySnippet ? `response ${bodySnippet}` : null,
    ].filter(Boolean);
    return details.join(': ').slice(0, 1000);
}

// Kept for callers and tests: true when the error is temporary and the
// recipient may be retried (see sendPolicy.classifySendError).
function shouldRetrySendError(error) {
    return sendPolicy.classifySendError(error).kind === 'retry';
}

function isConnectionError(error) {
    const message = String(error?.message || '');
    if (/WhatsApp (?:(?:session|Business API) )?is not connected|Reconnect WhatsApp|ensureConnected failed/i.test(message)) {
        return true;
    }
    const status = error?.response?.status || error?.output?.statusCode;
    return !status && /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|socket (?:closed|ended)|connection (?:closed|lost|reset)/i.test(message);
}

function isNotRegisteredError(error) {
    const responseError = error?.response?.data?.error;
    return /WhatsApp number is not registered/i.test([
        error?.message,
        error?.response?.data?.message,
        typeof responseError === 'string' ? responseError : responseError?.message,
        error?.output?.payload?.message,
    ].filter(Boolean).join(' '));
}

function isMediaUploadError(error, hasMedia) {
    if (!hasMedia || isNotRegisteredError(error)) return false;
    const requestUrl = error?.response?.config?.url || error?.config?.url || '';
    const responseError = error?.response?.data?.error;
    let path = String(requestUrl).split('?')[0];
    try { path = new URL(requestUrl, error?.config?.baseURL).pathname; } catch {}
    return /\/(?:media|upload|mms|mmg)(?:\/|$)/i.test(path)
        || /(?:media|attachment|upload).{0,40}(?:failed|invalid|unsupported|error)|(?:failed|invalid|unsupported|error).{0,40}(?:media|attachment|upload)/i
            .test([
                error?.message,
                error?.response?.data?.message,
                typeof responseError === 'string' ? responseError : responseError?.message,
            ].filter(Boolean).join(' '))
        || /campaign attachment is unavailable/i.test(error?.message || '');
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
    /** Why the loaded campaign is not sending right now: { reason, until, since } or null. */
    getWaiting(userId) { return this._worker(userId)?._waiting ?? null; }
    getWarning(userId) { return this._worker(userId)?._warning ?? null; }

    // Single clock for queue decisions (retry times, local hours); tests override it.
    _now() { return new Date(); }

    _createWorker(campaignId, userId, settings = {}, { provider = 'web', paused = false, mediaPath = null } = {}) {
        const worker = Object.create(this);
        const rateLimiter = new RateLimiter(settings);
        Object.assign(worker, {
            _campaignId: campaignId,
            _ownerUserId: userId,
            _provider: providerRegistry.normalizeProvider(provider),
            _running: true,
            _paused: paused,
            _rateLimiter: rateLimiter,
            _io: this._io,
            _processPromise: null,
            _consecutiveSendFailures: 0,
            _lastSendFailure: null,
            _consecutiveFailureContacts: [],
            _mediaBuffer: null,
            _mediaPath: mediaPath,
            _failureWindow: new sendPolicy.FailureWindow({
                failureRate: rateLimiter.settings.failureRatePauseThreshold,
                unregisteredRate: rateLimiter.settings.unregisteredRatePauseThreshold,
            }),
            _sentSinceCooldown: 0,
            _cooldownUntil: 0,
            _waiting: null,
            _warning: null,
            _health: null,
            _healthCheckedAt: 0,
            _initialQualityRating: undefined,
            _template: sanitizeTemplate(settings.waTemplate),
        });
        return worker;
    }

    async start(campaignId, settings = {}, userId) {
        if (!userId) throw new Error('Campaign must be started by its owner.');
        if (this._worker(userId)?._running) throw new Error('A campaign is already running. Stop or pause it first.');
        const worker = this._createWorker(campaignId, userId, settings);
        try {
            const campaign = await db.getById('campaigns', campaignId, userId);
            if (!campaign) throw new Error('Campaign not found');
            if (!['draft', 'stopped', 'paused', 'queued'].includes(campaign.status)) {
                throw new Error(`Cannot start campaign in status: ${campaign.status}`);
            }
            worker._provider = providerRegistry.normalizeProvider(campaign.provider);
            await worker._loadCampaignMedia(campaign);
            const claimed = await db.claimCampaignToRun(userId, campaignId, campaign.status);
            if (!claimed.length) {
                throw new Error('Another campaign is already running, or this campaign is no longer available to start.');
            }
            this._queues.set(userId, worker);
            if (campaign.resume_after && isCampaignDeliveryMigrationAvailable()) {
                await this._update(worker, 'campaigns', { resume_after: null }, 'id = ? AND user_id = ?', [campaignId, userId]);
            }
            worker._emit('campaign:started', { campaignId, name: campaign.name });
            campaignLog.info('campaign_started', { campaign: campaignId, user: userId, provider: worker._provider });
            this._startProcessor(worker);
        } catch (error) {
            worker._running = false;
            if (this._queues.get(userId) === worker) this._queues.delete(userId);
            throw error;
        }
    }

    async _loadCampaignMedia(campaign) {
        this._mediaPath = campaign?.media_path || null;
        if (!campaign?.media_path) {
            this._mediaBuffer = null;
            return null;
        }
        const { buffer } = await campaignMediaStorage.downloadCampaignMedia(campaign);
        if (!buffer.length) throw new Error('Campaign attachment is empty.');
        this._mediaBuffer = buffer;
        return buffer;
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
        if (worker._mediaPath && !Buffer.isBuffer(worker._mediaBuffer)) {
            const campaign = await db.getById('campaigns', worker._campaignId, userId);
            if (!campaign) throw new Error('Campaign not found');
            await worker._loadCampaignMedia(campaign);
        }
        worker._paused = false;
        await this._update(worker, 'campaigns', {
            status: 'running',
            pause_reason: null,
            last_error: null,
            updated_at: new Date(),
        }, 'id = ? AND user_id = ?', [worker._campaignId, userId]);
        if (worker._processPromise === null) this._startProcessor(worker);
        worker._emit('campaign:resumed', { campaignId: worker._campaignId });
    }

    async stop(userId) {
        const worker = this._worker(userId); if (!worker?._campaignId) return;
        const campaignId = worker._campaignId;
        worker._running = false; worker._paused = false;
        try {
            await this._update(worker, 'campaign_contacts', { status: 'skipped' }, 'campaign_id = ? AND user_id = ? AND status IN (\'pending\', \'processing\')', [campaignId, userId]);
            await this._recountCampaign(campaignId, userId);
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
        // Sends only ever go through the owner's own connection; the web
        // provider revives an idle session from stored auth before failing.
        return providerRegistry.get(provider).getSender(userId);
    }

    /**
     * Rows still marked 'processing' when a worker starts were being sent
     * when the previous process stopped. WhatsApp may already have them, so
     * they are held as failed with an explanation instead of being resent.
     * A later delivery receipt for the same message confirms them as sent.
     */
    async _recoverInterruptedSends() {
        const campaignId = this._campaignId;
        const userId = this._ownerUserId;
        const interrupted = Number(await db.count('campaign_contacts', 'campaign_id = ? AND user_id = ? AND status = ?', [campaignId, userId, 'processing'])) || 0;
        if (!interrupted) return 0;
        await this._update(this, 'campaign_contacts', {
            status: 'failed',
            last_error: INTERRUPTED_MESSAGE,
            retry_at: null,
        }, 'campaign_id = ? AND user_id = ? AND status = ?', [campaignId, userId, 'processing']);
        await this._recountCampaign(campaignId, userId);
        campaignLog.warn('interrupted_sends_held', { campaign: campaignId, count: interrupted });
        return interrupted;
    }

    /** Record why sending is on hold; emitted only when the reason changes. */
    _setWaiting(reason, until = null) {
        const untilIso = until ? new Date(until).toISOString() : null;
        if (!reason && !this._waiting) return;
        if (reason && this._waiting?.reason === reason && (this._waiting.until === untilIso || reason === 'scheduled_retries')) return;
        this._waiting = reason ? { reason, until: untilIso, since: new Date().toISOString() } : null;
        try {
            this._emit('campaign:waiting', { campaignId: this._campaignId, waiting: this._waiting });
        } catch (error) {
            console.error('[messageQueue] failed to emit campaign:waiting:', error.message);
        }
    }

    _setWarning(message) {
        if (!message || this._warning === message) return;
        this._warning = message;
        try {
            this._emit('campaign:warning', { campaignId: this._campaignId, message });
        } catch (error) {
            console.error('[messageQueue] failed to emit campaign:warning:', error.message);
        }
    }

    _outcomeWindow() {
        if (!this._failureWindow) {
            this._failureWindow = new sendPolicy.FailureWindow({
                failureRate: this._rateLimiter?.settings?.failureRatePauseThreshold ?? 0.5,
                unregisteredRate: this._rateLimiter?.settings?.unregisteredRatePauseThreshold ?? 0.4,
            });
        }
        return this._failureWindow;
    }

    /** Count a successful send toward the optional batch cooldown. */
    _noteSent() {
        const every = Number(this._rateLimiter?.settings?.cooldownEvery) || 0;
        const minutes = Number(this._rateLimiter?.settings?.cooldownMinutes) || 0;
        if (every <= 0 || minutes <= 0) return;
        this._sentSinceCooldown = (this._sentSinceCooldown || 0) + 1;
        if (this._sentSinceCooldown >= every) {
            this._sentSinceCooldown = 0;
            this._cooldownUntil = this._now().getTime() + minutes * 60_000;
        }
    }

    /**
     * Business API only: refresh the number's quality rating and messaging
     * limit tier every 10 minutes. Pauses when the number is flagged or its
     * rating drops to RED during this run. Returns true when it paused.
     */
    async _checkProviderHealth() {
        this._healthCheckedAt = Date.now();
        let health = null;
        try {
            health = await providerRegistry.get(this._provider).getHealth(this._ownerUserId);
        } catch (error) {
            campaignLog.warn('provider_health_unavailable', { campaign: this._campaignId, error: error.message });
        }
        this._health = health || this._health || null;
        if (!health) return false;
        const rating = health.qualityRating ? String(health.qualityRating).toUpperCase() : null;
        if (this._initialQualityRating === undefined) this._initialQualityRating = rating;
        const status = String(health.status || '').toUpperCase();
        if (['FLAGGED', 'RESTRICTED', 'BANNED', 'RATE_LIMITED'].includes(status)) {
            await this._pauseCampaign('quality_low', `WhatsApp reports this number's status as ${status}.`);
            return true;
        }
        if (rating === 'RED' && this._initialQualityRating !== 'RED') {
            await this._pauseCampaign('quality_low', 'WhatsApp lowered this number\'s quality rating to RED during the campaign.');
            return true;
        }
        if (rating === 'RED') {
            this._setWarning('This number\'s quality rating is RED. WhatsApp may lower its messaging limit; review content and consent before sending more.');
        }
        return false;
    }

    async _msUntilNextScheduledRow(campaignId, userId) {
        try {
            const [next] = await db.select(
                'campaign_contacts',
                'retry_at',
                'campaign_id = ? AND user_id = ? AND status = ? AND retry_at IS NOT NULL',
                [campaignId, userId, 'pending'],
                'retry_at',
                1,
                0,
            );
            const at = next?.retry_at ? new Date(next.retry_at).getTime() : NaN;
            return Number.isFinite(at) ? Math.max(0, at - this._now().getTime()) : 1000;
        } catch {
            return 1000;
        }
    }

    async _process() {
        await this._recoverInterruptedSends();
        while (this._running) {
            if (this._paused) { await this._sleep(500); continue; }
            if (this._provider === 'business' && Date.now() - (this._healthCheckedAt || 0) >= HEALTH_CHECK_INTERVAL_MS) {
                if (await this._checkProviderHealth()) return;
            }
            const limitCheck = this._rateLimiter
                ? await this._rateLimiter.checkDatabaseLimits(db, this._ownerUserId, this._now(), {
                    providerDailyLimit: this._health?.dailyRecipientLimit,
                })
                : { allowed: true };
            if (!limitCheck.allowed) {
                this._setWaiting(limitCheck.code || 'hourly_limit');
                await this._sleepResponsive(60000);
                continue;
            }
            if (this._rateLimiter && !this._rateLimiter.isWithinBusinessHours(this._now())) {
                const waitMs = this._rateLimiter.msUntilBusinessHours(this._now());
                this._setWaiting('outside_business_hours', new Date(this._now().getTime() + waitMs));
                await this._sleepResponsive(Math.min(waitMs, 60000));
                continue;
            }
            const cooldownMs = (this._cooldownUntil || 0) - this._now().getTime();
            if (cooldownMs > 0) {
                this._setWaiting('cooldown', new Date(this._cooldownUntil));
                await this._sleepResponsive(Math.min(cooldownMs, 60000));
                continue;
            }

            const campaignId = this._campaignId;
            const userId = this._ownerUserId;
            const item = await db.select(
                'campaign_contacts',
                '*, contacts(phone, name), campaigns(media_path, media_type, media_filename, media_mimetype, buttons)',
                'campaign_id = ? AND user_id = ? AND status = ? AND (retry_at IS NULL OR retry_at <= ?)',
                [campaignId, userId, 'pending', this._now()],
                'id',
                1,
                0
            );

            if (!item || item.length === 0) {
                const remaining = await db.count('campaign_contacts', 'campaign_id = ? AND user_id = ? AND status IN (\'pending\', \'processing\')', [campaignId, userId]);
                if (remaining > 0) {
                    // Everything left is waiting for a retry time or for the
                    // recipient's local business hours.
                    const waitMs = await this._msUntilNextScheduledRow(campaignId, userId);
                    this._setWaiting('scheduled_retries', waitMs > 1000 ? new Date(this._now().getTime() + waitMs) : null);
                    await this._sleepResponsive(Math.max(1000, Math.min(waitMs, 60000)));
                    continue;
                }
                const counters = await db.recountCampaignCounters(campaignId, userId);
                const status = counters.sent === 0
                    ? 'failed'
                    : counters.failed > 0 ? 'completed_with_errors' : 'completed';
                await this._update(this, 'campaigns', {
                    status,
                    ...counters,
                    last_error: status === 'failed'
                        ? (counters.failed > 0 ? `${counters.failed} contact(s) failed. Review the contact errors before retrying.` : 'No messages were sent; all contacts were skipped or opted out.')
                        : counters.failed > 0 ? `${counters.failed} contact(s) failed. Review the contact errors before retrying.` : null,
                    completed_at: new Date(),
                    updated_at: new Date(),
                }, 'id = ? AND user_id = ?', [campaignId, userId]);
                this._emit(status === 'failed' ? 'campaign:error' : 'campaign:completed', { campaignId, status });
                campaignLog.info('campaign_finished', { campaign: campaignId, status, sent: counters.sent, failed: counters.failed, opt_outs: counters.opt_outs, skipped: counters.skipped });
                this._waiting = null;
                this._running = false;
                this._queues.delete(userId);
                if (status === 'completed' || status === 'completed_with_errors') {
                    await this._startNextQueuedCampaign?.(userId);
                }
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
                contact_name: rawItem.contacts?.name || '',
                contact_data: rawItem.contact_data,
                media_path: rawItem.campaigns?.media_path || null,
                media_type: rawItem.campaigns?.media_type || null,
                media_filename: rawItem.campaigns?.media_filename || null,
                media_mimetype: rawItem.campaigns?.media_mimetype || null,
                buttons: rawItem.campaigns?.buttons || '[]',
            };
            const contact = await contactService.findByPhone(contactItem.phone, userId);
            if (!contact || !contact.marketing_opt_in) {
                await this._update(this, 'campaign_contacts', { status: 'opted_out' }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
                await this._recountCampaign(campaignId, userId);
                this._emitProgress(campaignId);
                continue;
            }

            // Recipient's local time: only send inside the business-hours
            // window in the recipient's country as well as the sender's.
            const sendSettings = this._rateLimiter?.settings;
            if (sendSettings?.respectRecipientTimezone && sendSettings.businessHoursEnabled) {
                const window = nextSendWindow(sendSettings, contactItem.phone, this._now());
                if (!window.at) {
                    await this._update(this, 'campaign_contacts', { status: 'skipped', last_error: NO_LOCAL_HOURS_MESSAGE, retry_at: null }, 'id = ? AND user_id = ? AND status = ?', [contactItem.id, userId, 'pending']);
                    await this._recountCampaign(campaignId, userId);
                    this._emitProgress(campaignId);
                    continue;
                }
                if (window.at.getTime() - this._now().getTime() > 1000) {
                    await this._update(this, 'campaign_contacts', { retry_at: window.at }, 'id = ? AND user_id = ? AND status = ?', [contactItem.id, userId, 'pending']);
                    continue;
                }
            }

            const attempts = parseInt(contactItem.attempts) || 0;
            let send;
            let sendError = null;
            try {
                // SECURITY: resolve the send function to THIS user's own
                // session. If it isn't connected, the send fails — there is
                // deliberately no fallback to any other user's session.
                send = await this._getSender(userId, this._provider || 'web');
            } catch (error) {
                sendError = error;
            }

            let attemptStarted = false;
            let result;
            const sendOptions = { callbackData: `cc:${contactItem.id}` };
            if (!sendError) {
                // Claim the row atomically (pending → processing). If another
                // worker or instance already took it, skip it: never send the
                // same recipient twice. WhatsApp Web messages get their id
                // now, before sending, and keep it across retries.
                const messageId = contactItem.provider_message_id || ((this._provider || 'web') === 'web' ? newWebMessageId() : null);
                const claim = { status: 'processing', attempts: attempts + 1 };
                if (messageId && messageId !== contactItem.provider_message_id) claim.provider_message_id = messageId;
                const claimed = await this._update(this, 'campaign_contacts', claim, 'id = ? AND user_id = ? AND status = ?', [contactItem.id, userId, 'pending']);
                if (Array.isArray(claimed) && claimed.length === 0) {
                    campaignLog.warn('send_skipped_already_claimed', { campaign: campaignId, contact: contactItem.id });
                    continue;
                }
                attemptStarted = true;
                if (messageId) sendOptions.messageId = messageId;
                const template = this._provider === 'business' ? this._template : null;
                if (template) {
                    const fields = {
                        ...(parseJsonField(contactItem.contact_data, {}) || {}),
                        phone: contactItem.phone,
                    };
                    if (contactItem.contact_name && !fields.name) fields.name = contactItem.contact_name;
                    sendOptions.template = {
                        name: template.name,
                        language: template.language,
                        bodyParams: template.bodyParams.map(param => renderTemplateParam(param, fields)),
                    };
                }
                const buttons = parseJsonField(contactItem.buttons, []);
                const media = contactItem.media_path ? {
                    buffer: this._mediaBuffer,
                    type: contactItem.media_type || 'image',
                    filename: contactItem.media_filename,
                    mimetype: contactItem.media_mimetype,
                } : null;
                try {
                    result = await send(contactItem.phone, contactItem.rendered_message, media, buttons, sendOptions);
                } catch (error) {
                    sendError = error;
                }
            }

            if (sendError) {
                const paused = await this._handleSendFailure(sendError, contactItem, attempts, attemptStarted, campaignId, userId);
                this._emitProgress(campaignId);
                if (paused) return;
                if (this._rateLimiter && this._running) await this._sleepResponsive(this._rateLimiter.nextDelayMs());
                continue;
            }

            const providerMessageId = result?.key?.id || result?.id?._serialized || result?.id || result?.messages?.[0]?.id || sendOptions.messageId || null;
            this._consecutiveSendFailures = 0;
            this._lastSendFailure = null;
            this._outcomeWindow().record('sent');
            this._noteSent();
            this._setWaiting(null);
            await this._update(this, 'campaign_contacts', { status: 'sent', provider_message_id: providerMessageId, sent_at: new Date(), retry_at: null }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
            await this._recountCampaign(campaignId, userId);
            this._emitProgress(campaignId);
            if (this._rateLimiter && this._running) await this._sleepResponsive(this._rateLimiter.nextDelayMs());
        }
    }

    async _handleSendFailure(error, contactItem, attempts, attemptStarted, campaignId, userId) {
        const lastError = describeSendError(error);
        const policy = sendPolicy.classifySendError(error);
        const connectionError = isConnectionError(error);
        const attemptsAfterFailure = attempts + (attemptStarted ? 1 : 0);
        const settings = this._rateLimiter?.settings || {};
        const maxAttempts = Number(settings.retryCount ?? 2);
        const hasMedia = !!contactItem.media_path;
        const mediaFailure = isMediaUploadError(error, hasMedia);
        const notRegistered = policy.kind === 'not_registered' || isNotRegisteredError(error);
        campaignLog.warn('send_failed', {
            campaign: campaignId,
            contact: contactItem.id,
            phone: contactItem.phone,
            provider: this._provider || 'web',
            class: connectionError ? 'connection' : mediaFailure ? 'media' : policy.kind,
            code: policy.code || undefined,
            status: policy.status || undefined,
            attempt: attemptsAfterFailure,
            error: lastError,
        });
        // Rate limits, spam/policy restrictions, auth and template problems
        // affect every recipient: stop sending instead of retrying.
        if (policy.kind === 'pause') {
            const resumeAfter = policy.pauseReason === 'rate_limited'
                ? new Date(Date.now() + Math.max(Number(policy.retryAfterMs) || 0, RATE_LIMIT_COOLDOWN_MS))
                : null;
            await this._pauseCampaignForSendFailure(lastError, policy.pauseReason, contactItem, attempts, campaignId, userId, { resumeAfter });
            return true;
        }
        if (connectionError || mediaFailure) {
            const reason = connectionError ? 'whatsapp_disconnected' : 'media_upload_failed';
            await this._pauseCampaignForSendFailure(lastError, reason, contactItem, attempts, campaignId, userId);
            return true;
        }
        // WhatsApp says this person opted out of marketing messages (131050):
        // record the opt-out so no campaign messages them again.
        if (policy.kind === 'opt_out') {
            try {
                await contactService.setOptOut(contactItem.phone, userId, 'whatsapp');
            } catch (optOutError) {
                campaignLog.error('opt_out_record_failed', { campaign: campaignId, contact: contactItem.id, error: optOutError.message });
            }
            await this._update(this, 'campaign_contacts', {
                status: 'opted_out',
                attempts: attemptsAfterFailure,
                last_error: lastError,
                retry_at: null,
            }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
            await this._recountCampaign(campaignId, userId);
            return false;
        }

        const configuredThreshold = Number(this._rateLimiter?.settings?.circuitBreakerThreshold ?? 5);
        const breakerThreshold = Number.isFinite(configuredThreshold) ? Math.max(1, Math.floor(configuredThreshold)) : 5;
        if (notRegistered) {
            this._consecutiveSendFailures = 0;
            this._lastSendFailure = null;
            this._consecutiveFailureContacts = [];
        } else if (this._lastSendFailure === lastError) {
            this._consecutiveSendFailures = (this._consecutiveSendFailures || 0) + 1;
            this._consecutiveFailureContacts ||= [];
        } else {
            this._lastSendFailure = lastError;
            this._consecutiveSendFailures = 1;
            this._consecutiveFailureContacts = [];
        }
        if (!notRegistered) this._consecutiveFailureContacts.push({ id: contactItem.id, attempts });
        if (!notRegistered && this._consecutiveSendFailures >= breakerThreshold) {
            for (const prior of this._consecutiveFailureContacts) {
                if (prior.id === contactItem.id) continue;
                await this._update(this, 'campaign_contacts', {
                    status: 'pending',
                    attempts: prior.attempts,
                    retry_at: null,
                }, 'id = ? AND user_id = ?', [prior.id, userId]);
            }
            await this._pauseCampaignForSendFailure(lastError, 'repeated_send_failures', contactItem, attempts, campaignId, userId);
            return true;
        }
        // Temporary errors retry with exponential backoff (retryDelay × 2^n,
        // capped, never sooner than a server Retry-After). Permanent errors
        // (invalid number, unsupported message, …) are never retried.
        if (policy.kind === 'retry' && attemptsAfterFailure <= maxAttempts) {
            const delay = sendPolicy.backoffDelayMs({
                baseMs: settings.retryDelay ?? 30000,
                attempt: attemptsAfterFailure,
                retryAfterMs: policy.retryAfterMs,
                minDelayMs: policy.minDelayMs,
                maxMs: settings.maxRetryDelay,
            });
            await this._update(this, 'campaign_contacts', {
                status: 'pending',
                attempts: attemptsAfterFailure,
                last_error: lastError,
                retry_at: new Date(this._now().getTime() + delay),
            }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
        } else {
            await this._update(this, 'campaign_contacts', {
                status: 'failed',
                attempts: attemptsAfterFailure,
                last_error: lastError,
                retry_at: null,
            }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
            await this._recountCampaign(campaignId, userId, lastError);
        }

        // Rising failure share (or many numbers not on WhatsApp) over the
        // last attempts pauses the campaign before it hurts the number.
        const outcomes = this._outcomeWindow();
        outcomes.record(notRegistered ? 'not_registered' : 'failed');
        const tripped = outcomes.check();
        if (tripped) {
            outcomes.reset();
            await this._pauseCampaign(tripped.reason, `${tripped.message} Last error: ${lastError}`);
            return true;
        }
        return false;
    }

    async _pauseCampaignForSendFailure(lastError, reason, contactItem, attempts, campaignId, userId, options = {}) {
        await this._update(this, 'campaign_contacts', {
            status: 'pending',
            attempts,
            retry_at: null,
        }, 'id = ? AND user_id = ?', [contactItem.id, userId]);
        await this._pauseCampaign(reason, lastError, options, campaignId, userId);
    }

    /**
     * Pause the campaign this worker is running and unload the worker.
     * Resuming later starts a fresh worker that continues with the rows
     * still pending; nothing already sent is sent again.
     */
    async _pauseCampaign(reason, lastError, { resumeAfter = null } = {}, campaignId = this._campaignId, userId = this._ownerUserId) {
        const message = String(lastError || sendPolicy.describePauseReason(reason));
        const data = {
            status: 'paused',
            pause_reason: reason,
            last_error: message.slice(0, 500),
            updated_at: new Date(),
        };
        if (resumeAfter && isCampaignDeliveryMigrationAvailable()) data.resume_after = resumeAfter;
        await this._update(this, 'campaigns', data, 'id = ? AND user_id = ?', [campaignId, userId]);
        await this._recountCampaign(campaignId, userId, message);
        this._running = false;
        this._paused = true;
        this._waiting = null;
        if (!this._queues.get(userId) || this._queues.get(userId) === this) this._queues.delete(userId);
        campaignLog.warn('campaign_paused', { campaign: campaignId, reason, resume_after: data.resume_after?.toISOString?.(), error: message });
        this._emit('campaign:paused', {
            campaignId,
            reason,
            error: message,
            ...(data.resume_after ? { resumeAfter: data.resume_after.toISOString() } : {}),
        });
    }

    /**
     * Pause because of a signal from WhatsApp that arrived outside the send
     * loop (delivery webhook failure, quality downgrade). Pauses the loaded
     * worker, or marks the campaign row when it runs elsewhere.
     */
    async pauseForProviderSignal(userId, campaignId, reason, message, options = {}) {
        if (!userId) return false;
        const worker = this._worker(userId);
        if (worker?._running && (campaignId == null || String(worker._campaignId) === String(campaignId))) {
            await worker._pauseCampaign(reason, message, options);
            return true;
        }
        if (campaignId == null) {
            // Number-level signal (quality downgrade) with no worker loaded
            // here: pause this owner's running Business API campaigns.
            const running = await db.select('campaigns', 'id', 'user_id = ? AND status = ? AND provider = ?', [userId, 'running', 'business'], 'id', 20, 0);
            let paused = false;
            for (const row of running || []) {
                paused = (await this.pauseForProviderSignal(userId, row.id, reason, message, options)) || paused;
            }
            return paused;
        }
        const data = {
            status: 'paused',
            pause_reason: reason,
            last_error: String(message || '').slice(0, 500),
            updated_at: new Date(),
        };
        if (options.resumeAfter && isCampaignDeliveryMigrationAvailable()) data.resume_after = options.resumeAfter;
        const updated = await this._update(this, 'campaigns', data, 'id = ? AND user_id = ? AND status = ?', [campaignId, userId, 'running']);
        if (Array.isArray(updated) && updated.length) {
            campaignLog.warn('campaign_paused', { campaign: campaignId, reason, source: 'provider_signal', error: message });
            emitToUser(this._io, userId, 'campaign:paused', { campaignId, reason, error: data.last_error });
            return true;
        }
        return false;
    }

    /** A message accepted earlier was reported failed by WhatsApp. */
    recordAsyncOutcome(userId, campaignId, outcome) {
        const worker = this._worker(userId);
        if (!outcome || !worker?._running || String(worker._campaignId) !== String(campaignId)) return;
        const outcomes = worker._outcomeWindow();
        outcomes.reclassify('sent', outcome);
        const tripped = outcomes.check();
        if (tripped) {
            outcomes.reset();
            worker._pauseCampaign(tripped.reason, `${tripped.message} (reported by WhatsApp after sending)`)
                .catch(error => campaignLog.error('pause_failed', { campaign: campaignId, error: error.message }));
        }
    }

    async _recountCampaign(campaignId, userId, lastError = null) {
        const counters = await db.recountCampaignCounters(campaignId, userId);
        if (lastError) {
            await this._update(this, 'campaigns', {
                last_error: lastError.slice(0, 500),
                updated_at: new Date(),
            }, 'id = ? AND user_id = ?', [campaignId, userId]);
        }
        return counters;
    }

    _emitProgress(campaignId) {
        db.getById('campaigns', campaignId, this._ownerUserId).then(campaign => {
            if (campaign) this._emit('campaign:progress', campaign);
        }).catch(error => console.error('[messageQueue] campaign progress lookup failed:', error));
    }

    _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    async _sleepResponsive(ms) {
        let remaining = Math.max(0, ms);
        while (remaining > 0 && this._running && !this._paused) {
            const chunk = Math.min(remaining, 1000);
            await this._sleep(chunk);
            remaining -= chunk;
        }
    }

    async resumeDisconnectedCampaigns(userId, candidates = null) {
        if (!userId) throw new Error('userId is required to resume disconnected campaigns.');
        let campaigns = candidates;
        if (!campaigns) {
            campaigns = [];
            const pageSize = 500;
            for (let offset = 0; ; offset += pageSize) {
                const page = await db.select(
                    'campaigns',
                    '*',
                    'user_id = ? AND status = ? AND pause_reason = ?',
                    [userId, 'paused', 'whatsapp_disconnected'],
                    'id',
                    pageSize,
                    offset,
                );
                campaigns.push(...page);
                if (page.length < pageSize) break;
            }
        }
        const campaign = campaigns.find(row => row.status === 'paused' && row.pause_reason === 'whatsapp_disconnected');
        if (!campaign) return null;

        try {
            const providerApi = providerRegistry.get(campaign.provider);
            if (!await providerApi.isConnected(userId) || providerApi.getStatus(userId) !== 'connected') return null;
            await this.start(campaign.id, parseJsonField(campaign.settings, {}), userId);
            return campaign.id;
        } catch (error) {
            console.error(`[messageQueue] Could not auto-resume disconnected campaign=${campaign.id} user=${userId}:`, error.message);
            return null;
        }
    }

    async _ownerIsConnected(userId, provider) {
        return providerRegistry.get(provider).isConnected(userId);
    }

    async _pauseQueuedCampaign(campaign, reason, error) {
        const worker = Object.create(this);
        worker._campaignId = campaign.id;
        worker._ownerUserId = campaign.user_id;
        worker._io = this._io;
        const message = String(error?.message || error || 'Campaign could not be started.').slice(0, 500);
        const updated = await this._update(worker, 'campaigns', {
            status: 'paused',
            pause_reason: reason,
            last_error: message,
            queue_position: null,
            queued_at: null,
            updated_at: new Date(),
        }, 'id = ? AND user_id = ? AND status = ?', [campaign.id, campaign.user_id, 'queued']);
        if (updated?.length) {
            await this._normalizeQueuedPositions(campaign.user_id);
            worker._emit('campaign:paused', { campaignId: campaign.id, reason, error: message });
        }
    }

    async _normalizeQueuedPositions(userId) {
        const ids = [];
        const pageSize = 500;
        for (let offset = 0; ; offset += pageSize) {
            const page = await db.select(
                'campaigns',
                'id',
                'user_id = ? AND status = ?',
                [userId, 'queued'],
                'queue_position asc',
                pageSize,
                offset,
            );
            ids.push(...page.map(row => row.id));
            if (page.length < pageSize) break;
        }
        if (ids.length) await db.reorderCampaignQueue(userId, ids);
    }

    async _startNextQueuedCampaign(userId, retry = 0) {
        if (!userId || this._worker(userId)?._running) return null;
        const [campaign] = await db.select(
            'campaigns',
            '*',
            'user_id = ? AND status = ?',
            [userId, 'queued'],
            'queue_position asc',
            1,
            0,
        );
        if (!campaign) return null;

        try {
            if (!await this._ownerIsConnected(userId, campaign.provider || 'web')) {
                throw Object.assign(new Error('WhatsApp is not connected. Reconnect to continue this queued campaign.'), {
                    pauseReason: 'whatsapp_disconnected',
                });
            }
            await this.start(campaign.id, parseJsonField(campaign.settings, {}), userId);
            return campaign.id;
        } catch (error) {
            const current = await db.getById('campaigns', campaign.id, userId);
            const anotherRunning = await db.count('campaigns', 'user_id = ? AND status = ?', [userId, 'running']);
            if (current?.status !== 'queued' || anotherRunning > 0) return null;
            const [head] = await db.select(
                'campaigns',
                'id',
                'user_id = ? AND status = ?',
                [userId, 'queued'],
                'queue_position asc',
                1,
                0,
            );
            if (head && String(head.id) !== String(campaign.id)) {
                return retry < 1 ? this._startNextQueuedCampaign(userId, retry + 1) : null;
            }
            const reason = error.pauseReason
                || (campaign.media_path ? 'media_load_failed' : 'campaign_start_failed');
            console.error(`[messageQueue] Queued campaign could not start campaign=${campaign.id} user=${userId} reason=${reason}: ${error.message}`);
            await this._pauseQueuedCampaign(campaign, reason, error);
            return null;
        }
    }

    async queueCampaign(campaignId, userId) {
        const [campaign] = await db.enqueueCampaign(campaignId, userId);
        if (!campaign) throw new Error('Campaign is not available to queue.');
        const running = await db.count('campaigns', 'user_id = ? AND status = ?', [userId, 'running']);
        if (!running) await this._startNextQueuedCampaign(userId);
        return this._getCampaignForOwner(campaignId, userId);
    }

    async _getCampaignForOwner(campaignId, userId) {
        return db.getById('campaigns', campaignId, userId);
    }

    async unqueueCampaign(campaignId, userId) {
        const [campaign] = await db.unqueueCampaign(campaignId, userId);
        if (!campaign) throw new Error('Campaign is not queued.');
        return campaign;
    }

    async reorderQueue(userId, orderedIds) {
        return db.reorderCampaignQueue(userId, orderedIds);
    }

    normalizeQueuePositions(userId) {
        return this._normalizeQueuedPositions(userId);
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
                const page = await db.select('campaigns', '*', "status IN ('running', 'paused', 'queued')", [], 'id', pageSize, offset);
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
                    for (const duplicate of ownerCampaigns.filter(row => ['running', 'paused'].includes(row.status) && String(row.id) !== String(resumedId))) {
                        await this._update(this, 'campaigns', {
                            status: 'stopped',
                            completed_at: new Date(),
                            updated_at: new Date(),
                        }, 'id = ? AND user_id = ?', [duplicate.id, userId]);
                    }
                    continue;
                }
                ownerCampaigns.splice(0, ownerCampaigns.length, ...ownerCampaigns.filter(row => !connectionPaused.includes(row)));
            }
            const existingWorker = this._worker(userId);
            if (existingWorker?._running && existingWorker._campaignId) {
                alreadyRunning = true;
                for (const duplicate of ownerCampaigns.filter(row => ['running', 'paused'].includes(row.status))) {
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

            const activeCampaign = ownerCampaigns
                .filter(row => ['running', 'paused'].includes(row.status))
                .sort((a, b) => (a.status === 'running' ? -1 : 0) - (b.status === 'running' ? -1 : 0) || Number(a.id) - Number(b.id))[0];
            if (!activeCampaign) {
                const queuedId = await this._startNextQueuedCampaign(userId);
                if (queuedId !== null) resumed = resumed ?? queuedId;
                continue;
            }
            const settings = parseJsonField(activeCampaign.settings, {});
            const worker = this._createWorker(activeCampaign.id, userId, settings, {
                provider: activeCampaign.provider || 'web',
                paused: activeCampaign.status === 'paused',
                mediaPath: activeCampaign.media_path || null,
            });
            this._queues.set(userId, worker);
            try {
                await worker._loadCampaignMedia(activeCampaign);
            } catch (error) {
                worker._paused = true;
                await this._update(worker, 'campaigns', {
                    status: 'paused',
                    pause_reason: 'media_load_failed',
                    last_error: error.message.slice(0, 500),
                    updated_at: new Date(),
                }, 'id = ? AND user_id = ?', [activeCampaign.id, userId]);
                worker._emit('campaign:paused', {
                    campaignId: activeCampaign.id,
                    reason: 'media_load_failed',
                    error: error.message,
                });
                continue;
            }
            if (!worker._paused) this._startProcessor(worker);
            if (resumed === null) resumed = activeCampaign.id;

            for (const extra of ownerCampaigns.filter(row => ['running', 'paused'].includes(row.status) && String(row.id) !== String(activeCampaign.id))) {
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
module.exports.INTERRUPTED_MESSAGE = INTERRUPTED_MESSAGE;
module.exports.isConnectionError = isConnectionError;
module.exports.describeSendError = describeSendError;
