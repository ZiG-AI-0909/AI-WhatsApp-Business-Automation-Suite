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
        // Convert timestamps to ISO strings if they're Date objects
        if (campaign.created_at && campaign.created_at instanceof Date) {
            campaign.created_at = campaign.created_at.toISOString();
        }
        if (campaign.started_at && campaign.started_at instanceof Date) {
            campaign.started_at = campaign.started_at.toISOString();
        }
        if (campaign.completed_at && campaign.completed_at instanceof Date) {
            campaign.completed_at = campaign.completed_at.toISOString();
        }
        if (campaign.updated_at && campaign.updated_at instanceof Date) {
            campaign.updated_at = campaign.updated_at.toISOString();
        }
        return campaign;
    }

    async list({ page = 1, limit = 20 } = {}) {
        const result = await db.paginate('campaigns', '', [], 'created_at', 'desc', limit, (page - 1) * limit);
        const data = await Promise.all(result.data.map(c => this._parseCampaign(c)));
        return { total: result.total, page, limit, data };
    }

    async get(id) {
        const campaign = await db.getById('campaigns', id);
        return this._parseCampaign(campaign);
    }

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

        const safeButtons = Array.isArray(buttons) ? buttons.slice(0, 3).map(button => ({
            type: button?.type === 'url' ? 'url' : 'quick_reply',
            text: String(button?.text || '').trim(),
            url: String(button?.url || '').trim(),
        })).filter(button => button.text) : [];

        // Use transaction-like sequential operations
        const campaign = await db.insert('campaigns', {
            name,
            template_message: templateMessage,
            total_contacts: validRows.length,
            settings: JSON.stringify(settings),
            provider: providerManager.activeName,
            media_path: mediaPath,
            media_type: mediaType,
            media_filename: mediaFilename,
            media_mimetype: mediaMimetype,
            buttons: JSON.stringify(safeButtons),
            updated_at: new Date(),
        });

        const campaignId = campaign.id;

        // Upsert contacts and create campaign_contacts entries
        for (const row of validRows) {
            const phone = row[result.phoneColumn] || row._phone;
            const contact = await contactService.upsert(phone, {
                name: row.name || row.Name || '',
                company: row.company || row.Company || '',
                city: row.city || row.City || '',
            });

            // Check opt-out
            if (!contact.marketing_opt_in) {
                await db.insert('campaign_contacts', {
                    campaign_id: campaignId,
                    contact_id: contact.id,
                    rendered_message: null,
                    status: 'opted_out',
                });
                continue;
            }

            const rendered = fieldRenderer.render(templateMessage, row, { strict: !allowMissingFields });
            await db.insert('campaign_contacts', {
                campaign_id: campaignId,
                contact_id: contact.id,
                rendered_message: rendered,
                status: 'pending',
            });
        }

        const created = await db.getById('campaigns', campaignId);
        return this._parseCampaign(created);
    }

    async start(campaignId, whatsappService, io) {
        const campaign = await this.get(campaignId);
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

    async resume(campaignId, whatsappService, io) {
        const campaign = await this.get(campaignId);
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
            db.update('campaign_contacts', { status: 'skipped' }, 'campaign_id = ? AND status IN (\'pending\', \'processing\')', [campaignId]);
            db.update('campaigns', { status: 'stopped', completed_at: new Date(), updated_at: new Date() }, 'id = ?', [campaignId]);
            return;
        }
        messageQueue.stop();
    }

    async delete(id) {
        this.stop(id);
        await db.del('campaigns', 'id = ?', [id]);
    }

    async deleteMany(ids) {
        for (const id of ids) {
            this.stop(id);
            await db.del('campaigns', 'id = ?', [id]);
        }
    }

    async getContacts(campaignId, { page = 1, limit = 50, status } = {}) {
        let where = 'campaign_id = ?';
        const params = [campaignId];
        if (status) {
            where += ' AND status = ?';
            params.push(status);
        }

        const result = await db.paginate('campaign_contacts', where, params, 'id', 'asc', limit, (page - 1) * limit);
        
        // Fetch contact details for each row
        const data = await Promise.all(result.data.map(async (cc) => {
            const contact = await db.getById('contacts', cc.contact_id);
            return {
                ...cc,
                phone: contact?.phone || '',
                name: contact?.name || '',
                company: contact?.company || '',
                city: contact?.city || '',
            };
        }));

        return { total: result.total, page, limit, data };
    }

    async stats() {
        const total = await db.count('campaigns');
        const active = await db.count('campaigns', "status = ?", ['running']);
        const campaigns = await db.select('campaigns', 'sent, failed, replies, opt_outs', '', [], '', 1000, 0);
        
        const totalSent = campaigns.reduce((sum, c) => sum + (parseInt(c.sent) || 0), 0);
        const totalFailed = campaigns.reduce((sum, c) => sum + (parseInt(c.failed) || 0), 0);
        const totalReplies = campaigns.reduce((sum, c) => sum + (parseInt(c.replies) || 0), 0);
        const totalOptOuts = campaigns.reduce((sum, c) => sum + (parseInt(c.opt_outs) || 0), 0);

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
