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

    create({ name, templateMessage, filePath, mediaPath = null, mediaType = null, mediaFilename = null, mediaMimetype = null, buttons = [], settings = {}, allowMissingFields = false, scheduleType, runAt, recurrenceCron }) {
        const result = excelParser.parse(filePath);
        if (excelParser.getValidRows(result).length === 0) throw new Error('No valid contacts found in the Excel file.');

        const nextRunAt = scheduleType === 'once' ? this._toDbDate(runAt) : this._nextCron(recurrenceCron);
        const status = scheduleType === 'once' ? 'pending' : 'active';
        const safeButtons = Array.isArray(buttons) ? buttons.slice(0, 3) : [];
        const inserted = db.prepare(`
            INSERT INTO campaign_schedules
            (name, template_message, file_path, media_path, media_type, media_filename, media_mimetype, buttons, settings, allow_missing_fields, schedule_type, run_at, recurrence_cron, status, next_run_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(name.trim(), templateMessage.trim(), filePath, mediaPath, mediaType, mediaFilename, mediaMimetype, JSON.stringify(safeButtons), JSON.stringify(settings), allowMissingFields ? 1 : 0, scheduleType, scheduleType === 'once' ? nextRunAt : null, scheduleType === 'recurring' ? recurrenceCron : null, status, nextRunAt);
        return this.get(inserted.lastInsertRowid);
    }

    list() { return db.prepare('SELECT * FROM campaign_schedules ORDER BY next_run_at ASC, created_at DESC').all(); }
    get(id) { return db.prepare('SELECT * FROM campaign_schedules WHERE id=?').get(id); }

    pause(id) {
        const schedule = this.get(id);
        if (!schedule || !['active', 'pending'].includes(schedule.status)) throw new Error('Schedule cannot be paused in its current state.');
        db.prepare("UPDATE campaign_schedules SET status='paused', updated_at=datetime('now') WHERE id=?").run(id);
        return this.get(id);
    }

    resume(id) {
        const schedule = this.get(id);
        if (!schedule || schedule.status !== 'paused') throw new Error('Only paused schedules can be resumed.');
        db.prepare("UPDATE campaign_schedules SET status=?, updated_at=datetime('now') WHERE id=?").run(schedule.schedule_type === 'once' ? 'pending' : 'active', id);
        return this.get(id);
    }

    retry(id) {
        const schedule = this.get(id);
        if (!schedule || schedule.status !== 'failed') throw new Error('Only failed schedules can be retried.');
        const status = schedule.schedule_type === 'once' ? 'pending' : 'active';
        db.prepare("UPDATE campaign_schedules SET status=?, next_run_at=datetime('now'), last_error=NULL, updated_at=datetime('now') WHERE id=?").run(status, id);
        return this.get(id);
    }

    cancel(id) {
        const schedule = this.get(id);
        if (!schedule) throw new Error('Schedule not found.');
        db.prepare("UPDATE campaign_schedules SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(id);
        return this.get(id);
    }

    delete(id) {
        const schedule = this.get(id);
        if (!schedule) return;
        if (schedule.status === 'active') this.cancel(id);
        db.prepare('DELETE FROM campaign_schedules WHERE id=?').run(id);
    }

    deleteMany(ids) {
        db.exec('BEGIN');
        try {
            for (const id of ids) this.delete(id);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    async _fireDueSchedules() {
        if (this._polling) return;
        this._polling = true;
        try {
            const due = db.prepare("SELECT * FROM campaign_schedules WHERE status IN ('pending','active') AND next_run_at <= datetime('now') ORDER BY next_run_at ASC").all();
            for (const schedule of due) {
                if (providerManager.getStatus() !== 'connected') {
                    console.log(`Schedule ${schedule.id} is waiting for a connected WhatsApp provider.`);
                    this._emit('schedule:waiting_connection', { scheduleId: schedule.id });
                    continue;
                }
                if (schedule.schedule_type === 'recurring' && schedule.last_campaign_id) {
                    const previousCampaign = db.prepare('SELECT status FROM campaigns WHERE id=?').get(schedule.last_campaign_id);
                    if (previousCampaign?.status === 'running') {
                        console.warn(`Schedule ${schedule.id} skipped because campaign ${schedule.last_campaign_id} is still running.`);
                        db.prepare("UPDATE campaign_schedules SET next_run_at=?, updated_at=datetime('now') WHERE id=? AND status='active'").run(this._nextCron(schedule.recurrence_cron, new Date()), schedule.id);
                        this._emit('schedule:skipped_overlap', { scheduleId: schedule.id });
                        continue;
                    }
                }
                try {
                    const campaign = await campaignService.create({ name: `${schedule.name} - ${new Date().toISOString()}`, templateMessage: schedule.template_message, filePath: schedule.file_path, mediaPath: schedule.media_path, mediaType: schedule.media_type, mediaFilename: schedule.media_filename, mediaMimetype: schedule.media_mimetype, buttons: JSON.parse(schedule.buttons || '[]'), settings: JSON.parse(schedule.settings || '{}'), allowMissingFields: !!schedule.allow_missing_fields });
                    await campaignService.start(campaign.id, providerManager, this._io);
                    db.prepare("UPDATE campaign_schedules SET last_run_at=datetime('now'), last_campaign_id=?, last_error=NULL, status=CASE WHEN schedule_type='once' THEN 'completed' ELSE status END, next_run_at=CASE WHEN schedule_type='once' THEN NULL WHEN status='active' THEN ? ELSE next_run_at END, updated_at=datetime('now') WHERE id=?").run(campaign.id, schedule.schedule_type === 'recurring' ? this._nextCron(schedule.recurrence_cron, new Date()) : null, schedule.id);
                    this._emit('schedule:fired', { scheduleId: schedule.id, campaignId: campaign.id });
                } catch (error) {
                    const nextRunAt = schedule.schedule_type === 'recurring' ? this._nextCron(schedule.recurrence_cron, new Date()) : schedule.next_run_at;
                    db.prepare("UPDATE campaign_schedules SET status=CASE WHEN schedule_type='once' THEN 'failed' ELSE 'active' END, last_error=?, last_run_at=datetime('now'), next_run_at=?, updated_at=datetime('now') WHERE id=?").run(error.message, nextRunAt, schedule.id);
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