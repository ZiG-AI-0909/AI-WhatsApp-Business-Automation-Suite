// =============================================================
// Delivery receipts for campaign messages.
//
// Sources:
//   - WhatsApp Business Platform webhook `statuses` (sent, delivered,
//     read, failed) — matched by the wamid returned at send time, or by
//     biz_opaque_callback_data "cc:<campaign_contacts.id>" when the send
//     result was never recorded (crash between send and database write).
//   - WhatsApp Web (Baileys) `messages.update` acks — matched by the
//     message id the queue assigns BEFORE sending.
//
// Effects:
//   - delivery_status / delivered_at / read_at (forward only), and the
//     campaign's delivered/read counters (needs the delivery migration);
//   - a message reported failed after it was accepted becomes a failed
//     recipient (or opted out for WhatsApp's marketing opt-out, 131050);
//     restriction errors pause the running campaign;
//   - a recipient whose send was interrupted ("delivery unknown") is
//     confirmed as sent when a receipt proves the message went out, so
//     it is never resent.
// =============================================================
const db = require('../database/db');
const contactService = require('../contacts/contactService');
const { classifySendError } = require('./sendPolicy');
const { isCampaignDeliveryMigrationAvailable } = require('../database/campaignDeliveryMigrationGuard');
const campaignLog = require('./campaignLog');
const { emitToUser } = require('../realtime');

const RANK = { sent: 1, delivered: 2, read: 3 };
const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);
// Shared with messageQueue: rows whose send outcome is unknown.
const INTERRUPTED_PREFIX = 'Sending was interrupted';
const RECOUNT_DELAY_MS = 3000;

class DeliveryTracker {
    constructor() {
        this._io = null;
        this._pending = new Map(); // `${userId}:${campaignId}` -> { timer, run }
    }

    setIO(io) { this._io = io; }

    _queue() { return require('./messageQueue'); } // lazy: messageQueue requires this module

    /**
     * @param {string} userId owner of the sending number
     * @param {{messageId: string, status: string, timestamp?: number,
     *          errors?: Array<{code, title, details}>, callbackData?: string}} receipt
     */
    async applyReceipt(userId, receipt) {
        const messageId = receipt?.messageId ? String(receipt.messageId) : '';
        const status = String(receipt?.status || '').toLowerCase();
        if (!userId || !messageId || !STATUSES.has(status)) return null;

        const row = await this._findRow(userId, messageId, receipt.callbackData);
        if (!row) return null; // not a campaign message (inbox reply, test send, …)

        const at = new Date(Number.isFinite(Number(receipt.timestamp)) ? Number(receipt.timestamp) : Date.now());
        const migrated = isCampaignDeliveryMigrationAvailable();
        if (status === 'failed') return this._applyFailure(userId, row, messageId, receipt, migrated);

        const changes = {};
        // A receipt proves the message went out: adopt recipients whose send
        // outcome was unknown (in flight, reset to pending by a connection
        // pause, skipped by Stop mid-send, or marked interrupted at restart).
        const outcomeUnknown = ['processing', 'pending', 'skipped'].includes(row.status)
            || (row.status === 'failed' && String(row.last_error || '').startsWith(INTERRUPTED_PREFIX));
        if (outcomeUnknown) {
            Object.assign(changes, { status: 'sent', sent_at: row.sent_at || at, last_error: null, retry_at: null });
            if (!row.provider_message_id) changes.provider_message_id = messageId;
        }
        if (migrated && (RANK[status] || 0) > (RANK[row.delivery_status] || 0)) {
            changes.delivery_status = status;
            if (status !== 'sent' && !row.delivered_at) changes.delivered_at = at;
            if (status === 'read' && !row.read_at) changes.read_at = at;
        }
        if (!Object.keys(changes).length) return { row, changed: false };

        await db.update('campaign_contacts', changes, 'id = ? AND user_id = ?', [row.id, userId]);
        if (changes.status) {
            await db.recountCampaignCounters(row.campaign_id, userId);
            campaignLog.info('interrupted_send_confirmed', { campaign: row.campaign_id, contact: row.id, receipt: status });
        }
        this._scheduleRecount(userId, row.campaign_id, migrated);
        return { row: { ...row, ...changes }, changed: true };
    }

