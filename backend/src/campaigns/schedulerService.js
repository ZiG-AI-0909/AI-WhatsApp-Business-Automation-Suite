const db = require('../database/db');
const fs = require('fs');
const crypto = require('crypto');
const excelParser = require('./excelParser');
const campaignService = require('./campaignService');
const cronParser = require('cron-parser');
const rateLimiterModule = require('./rateLimiter');
const { resolveCountryCode } = require('../utils/countryCodes');
const { isRemotePath } = require('../middleware/upload');
const { parseJsonField } = require('../utils/jsonField');
const { resolveSendSettings, JITTER_EXPECTED } = rateLimiterModule;

const { CronExpressionParser } = cronParser;

// Task 5: a due schedule whose owner's queue is busy stays pending and
// retries every poll — but no longer than 24h past next_run_at.
const BUSY_WAIT_CAP_MS = 24 * 3600000;

function parseJsonSafe(value, fallback) {
    return parseJsonField(value, fallback);
}

class SchedulerService {
    constructor() {
        this._io = null;
        this._interval = null;
        this._polling = false;
    }

    _emit(event, data) {
        // Schedule events belong to their owner; fall back to broadcast only
        // for legacy rows without a user_id (pre-Phase-1 data).
        if (data?.scheduleId) {
            const { emitToUser } = require('../realtime');
            // Per-owner emit: resolve the owner for this schedule lazily.
            // Background polling resolves legacy schedules by ID because there
            // is no request owner context at emit time; this is the sole read
            // path allowed to pass null to db.getById.
            db.getById('campaign_schedules', data.scheduleId, null).then((row) => {
                if (row?.user_id) emitToUser(this._io, row.user_id, event, data);
                else this._io?.emit(event, data);
            }).catch(() => this._io?.emit(event, data));
            return;
        }
        this._io?.emit(event, data);
    }

    _emitToUser(userId, event, data) {
        const { emitToUser } = require('../realtime');
        emitToUser(this._io, userId, event, data);
    }

