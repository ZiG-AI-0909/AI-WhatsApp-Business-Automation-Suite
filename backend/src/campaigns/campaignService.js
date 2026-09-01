const db = require('../database/db');
const contactService = require('../contacts/contactService');
const excelParser = require('./excelParser');
const fieldRenderer = require('./fieldRenderer');
const messageQueue = require('./messageQueue');
const providerManager = require('../whatsapp/providerManager');

class CampaignService {
    _parseCampaign(campaign) {
        if (!campaign) return campaign;
        try { campaign.buttons = JSON.parse(campaign.buttons || '[]'); } catch { campaign.buttons = []; }
        return campaign;
    }

    list({ page = 1, limit = 20 } = {}) {
        const offset = (page - 1) * limit;
        const total = db.prepare('SELECT COUNT(*) as c FROM campaigns').get().c;
        const data = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset).map(campaign => this._parseCampaign(campaign));
        return { total, page, limit, data };
    }

    get(id) {
        return this._parseCampaign(db.prepare('SELECT * FROM campaigns WHERE id=?').get(id));
    }

    /**
     * Validate an uploaded Excel file and return preview data.
     */
    validateExcel(filePath) {
        const result = excelParser.parse(filePath);
        const validRows = excelParser.getValidRows(result);
        const dynamicFields = excelParser.getDynamicFields(result);
        return {
            ...result.validation,
            dynamicFields,
            phoneColumn: result.phoneColumn,
            previewRows: validRows.slice(0, 3).map(r => {
                const preview = { ...r };
                delete preview._rowIndex;
                delete preview._valid;
                return preview;
            }),
        };
    }

    /**
     * Preview rendered messages from Excel rows + template.
     */
    previewMessages(filePath, template, previewCount = 5) {
        const result = excelParser.parse(filePath);
        const validRows = excelParser.getValidRows(result);
        const requiredFields = fieldRenderer.extractFields(template);
        return {
            dynamicFields: excelParser.getDynamicFields(result),
            previews: fieldRenderer.previewBatch(template, validRows, previewCount),
            requiredFields,
            missingByField: Object.fromEntries(requiredFields.map(field => [field, validRows.filter(row => !row[field]).length])),
        };
    }

    /**
     * Create a campaign from Excel file + template message + settings.
     */
    async create({ name, templateMessage, filePath, settings = {}, allowMissingFields = false, mediaPath = null, mediaType = null, mediaFilename = null, mediaMimetype = null, buttons = [] }) {
        const result = excelParser.parse(filePath);
        const validRows = excelParser.getValidRows(result);

        if (validRows.length === 0) {
            throw new Error('No valid contacts found in the Excel file.');
        }

        const missingFields = fieldRenderer.extractFields(templateMessage).filter(field => validRows.some(row => !row[field]));
        if (missingFields.length && !allowMissingFields) {
            throw new Error(`Missing values found for: ${missingFields.map(field => `{{${field}}}`).join(', ')}. Review the preview or explicitly allow missing fields.`);
        }

        db.exec('BEGIN');
        let campaignId;
        try {
            const safeButtons = Array.isArray(buttons) ? buttons.slice(0, 3).map(button => ({
                type: button?.type === 'url' ? 'url' : 'quick_reply',
                text: String(button?.text || '').trim(),
                url: String(button?.url || '').trim(),
            })).filter(button => button.text) : [];
            const campaignResult = db.prepare(`
                INSERT INTO campaigns (name, template_message, total_contacts, settings, provider, media_path, media_type, media_filename, media_mimetype, buttons, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            `).run(name, templateMessage, validRows.length, JSON.stringify(settings), providerManager.activeName, mediaPath, mediaType, mediaFilename, mediaMimetype, JSON.stringify(safeButtons));

            campaignId = campaignResult.lastInsertRowid;

        // Upsert contacts and create campaign_contacts entries
        const insertCC = db.prepare(`
            INSERT INTO campaign_contacts (campaign_id, contact_id, rendered_message, status)
            VALUES (?, ?, ?, 'pending')
        `);

        for (const row of validRows) {
            const phone = row[result.phoneColumn] || row._phone;
            const contact = contactService.upsert(phone, {
                name: row.name || row.Name || '',
                company: row.company || row.Company || '',
                city: row.city || row.City || '',
            });

            // Check opt-out
            if (!contact.marketing_opt_in) {
                insertCC.run(campaignId, contact.id, null);
                db.prepare("UPDATE campaign_contacts SET status='opted_out' WHERE campaign_id=? AND contact_id=?").run(campaignId, contact.id);
                continue;
            }

            const rendered = fieldRenderer.render(templateMessage, row, { strict: !allowMissingFields });
            insertCC.run(campaignId, contact.id, rendered);
        }
        db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }

        return this.get(campaignId);
    }

    /**
     * Start campaign queue processing.
     */
    async start(campaignId, whatsappService, io) {
        const campaign = this.get(campaignId);
        if (!campaign) throw new Error('Campaign not found');
        if (!['draft', 'stopped', 'paused'].includes(campaign.status)) {
            throw new Error(`Cannot start campaign in status: ${campaign.status}`);
        }
        if (whatsappService.getStatus() !== 'connected') {
            throw new Error(`${whatsappService.providerName} is not connected. Connect WhatsApp and try again.`);
        }

        messageQueue.setIO(io);
        messageQueue.setWhatsApp(whatsappService);
        const settings = JSON.parse(campaign.settings || '{}');
        if (campaign.provider && campaign.provider !== whatsappService.activeName) {
            throw new Error(`Campaign is locked to the ${campaign.provider} provider. Switch providers before starting it.`);
        }
        await messageQueue.start(campaignId, settings);
    }

    pause(campaignId) {
        if (messageQueue.getCurrentCampaignId() !== campaignId) {
            throw new Error('This campaign is not currently running.');
        }
        messageQueue.pause();
    }

    resume(campaignId, whatsappService, io) {
        const campaign = this.get(campaignId);
        if (!campaign) throw new Error('Campaign not found');
        if (campaign.status !== 'paused') {
            throw new Error(`Cannot resume campaign in status: ${campaign.status}`);
        }
        if (whatsappService.getStatus() !== 'connected') {
            throw new Error(`${whatsappService.providerName} is not connected. Connect WhatsApp and try again.`);
        }
        if (campaign.provider && campaign.provider !== whatsappService.activeName) {
            throw new Error(`Campaign is locked to the ${campaign.provider} provider. Switch providers before resuming it.`);
        }
        messageQueue.setIO(io);
        messageQueue.setWhatsApp(whatsappService);
        messageQueue.resume();
    }

    stop(campaignId) {
        if (messageQueue.getCurrentCampaignId() !== campaignId) {
            // Force-stop from DB even if queue doesn't match
            db.prepare("UPDATE campaign_contacts SET status='skipped' WHERE campaign_id=? AND status='pending'").run(campaignId);
            db.prepare("UPDATE campaigns SET status='stopped', completed_at=datetime('now') WHERE id=?").run(campaignId);
            return;
        }
        messageQueue.stop();
    }

    delete(id) {
        this.stop(id);
        db.prepare('DELETE FROM campaigns WHERE id=?').run(id);
    }

    deleteMany(ids) {
        db.exec('BEGIN');
        try {
            for (const id of ids) {
                this.stop(id);
                db.prepare('DELETE FROM campaigns WHERE id=?').run(id);
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    getContacts(campaignId, { page = 1, limit = 50, status } = {}) {
        const offset = (page - 1) * limit;
        let where = 'WHERE cc.campaign_id=?';
        const params = [campaignId];
        if (status) { where += ' AND cc.status=?'; params.push(status); }

        const total = db.prepare(`SELECT COUNT(*) as c FROM campaign_contacts cc ${where}`).get(...params).c;
        const data = db.prepare(`
            SELECT cc.*, c.phone, c.name, c.company, c.city
            FROM campaign_contacts cc
            JOIN contacts c ON c.id = cc.contact_id
            ${where}
            ORDER BY cc.id ASC LIMIT ? OFFSET ?
        `).all(...params, limit, offset);

        return { total, page, limit, data };
    }

    stats() {
        const total = db.prepare('SELECT COUNT(*) as c FROM campaigns').get().c;
        const active = db.prepare("SELECT COUNT(*) as c FROM campaigns WHERE status='running'").get().c;
        const totalSent = db.prepare('SELECT COALESCE(SUM(sent),0) as c FROM campaigns').get().c;
        const totalFailed = db.prepare('SELECT COALESCE(SUM(failed),0) as c FROM campaigns').get().c;
        const totalReplies = db.prepare('SELECT COALESCE(SUM(replies),0) as c FROM campaigns').get().c;
        const totalOptOuts = db.prepare('SELECT COALESCE(SUM(opt_outs),0) as c FROM campaigns').get().c;
        return { total, active, totalSent, totalFailed, totalReplies, totalOptOuts };
    }

    getQueueStatus() {
        return {
            running: messageQueue.isRunning(),
            paused: messageQueue.isPaused(),
            currentCampaignId: messageQueue.getCurrentCampaignId(),
        };
    }
}

module.exports = new CampaignService();
