const db = require('../database/db');
const excelParser = require('./excelParser');
const campaignService = require('./campaignService');
const providerManager = require('../whatsapp/providerManager');
const cronParser = require('cron-parser');

const { CronExpressionParser } = cronParser;

class SchedulerService {
    constructor() {
        this._io = null;
        this._interval = null;
        this._polling = false;
    }

    _emit(event, data) { this._io?.emit(event, data); }

    _toDbDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) throw new Error('Invalid schedule date');
        return date.toISOString().slice(0, 19).replace('T', ' ');
    }

    _nextCron(cron, from = new Date()) {
        return this._toDbDate(CronExpressionParser.parse(cron, { currentDate: from }).next().toDate());
    }

    async create({ name, templateMessage, filePath, mediaPath = null, mediaType = null, mediaFilename = null, mediaMimetype = null, buttons = [], settings = {}, allowMissingFields = false, scheduleType, runAt, recurrenceCron }) {
        const result = excelParser.parse(filePath);
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
            settings: JSON.stringify(settings),
            allow_missing_fields: allowMissingFields ? 1 : 0,
            schedule_type: scheduleType,
            run_at: scheduleType === 'once' ? new Date(nextRunAt) : null,
            recurrence_cron: scheduleType === 'recurring' ? recurrenceCron : null,
            status,
            next_run_at: new Date(nextRunAt),
            updated_at: new Date(),
        });

        return this.get(created.id);
    }

    async list() {
        const schedules = await db.select('campaign_schedules', '*', '', [], 'next_run_at', 1000, 0);
        return schedules.map(s => this._parseSchedule(s));
    }

    _parseSchedule(schedule) {
        if (!schedule) return schedule;
        try { schedule.buttons = JSON.parse(schedule.buttons || '[]'); } catch { schedule.buttons = []; }
        try { schedule.settings = JSON.parse(schedule.settings || '{}'); } catch { schedule.settings = {}; }
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

    async get(id) {
        const schedule = await db.getById('campaign_schedules', id);
        return this._parseSchedule(schedule);
    }

    async pause(id) {
        const schedule = await this.get(id);
        if (!schedule || !['active', 'pending'].includes(schedule.status)) throw new Error('Schedule cannot be paused in its current state.');
        const updated = await db.update('campaign_schedules', {
            status: 'paused',
            updated_at: new Date(),
        }, 'id = ?', [id]);
        return this._parseSchedule(Array.isArray(updated) ? updated[0] : updated);
    }

    async resume(id) {
        const schedule = await this.get(id);
        if (!schedule || schedule.status !== 'paused') throw new Error('Only paused schedules can be resumed.');
        const newStatus = schedule.schedule_type === 'once' ? 'pending' : 'active';
        const updated = await db.update('campaign_schedules', {
            status: newStatus,
            updated_at: new Date(),
        }, 'id = ?', [id]);
        return this._parseSchedule(Array.isArray(updated) ? updated[0] : updated);
    }

    async retry(id) {
        const schedule = await this.get(id);
        if (!schedule || schedule.status !== 'failed') throw new Error('Only failed schedules can be retried.');
        const status = schedule.schedule_type === 'once' ? 'pending' : 'active';
        const updated = await db.update('campaign_schedules', {
            status,
            next_run_at: new Date(),
            last_error: null,
            updated_at: new Date(),
        }, 'id = ?', [id]);
        return this._parseSchedule(Array.isArray(updated) ? updated[0] : updated);
    }

    async cancel(id) {
        const schedule = await this.get(id);
        if (!schedule) return;
        const updated = await db.update('campaign_schedules', {
            status: 'cancelled',
            updated_at: new Date(),
        }, 'id = ?', [id]);
        return this._parseSchedule(Array.isArray(updated) ? updated[0] : updated);
    }

    async delete(id) {
        const schedule = await this.get(id);
        if (!schedule) return;
        if (schedule.status === 'active') await this.cancel(id);
        await db.del('campaign_schedules', 'id = ?', [id]);
    }

    async deleteMany(ids) {
        for (const id of ids) {
            await this.delete(id);
        }
    }

    async _fireDueSchedules() {
        if (this._polling) return;
        this._polling = true;
        try {
            const now = new Date();
            const dueSchedules = await db.select(
                'campaign_schedules',
                '*',
                '(status = ? OR status = ?) AND next_run_at <= ?',
                ['pending', 'active', now],
                'next_run_at',
                100,
                0
            );

            for (const schedule of dueSchedules) {
                if (providerManager.getStatus() !== 'connected') {
                    console.log(`Schedule ${schedule.id} is waiting for a connected WhatsApp provider.`);
                    this._emit('schedule:waiting_connection', { scheduleId: schedule.id });
                    continue;
                }
                if (schedule.schedule_type === 'recurring' && schedule.last_campaign_id) {
                    const previousCampaign = await db.getById('campaigns', schedule.last_campaign_id);
                    if (previousCampaign?.status === 'running') {
                        console.warn(`Schedule ${schedule.id} skipped because campaign ${schedule.last_campaign_id} is still running.`);
                        const nextRun = this._nextCron(schedule.recurrence_cron, new Date());
                        await db.update('campaign_schedules', {
                            next_run_at: new Date(nextRun),
                            updated_at: new Date(),
                        }, 'id = ? AND status = ?', [schedule.id, 'active']);
                        this._emit('schedule:skipped_overlap', { scheduleId: schedule.id });
                        continue;
                    }
                }
                try {
                    const campaign = await campaignService.create({
                        name: `${schedule.name} - ${new Date().toISOString()}`,
                        templateMessage: schedule.template_message,
                        filePath: schedule.file_path,
                        mediaPath: schedule.media_path,
                        mediaType: schedule.media_type,
                        mediaFilename: schedule.media_filename,
                        mediaMimetype: schedule.media_mimetype,
                        buttons: JSON.parse(schedule.buttons || '[]'),
                        settings: JSON.parse(schedule.settings || '{}'),
                        allowMissingFields: !!schedule.allow_missing_fields,
                    });
                    await campaignService.start(campaign.id, providerManager, this._io);

                    const nextRunAt = schedule.schedule_type === 'recurring' ? this._nextCron(schedule.recurrence_cron, new Date()) : null;
                    await db.update('campaign_schedules', {
                        last_run_at: new Date(),
                        last_campaign_id: campaign.id,
                        last_error: null,
                        status: schedule.schedule_type === 'once' ? 'completed' : schedule.status,
                        next_run_at: schedule.schedule_type === 'recurring' ? new Date(nextRunAt) : null,
                        updated_at: new Date(),
                    }, 'id = ?', [schedule.id]);

                    this._emit('schedule:fired', { scheduleId: schedule.id, campaignId: campaign.id });
                } catch (error) {
                    const nextRunAt = schedule.schedule_type === 'recurring' ? this._nextCron(schedule.recurrence_cron, new Date()) : schedule.next_run_at;
                    await db.update('campaign_schedules', {
                        status: schedule.schedule_type === 'once' ? 'failed' : 'active',
                        last_error: error.message,
                        last_run_at: new Date(),
                        next_run_at: new Date(nextRunAt),
                        updated_at: new Date(),
                    }, 'id = ?', [schedule.id]);
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