    async _findRow(userId, messageId, callbackData) {
        const [byMessageId] = await db.select(
            'campaign_contacts',
            '*',
            'user_id = ? AND provider_message_id = ?',
            [userId, messageId],
            'id',
            1,
            0,
        );
        if (byMessageId) return byMessageId;
        const match = /^cc:(\d+)$/.exec(String(callbackData || ''));
        if (!match) return null;
        const row = await db.getById('campaign_contacts', Number(match[1]), userId);
        // Never re-point a recipient that already belongs to another message.
        if (!row || (row.provider_message_id && row.provider_message_id !== messageId)) return null;
        return row;
    }

    async _applyFailure(userId, row, messageId, receipt, migrated) {
        const error = Array.isArray(receipt.errors) && receipt.errors[0] ? receipt.errors[0] : {};
        const code = error.code !== undefined && error.code !== null ? String(error.code) : null;
        const policy = classifySendError({
            message: error.title || '',
            response: { data: { error: { code: error.code, message: error.title, error_data: { details: error.details } } } },
        });
        const detail = [error.title, error.details].filter(Boolean).join(': ') || 'WhatsApp could not deliver this message';
        const lastError = `WhatsApp reported the message as not delivered: ${detail}${code ? ` (code ${code})` : ''}`.slice(0, 500);
        const extra = migrated ? { delivery_status: 'failed', error_code: code } : {};
        if (!row.provider_message_id) extra.provider_message_id = messageId;

        if (policy.kind === 'opt_out') {
            await this._optOutContact(userId, row.contact_id);
            await db.update('campaign_contacts', { status: 'opted_out', last_error: lastError, retry_at: null, ...extra }, 'id = ? AND user_id = ?', [row.id, userId]);
        } else {
            await db.update('campaign_contacts', { status: 'failed', last_error: lastError, retry_at: null, ...extra }, 'id = ? AND user_id = ?', [row.id, userId]);
        }
        const counters = await db.recountCampaignCounters(row.campaign_id, userId);
        await this._markCompletedWithErrors(userId, row.campaign_id, counters);
        campaignLog.warn('delivery_failed', { campaign: row.campaign_id, contact: row.id, code, kind: policy.kind });

        const queue = this._queue();
        if (policy.kind !== 'opt_out') queue.recordAsyncOutcome?.(userId, row.campaign_id, 'failed');
        if (policy.kind === 'pause') {
            await queue.pauseForProviderSignal(userId, row.campaign_id, policy.pauseReason, lastError);
        }
        this._scheduleRecount(userId, row.campaign_id, migrated);
        return { row, changed: true, failed: true, kind: policy.kind };
    }

    async _optOutContact(userId, contactId) {
        if (!contactId) return;
        const contact = await db.getById('contacts', contactId, userId);
        if (contact?.phone) await contactService.setOptOut(contact.phone, userId, 'whatsapp');
    }

    async _markCompletedWithErrors(userId, campaignId, counters) {
        if (!counters || !(Number(counters.failed) > 0)) return;
        const campaign = await db.getById('campaigns', campaignId, userId);
        if (campaign?.status === 'completed') {
            await db.update('campaigns', { status: 'completed_with_errors', updated_at: new Date() }, 'id = ? AND user_id = ? AND status = ?', [campaignId, userId, 'completed']);
        }
    }

    /** Receipts arrive in bursts; recount and notify at most every few seconds per campaign. */
    _scheduleRecount(userId, campaignId, migrated) {
        const key = `${userId}:${campaignId}`;
        if (this._pending.has(key)) return;
        const run = async () => {
            this._pending.delete(key);
            try {
                if (migrated) await db.recountCampaignDelivery(campaignId, userId);
                const campaign = await db.getById('campaigns', campaignId, userId);
                if (campaign) emitToUser(this._io || this._queue()._io, userId, 'campaign:progress', campaign);
            } catch (error) {
                campaignLog.error('delivery_recount_failed', { campaign: campaignId, error: error.message });
            }
        };
        const timer = setTimeout(run, RECOUNT_DELAY_MS);
        timer.unref?.();
        this._pending.set(key, { timer, run });
    }

    /** Run pending recounts now (tests, shutdown). */
    async flush() {
        const pending = [...this._pending.values()];
        for (const { timer } of pending) clearTimeout(timer);
        await Promise.all(pending.map(({ run }) => run()));
    }
}

module.exports = new DeliveryTracker();
module.exports.INTERRUPTED_PREFIX = INTERRUPTED_PREFIX;