    _toDbDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) throw new Error('Invalid schedule date');
        return date.toISOString().slice(0, 19).replace('T', ' ');
    }

    _nextCron(cron, from = new Date()) {
        return this._toDbDate(CronExpressionParser.parse(cron, { currentDate: from }).next().toDate());
    }

    async create(userId, { name, templateMessage, filePath, mediaPath = null, mediaType = null, mediaFilename = null, mediaMimetype = null, buttons = [], settings = {}, allowMissingFields = false, scheduleType, runAt, recurrenceCron, countryCode = null }) {
        // Resolve the code ONCE at schedule creation (per-upload override →
        // account default) so the validation-time parse and the campaign the
        // schedule later fires both use the same code.
        const resolvedCode = await resolveCountryCode(userId, countryCode);
        const result = await excelParser.parse(filePath, { countryCode: resolvedCode });
        if (excelParser.getValidRows(result).length === 0) throw new Error('No valid contacts found in the Excel file.');

        const nextRunAt = scheduleType === 'once' ? this._toDbDate(runAt) : this._nextCron(recurrenceCron);
        const status = scheduleType === 'once' ? 'pending' : 'active';
        const safeButtons = Array.isArray(buttons) ? buttons.slice(0, 3) : [];

        const created = await db.insert('campaign_schedules', {
            name: name.trim(),
            template_message: templateMessage.trim(),
            file_path: filePath,
            media_path: mediaPath,
            media_type: mediaType,
            media_filename: mediaFilename,
            media_mimetype: mediaMimetype,
            buttons: JSON.stringify(safeButtons),
            settings: JSON.stringify({ ...settings, countryCode: resolvedCode }),
            allow_missing_fields: allowMissingFields ? 1 : 0,
            schedule_type: scheduleType,
            run_at: scheduleType === 'once' ? new Date(nextRunAt) : null,
            recurrence_cron: scheduleType === 'recurring' ? recurrenceCron : null,
            status,
            next_run_at: new Date(nextRunAt),
            updated_at: new Date(),
            user_id: userId,
        });

        // Fire-and-forget: precompute the duration estimate so the first
        // table read does not have to parse the Excel file. Never blocks
        // the save.
        try { this.refreshEstimate(await this.get(created.id, userId)); } catch (error) {
            console.error(`Schedule ${created.id} post-create estimate refresh failed:`, error.message);
        }

        return this.get(created.id, userId);
    }

    async list(userId) {
        const schedules = await db.select('campaign_schedules', '*', 'user_id = ?', [userId], 'next_run_at', 1000, 0);
        const parsed = schedules.map(s => this._parseSchedule(s));
        // Attach the run-duration estimate to every runnable schedule in
        // ONE pass (Task 3.4 replaces the frontend's N parallel API calls).
        await Promise.all(parsed.map(async (s) => {
            if (!['pending', 'active'].includes(s.status)) { s.estimate = null; return; }
            try { s.estimate = await this.estimateRun(s.id, userId); } catch { s.estimate = null; }
        }));
        return parsed;
    }

    /**
     * Batched estimates for all pending/active schedules of ONE user —
     * served by GET /api/schedules/estimates. Tenant-scoped by userId.
     */
    async estimates(userId) {
        const schedules = (await db.select('campaign_schedules', '*', 'user_id = ?', [userId], 'next_run_at', 1000, 0))
            .map(s => this._parseSchedule(s))
            .filter(s => ['pending', 'active'].includes(s.status));
        return Promise.all(schedules.map(async (s) => {
            try { return await this.estimateRun(s.id, userId); } catch { return null; }
        }));
    }

    _parseSchedule(schedule) {
        if (!schedule) return schedule;
        schedule.buttons = parseJsonField(schedule.buttons, []);
        schedule.settings = parseJsonField(schedule.settings, {});
        if (schedule.created_at && schedule.created_at instanceof Date) {
            schedule.created_at = schedule.created_at.toISOString();
        }
        if (schedule.updated_at && schedule.updated_at instanceof Date) {
            schedule.updated_at = schedule.updated_at.toISOString();
        }
        if (schedule.run_at && schedule.run_at instanceof Date) {
            schedule.run_at = schedule.run_at.toISOString();
        }
        if (schedule.last_run_at && schedule.last_run_at instanceof Date) {
            schedule.last_run_at = schedule.last_run_at.toISOString();
        }
        if (schedule.next_run_at && schedule.next_run_at instanceof Date) {
            schedule.next_run_at = schedule.next_run_at.toISOString();
        }
        return schedule;
    }

    async get(id, userId) {
        const schedule = await db.getById('campaign_schedules', id, userId);
        return this._parseSchedule(schedule);
    }

    /**
     * Pure duration math shared by estimateRun (live) and the Task-3 cache
     * refresh. Mirrors the real send loop: per-message delay × the rate
     * limiter's jitter EXPECTED value (uniform [0.7, 1.4] → 1.05), hourly
     * and daily caps, and business-hours spillover evaluated in the SAME
     * timezone as the send loop. Retries, network latency and connection
     * revival time are deliberately not included — an "aprox" figure that
     * errs on the optimistic side.
     */
    _computeDurationMs(settings, contacts) {
        const s = resolveSendSettings(settings);
        const delay = Number(s.delayBetweenMessages) || 17500;

        // Pure sending time: contacts × delay × expected jitter multiplier.
        let ms = contacts * delay * JITTER_EXPECTED;

        // Hourly cap: sends beyond maxPerHour wait in 60s polls until the
        // hour window frees up — that is the same as stretching the send
        // time to ceil(contacts / maxPerHour) hours of wall clock.
        if (s.maxPerHour > 0 && contacts > s.maxPerHour) {
            ms = Math.max(ms, (Math.ceil(contacts / s.maxPerHour) - 1) * 3600000 + (contacts % s.maxPerHour || s.maxPerHour) * delay * JITTER_EXPECTED);
        }

        // Daily cap: batches that cannot fit under maxPerDay spill into
        // additional days.
        if (s.maxPerDay > 0 && contacts > s.maxPerDay) {
            const days = Math.floor(contacts / s.maxPerDay);
            ms += days * 24 * 3600000; // extra wall-clock days for the capped sends
        }

        return Math.round(ms);
    }

    /**
     * Cache key for the expensive parts of the estimate (contact count +
     * duration math): file identity + settings. The stored estimate is
     * reused while this hash is unchanged.
     */
    _estimateSourceHash(schedule) {
        const parts = [String(schedule.file_path || '')];
        // Local files: size + mtime make edits visible. Remote (Supabase
        // Storage) files have no cheap stat — their path identity and the
        // schedule row's updated_at stand in for it.
        if (!isRemotePath(schedule.file_path)) {
            try {
                const stat = fs.statSync(schedule.file_path);
                parts.push(String(stat.size), String(stat.mtimeMs));
            } catch { /* missing file: hash is path-only; parse will fail later */ }
        } else {
            parts.push('remote');
        }
        // settings is already a parsed object here (schedule went through
        // _parseSchedule); stringify in a deterministic key order.
        const settingsObj = (schedule.settings && typeof schedule.settings === 'object') ? schedule.settings : {};
        parts.push(JSON.stringify(settingsObj, Object.keys(settingsObj).sort()));
        return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
    }

    /**
     * Time calculator: estimate how long ONE run of this schedule will take
     * from start to end (campaign creation → queue drain), and when it will
     * approximately finish.
     *
     * The expensive parts (Excel parse, duration math) are cached on the
     * schedule row (estimate_json / estimate_computed_at /
     * estimate_source_hash) and reused while the file and settings are
     * unchanged. Only startAt/endAt are recomputed on every read, because
     * "now" moves.
     */
    async estimateRun(id, userId) {
        const schedule = await this.get(id, userId);
        if (!schedule) return null;

        const hash = this._estimateSourceHash(schedule);
        let cached = null;
        if (schedule.estimate_source_hash === hash && schedule.estimate_json) {
            cached = parseJsonField(schedule.estimate_json, null);
        }

        if (!cached || !Number.isFinite(cached.durationMs)) {
            cached = await this._computeAndStoreEstimate(schedule, hash);
        }

        const durationMs = Math.round(cached.durationMs);

        // Anchor to the next time this schedule will actually fire —
        // recalculated on EVERY read because "now" changes.
        const now = new Date();
        let startAt = now;
        if (schedule.status === 'paused') {
            startAt = null; // unknown until resumed — duration is still shown
        } else if (schedule.schedule_type === 'once') {
            startAt = schedule.run_at && new Date(schedule.run_at) > now ? new Date(schedule.run_at) : now;
        } else if (schedule.next_run_at) {
            startAt = new Date(schedule.next_run_at);
        }

        return {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            scheduleType: schedule.schedule_type,
            contacts: cached.contacts,
            durationMs,
            durationLabel: this._humanDuration(durationMs),
            startAt: startAt ? startAt.toISOString() : null,
            endAt: startAt ? new Date(startAt.getTime() + durationMs).toISOString() : null,
            computedAt: schedule.estimate_computed_at || null,
        };
    }

    /**
     * Recompute (contacts, duration) and persist on the schedule row.
     * Never throws — estimate failures must not break reads or saves.
     */
    async _computeAndStoreEstimate(schedule, hash, userIdForScope = null) {
        try {
            const contacts = await this._countSendableContacts(schedule);
            const durationMs = this._computeDurationMs(schedule.settings || {}, contacts);
            const payload = JSON.stringify({ contacts, durationMs });
            await db.update('campaign_schedules', {
                estimate_json: payload,
                estimate_computed_at: new Date(),
                estimate_source_hash: hash,
                updated_at: new Date(),
            }, 'id = ? AND user_id = ?', [schedule.id, userIdForScope || schedule.user_id]).catch(error =>
                console.error(`Schedule ${schedule.id} estimate cache write failed:`, error.message)
            );
            return { contacts, durationMs };
        } catch (error) {
            console.error(`Schedule ${schedule.id} estimate computation failed:`, error.message);
            return { contacts: 0, durationMs: 0 };
        }
    }

    /**
     * Fire-and-forget cache refresh after create/edit. Never blocks the
     * save and never rejects.
     */
    refreshEstimate(schedule) {
        const hash = this._estimateSourceHash(schedule);
        this._computeAndStoreEstimate({ ...schedule, estimate_source_hash: null }, hash)
            .catch(error => console.error(`Schedule ${schedule.id} estimate refresh failed:`, error.message));
    }

    async _countSendableContacts(schedule) {
        // Reuse the same parsing rules as campaign creation so the estimate
        // matches what will actually be queued.
        try {
            const filePath = await require('./campaignService')._resolveExcelSource(schedule.file_path);
            const resolvedCode = schedule.settings?.countryCode || null;
            const result = await excelParser.parse(filePath, { countryCode: resolvedCode });
            const validRows = excelParser.getValidRows(result);
            if (!validRows.length) return 0;
            // Same opt-out filter campaignService.create() applies at
            // queue-build time: contacts with marketing_opt_in = false are
            // marked opted_out without a send. Selecting all opted-out
            // phones for the owner avoids a huge IN() filter.
            const optedOut = await db.select(
                'contacts',
                'phone',
                'user_id = ? AND marketing_opt_in = ?',
                [schedule.user_id, 0]
            );
            const optedPhones = new Set((optedOut || []).map(c => String(c.phone)));
            return validRows.filter(r => !optedPhones.has(String(r[result.phoneColumn] || r._phone || ''))).length;
        } catch (error) {
            console.error(`Schedule ${schedule.id} estimate: contact count failed:`, error.message);
            return 0;
        }
    }

    _humanDuration(ms) {
        if (ms <= 0) return '< 1 min';
        const days = Math.floor(ms / 86400000);
        const hours = Math.floor((ms % 86400000) / 3600000);
        const minutes = Math.ceil((ms % 3600000) / 60000);
        const parts = [];
        if (days) parts.push(`${days}d`);
        if (hours) parts.push(`${hours}h`);
        if (minutes && !days) parts.push(`${minutes}m`);
        return parts.join(' ') || '< 1 min';
    }

    async pause(id, userId) {
        const schedule = await this.get(id, userId);
        if (!schedule || !['active', 'pending'].includes(schedule.status)) throw new Error('Schedule cannot be paused in its current state.');
        // Pausing invalidates a parked (busy-waiting) campaign reference.
        const updated = await db.update('campaign_schedules', {
            status: 'paused',
            pending_campaign_id: null,
            updated_at: new Date(),
        }, 'id = ? AND user_id = ?', [id, userId]);
        return this._parseSchedule(Array.isArray(updated) ? updated[0] : updated);
    }

    async resume(id, userId) {
        const schedule = await this.get(id, userId);
        if (!schedule || schedule.status !== 'paused') throw new Error('Only paused schedules can be resumed.');
        const newStatus = schedule.schedule_type === 'once' ? 'pending' : 'active';
        const updated = await db.update('campaign_schedules', {
            status: newStatus,
            updated_at: new Date(),
        }, 'id = ? AND user_id = ?', [id, userId]);
        return this._parseSchedule(Array.isArray(updated) ? updated[0] : updated);
    }

    async retry(id, userId) {
        const schedule = await this.get(id, userId);
        if (!schedule || !['failed', 'skipped'].includes(schedule.status)) throw new Error('Only failed or skipped schedules can be retried.');
        const status = schedule.schedule_type === 'once' ? 'pending' : 'active';
        const updated = await db.update('campaign_schedules', {
            status,
            next_run_at: new Date(),
            last_error: null,
            pending_campaign_id: null,
            updated_at: new Date(),
        }, 'id = ? AND user_id = ?', [id, userId]);
        return this._parseSchedule(Array.isArray(updated) ? updated[0] : updated);
    }

    async cancel(id, userId) {
        const schedule = await this.get(id, userId);
        if (!schedule) return;
        const updated = await db.update('campaign_schedules', {
            status: 'cancelled',
            updated_at: new Date(),
        }, 'id = ? AND user_id = ?', [id, userId]);
        return this._parseSchedule(Array.isArray(updated) ? updated[0] : updated);
    }

    async delete(id, userId) {
        const schedule = await this.get(id, userId);
        if (!schedule) return;
        if (schedule.status === 'active') await this.cancel(id, userId);
        await db.del('campaign_schedules', 'id = ? AND user_id = ?', [id, userId]);
    }

    async deleteMany(ids, userId) {
        for (const id of ids) {
            await this.delete(id, userId);
        }
    }

    async _fireDueSchedules() {
        if (this._polling) return;
        this._polling = true;
        try {
            const now = new Date();
            let dueSchedules = [];
            try {
                dueSchedules = await db.select(
                    'campaign_schedules',
                    '*',
                    '(status = ? OR status = ?) AND next_run_at <= ?',
                    ['pending', 'active', now],
                    'next_run_at',
                    100,
                    0
                );
            } catch (error) {
                // Transient DB outage: skip this pass silently-ish; the next
                // 30s poll retries. Do not turn this into an unhandled
                // rejection — startPolling() calls this without awaiting.
                console.error('[scheduler] poll failed to read schedules — will retry:', error.message);
                return;
            }

            for (const schedule of dueSchedules) {
                // Per-user connection check: the schedule fires only if ITS
                // OWNER's own WhatsApp connection is live. Background sending
                // never depends on the browser being open. If the owner's
                // session is down (e.g. the 2h idle timeout dropped it), we
                // first TRY to revive it from the stored Supabase auth state
                // — scheduled sends must not silently wait for a human to
                // open the app. Only when revival fails do we skip, and we
                // record WHY on the schedule row so the wait is visible in
                // the UI instead of being a silent limbo.
                let ownerConnected = false;
                try {
                    const provider = schedule.provider || 'web';
                    if (provider === 'business') {
                        const businessApiProvider = require('../whatsapp/businessApiProvider');
                        ownerConnected = businessApiProvider.getStatus(schedule.user_id) === 'connected';
                    } else {
                        const sessionManager = require('../whatsapp/sessionManager');
                        if (sessionManager.getStatus(schedule.user_id) === 'connected') {
                            ownerConnected = true;
                        } else {
                            ownerConnected = await sessionManager.ensureConnected(
                                schedule.user_id,
                                Number(process.env.WA_SCHEDULE_REVIVE_TIMEOUT_MS || 45000)
                            );
                        }
                    }
                } catch { ownerConnected = false; }
                if (!ownerConnected) {
                    console.log(`Schedule ${schedule.id} waiting: owner ${schedule.user_id} has no connected WhatsApp session (auto-reconnect attempted).`);
                    const waitReason = 'Waiting for WhatsApp connection. Reconnect WhatsApp (Settings → Connection) to let this schedule run.';
                    await db.update('campaign_schedules', {
                        last_error: waitReason,
                        updated_at: new Date(),
                    }, 'id = ? AND user_id = ? AND status IN (\'pending\', \'active\')', [schedule.id, schedule.user_id]).catch(() => {});
                    this._emitToUser(schedule.user_id, 'schedule:waiting_connection', {
                        scheduleId: schedule.id,
                        name: schedule.name,
                        error: waitReason,
                    });
                    continue;
                }
                if (schedule.schedule_type === 'recurring' && schedule.last_campaign_id) {
                    const previousCampaign = await db.getById('campaigns', schedule.last_campaign_id, schedule.user_id);
                    if (previousCampaign?.status === 'running') {
                        console.warn(`Schedule ${schedule.id} skipped because campaign ${schedule.last_campaign_id} is still running.`);
                        const nextRun = this._nextCron(schedule.recurrence_cron, new Date());
                        await db.update('campaign_schedules', {
                            next_run_at: new Date(nextRun),
                            updated_at: new Date(),
                        }, 'id = ? AND user_id = ? AND status = ?', [schedule.id, schedule.user_id, 'active']);
                        this._emit('schedule:skipped_overlap', { scheduleId: schedule.id });
                        continue;
                    }
                }
                try {
                    // Task 5.2: if a previous attempt created a campaign but
                    // could not start it (owner queue busy), REUSE that
                    // campaign on this attempt instead of creating another
                    // one — no duplicate rows accumulate per poll.
                    let campaign = null;
                    if (schedule.pending_campaign_id) {
                        try { campaign = await db.getById('campaigns', schedule.pending_campaign_id, schedule.user_id); } catch { campaign = null; }
                        if (campaign && !['draft', 'stopped', 'paused'].includes(campaign.status)) campaign = null; // unusable
                    }
                    if (!campaign) {
                        campaign = await campaignService.create(schedule.user_id, {
                            name: `${schedule.name} - ${new Date().toISOString()}`,
                            templateMessage: schedule.template_message,
                            filePath: schedule.file_path,
                            mediaPath: schedule.media_path,
                            mediaType: schedule.media_type,
                            mediaFilename: schedule.media_filename,
                            mediaMimetype: schedule.media_mimetype,
                            buttons: parseJsonSafe(schedule.buttons, []),
                            settings: parseJsonSafe(schedule.settings, {}),
                            allowMissingFields: !!schedule.allow_missing_fields,
                            // The schedule's stored code wins over the account default
                            // so the fired campaign matches the numbers it validated.
                            countryCode: parseJsonSafe(schedule.settings, {}).countryCode || null,
                        });
                    }
                    try {
                        await campaignService.start(campaign.id, this._io, schedule.user_id);
                    } catch (startError) {
                        if (/A campaign is already running/i.test(startError.message)) {
                            // Task 5.1: owner's queue is busy. Do NOT mark the
                            // schedule failed; leave it pending so the next
                            // poll retries after the running campaign drains.
                            // Task 5.2: remember the created campaign so the
                            // retry reuses it instead of creating duplicates.
                            const waitedMs = schedule.next_run_at ? new Date().getTime() - new Date(schedule.next_run_at).getTime() : 0;
                            if (waitedMs > BUSY_WAIT_CAP_MS) {
                                // 24h cap: give up with a clear reason.
                                await db.update('campaign_schedules', {
                                    status: 'skipped',
                                    last_error: `Skipped: the previous campaign was still running for more than 24h past the scheduled time (${schedule.next_run_at}).` ,
                                    last_run_at: new Date(),
                                    updated_at: new Date(),
                                }, 'id = ? AND user_id = ? AND status = ?', [schedule.id, schedule.user_id, 'pending']);
                                this._emit('schedule:skipped_busy', { scheduleId: schedule.id, name: schedule.name });
                                continue;
                            }
                            await db.update(
                                'campaign_schedules',
                                {
                                    last_error: 'Waiting for the running campaign to finish',
                                    pending_campaign_id: campaign.id,
                                    last_run_at: new Date(),
                                    updated_at: new Date(),
                                },
                                'id = ? AND user_id = ? AND status = ?', [schedule.id, schedule.user_id, 'pending']
                            );
                            console.warn(`[scheduler] schedule ${schedule.id}: owner queue busy — waiting (campaign ${campaign.id} parked for reuse).`);
                            this._emit('schedule:waiting_queue', { scheduleId: schedule.id, name: schedule.name });
                            continue;
                        }
                        throw startError;
                    }

                    const nextRunAt = schedule.schedule_type === 'recurring' ? this._nextCron(schedule.recurrence_cron, new Date()) : null;
                    await db.update('campaign_schedules', {
                        last_run_at: new Date(),
                        last_campaign_id: campaign.id,
                        last_error: null,
                        pending_campaign_id: null,
                        status: schedule.schedule_type === 'once' ? 'completed' : schedule.status,
                        next_run_at: schedule.schedule_type === 'recurring' ? new Date(nextRunAt) : null,
                        updated_at: new Date(),
                    }, 'id = ? AND user_id = ?', [schedule.id, schedule.user_id]);

                    this._emit('schedule:fired', { scheduleId: schedule.id, campaignId: campaign.id });
                } catch (error) {
                    const nextRunAt = schedule.schedule_type === 'recurring' ? this._nextCron(schedule.recurrence_cron, new Date()) : schedule.next_run_at;
                    await db.update('campaign_schedules', {
                        status: schedule.schedule_type === 'once' ? 'failed' : 'active',
                        last_error: error.message,
                        last_run_at: new Date(),
                        next_run_at: new Date(nextRunAt),
                        updated_at: new Date(),
                    }, 'id = ? AND user_id = ?', [schedule.id, schedule.user_id]);
                    console.error(`Schedule ${schedule.id} failed:`, error.message);
                    this._emit('schedule:failed', { scheduleId: schedule.id, name: schedule.name, error: error.message });
                }
            }
        } finally {
            this._polling = false;
        }
    }

    startPolling(io) {
        this._io = io;
        if (this._interval) return;
        this._fireDueSchedules();
        this._interval = setInterval(() => this._fireDueSchedules(), 30000);
    }
}

module.exports = new SchedulerService();
