const db = require('../database/db');
const contactService = require('../contacts/contactService');
const excelParser = require('./excelParser');
const { downloadFromStorage, isRemotePath } = require('../middleware/upload');
const fieldRenderer = require('./fieldRenderer');
const messageQueue = require('./messageQueue');
const { resolveCountryCode, findCountry } = require('../utils/countryCodes');
const { parseJsonField } = require('../utils/jsonField');

class CampaignService {
    _parseCampaign(campaign) {
        if (!campaign) return campaign;
        campaign.buttons = parseJsonField(campaign.buttons, []);
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

    async list(userId, { page = 1, limit = 20 } = {}) {
        const result = await db.paginate('campaigns', 'user_id = ?', [userId], 'created_at', 'desc', limit, (page - 1) * limit);
        const data = await Promise.all(result.data.map(c => this._parseCampaign(c)));
        return { total: result.total, page, limit, data };
    }

    async get(id, userId) {
        const campaign = await db.getById('campaigns', id, userId);
        return this._parseCampaign(campaign);
    }

    /**
     * Resolve a file source (local path or Supabase Storage URL) into a Buffer
     * so the Excel parser can work without a local file path.
     */
    async _resolveExcelSource(filePath) {
        if (isRemotePath(filePath)) {
            return downloadFromStorage('campaign-excel-uploads', filePath);
        }
        return filePath; // local path during transition
    }

    async validateExcel(filePath, { countryCode = null } = {}, userId) {
        if (!userId) throw new Error('userId is required to validate campaign data');
        // Per-upload override wins; otherwise fall back to the account's
        // Settings default (per-user app_settings → env → '91').
        const resolvedCode = await resolveCountryCode(userId, countryCode);
        const result = await excelParser.parse(filePath, { countryCode: resolvedCode });
        const validRows = excelParser.getValidRows(result);
        const dynamicFields = excelParser.getDynamicFields(result);
        return {
            ...result.validation,
            dynamicFields,
            phoneColumn: result.phoneColumn,
            ignoredSheets: result.ignoredSheets,
            countryCode: resolvedCode,
            countryName: findCountry(resolvedCode)?.name || null,
            previewRows: validRows.slice(0, 3).map(r => {
                const preview = { ...r };
                delete preview._rowIndex;
                delete preview._sheetName;
                delete preview._valid;
                return preview;
            }),
        };
    }

    async validateExcelBuffer(fileBuffer, { countryCode = null } = {}, userId) {
        if (!userId) throw new Error('userId is required to validate campaign data');
        const resolvedCode = await resolveCountryCode(userId, countryCode);
        const result = await excelParser.parseBuffer(fileBuffer, { countryCode: resolvedCode });
        const validRows = excelParser.getValidRows(result);
        const dynamicFields = excelParser.getDynamicFields(result);
        return {
            ...result.validation,
            dynamicFields,
            phoneColumn: result.phoneColumn,
            ignoredSheets: result.ignoredSheets,
            countryCode: resolvedCode,
            countryName: findCountry(resolvedCode)?.name || null,
            previewRows: validRows.slice(0, 3).map(r => {
                const preview = { ...r };
                delete preview._rowIndex;
                delete preview._sheetName;
                delete preview._valid;
                return preview;
            }),
        };
    }

    async previewMessages(filePath, template, previewCount = 5, { countryCode = null } = {}, userId) {
        if (!userId) throw new Error('userId is required to preview campaign data');
        const source = await this._resolveExcelSource(filePath);
        // Use the same code resolution as validation/create so the previewed
        // numbers match what will actually be stored.
        const resolvedCode = await resolveCountryCode(userId, countryCode);
        const result = await excelParser.parse(source, { countryCode: resolvedCode });
        const validRows = excelParser.getValidRows(result);
        const requiredFields = fieldRenderer.extractFields(template);
        return {
            dynamicFields: excelParser.getDynamicFields(result),
            previews: fieldRenderer.previewBatch(template, validRows, previewCount),
            requiredFields,
            missingByField: Object.fromEntries(requiredFields.map(field => [field, validRows.filter(row => !row[field]).length])),
        };
    }

    async create(userId, { name, templateMessage, filePath, settings = {}, allowMissingFields = false, mediaPath = null, mediaType = null, mediaFilename = null, mediaMimetype = null, buttons = [], countryCode = null }) {
        const source = await this._resolveExcelSource(filePath);
        // Same resolution order as validate*: per-upload override → account
        // Settings default → env → '91'. The resolved code is stored on the
        // campaign row's settings for traceability.
        const resolvedCode = await resolveCountryCode(userId, countryCode);
        const result = await excelParser.parse(source, { countryCode: resolvedCode });
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
            settings: JSON.stringify({ ...settings, countryCode: resolvedCode }),
            // Provider is resolved per user at creation time: business if
            // THIS user has the Cloud API connected, otherwise web.
            provider: require('../whatsapp/businessApiProvider').getStatus(userId) === 'connected' ? 'business' : 'web',
            media_path: mediaPath,
            media_type: mediaType,
            media_filename: mediaFilename,
            media_mimetype: mediaMimetype,
            buttons: JSON.stringify(safeButtons),
            updated_at: new Date(),
            user_id: userId,
        });

        const campaignId = campaign.id;

        const contactEntries = validRows.map(row => ({
            phone: row[result.phoneColumn] || row._phone,
            data: {
                name: row.name || row.Name || '',
                company: row.company || row.Company || '',
                city: row.city || row.City || '',
            },
        }));
        const contactsByPhone = await contactService.upsertMany(contactEntries, userId);
        const membershipBatchSize = 100;

        // Insert campaign memberships in batches so large workbooks don't
        // require one database round trip per contact.
        for (let offset = 0; offset < validRows.length; offset += membershipBatchSize) {
            const membershipRows = [];
            for (const row of validRows.slice(offset, offset + membershipBatchSize)) {
                const phone = row[result.phoneColumn] || row._phone;
                const contact = contactsByPhone.get(contactService._cleanPhone(phone));
                if (!contact) throw new Error(`Failed to resolve imported contact on row ${row._rowIndex}.`);

                // Check opt-out
                if (!contact.marketing_opt_in) {
                    membershipRows.push({
                        campaign_id: campaignId,
                        contact_id: contact.id,
                        rendered_message: null,
                        status: 'opted_out',
                        user_id: userId,
                    });
                    continue;
                }

                const rendered = fieldRenderer.render(templateMessage, row, { strict: !allowMissingFields });
                membershipRows.push({
                    campaign_id: campaignId,
                    contact_id: contact.id,
                    rendered_message: rendered,
                    status: 'pending',
                    user_id: userId,
                });
            }
            await db.insertMany('campaign_contacts', membershipRows);
        }

        const created = await db.getById('campaigns', campaignId, userId);
        return this._parseCampaign(created);
    }

    /**
     * Per-user connection check: the campaign can only start through its
     * OWNER's own connection — never another user's session.
     */
    async _assertOwnerConnected(userId, provider) {
        if (provider === 'business') {
            const businessApiProvider = require('../whatsapp/businessApiProvider');
            if (businessApiProvider.getStatus(userId) !== 'connected') {
                throw new Error('Your WhatsApp Business API is not connected. Connect it and try again.');
            }
            return;
        }
        const sessionManager = require('../whatsapp/sessionManager');
        if (sessionManager.getStatus(userId) !== 'connected') {
            throw new Error('Your WhatsApp session is not connected. Connect WhatsApp and try again.');
        }
    }

    async start(campaignId, io, userId) {
        const campaign = await this.get(campaignId, userId);
        if (!campaign) throw new Error('Campaign not found');
        if (!['draft', 'stopped', 'paused'].includes(campaign.status)) {
            throw new Error(`Cannot start campaign in status: ${campaign.status}`);
        }
        await this._assertOwnerConnected(userId, campaign.provider || 'web');

        messageQueue.setIO(io);
        const settings = parseJsonField(campaign.settings, {});
        await messageQueue.start(campaignId, settings, userId);
    }

    async retryFailed(campaignId, io, userId) {
        const campaign = await this.get(campaignId, userId);
        if (!campaign) throw new Error('Campaign not found');
        if (['running', 'paused'].includes(campaign.status) || messageQueue.getCurrentCampaignId(userId) !== null) {
            throw new Error('Stop the current campaign before retrying failed contacts.');
        }
        if (!['failed', 'completed_with_errors', 'completed', 'stopped'].includes(campaign.status)) {
            throw new Error(`Cannot retry failed contacts in status: ${campaign.status}`);
        }
        await this._assertOwnerConnected(userId, campaign.provider || 'web');

        const failedIds = [];
        const batchSize = 500;
        for (let offset = 0; ; offset += batchSize) {
            const page = await db.select(
                'campaign_contacts',
                'id',
                'campaign_id = ? AND user_id = ? AND status = ?',
                [campaignId, userId, 'failed'],
                'id',
                batchSize,
                offset,
            );
            if (!page.length) break;
            failedIds.push(...page.map(row => row.id));
            if (page.length < batchSize) break;
        }
        if (!failedIds.length) throw new Error('This campaign has no failed contacts to retry.');

        let requeuedCount = 0;
        for (let offset = 0; offset < failedIds.length; offset += batchSize) {
            const ids = failedIds.slice(offset, offset + batchSize);
            const requeued = await db.update(
                'campaign_contacts',
                { status: 'pending', attempts: 0, last_error: null, retry_at: null },
                'id IN (?) AND campaign_id = ? AND user_id = ? AND status = ?',
                [ids, campaignId, userId, 'failed'],
            );
            requeuedCount += requeued.length;
        }
        if (!requeuedCount) throw new Error('No failed contacts were available to retry.');

        const counters = await db.recountCampaignCounters(campaignId, userId);

        await db.update('campaigns', {
            status: 'stopped',
            ...counters,
            pause_reason: null,
            last_error: null,
            completed_at: null,
            updated_at: new Date(),
        }, 'id = ? AND user_id = ?', [campaignId, userId]);

        await this.start(campaignId, io, userId);
        return { requeued: requeuedCount };
    }

    pause(campaignId, userId) {
        if (messageQueue.getCurrentOwnerUserId(userId) !== userId || messageQueue.getCurrentCampaignId(userId) !== campaignId) {
            throw new Error('This campaign is not currently running.');
        }
        return messageQueue.pause(userId);
    }

    async resume(campaignId, io, userId) {
        const campaign = await this.get(campaignId, userId);
        if (!campaign) throw new Error('Campaign not found');
        if (campaign.status !== 'paused') {
            throw new Error(`Cannot resume campaign in status: ${campaign.status}`);
        }
        if (messageQueue.getCurrentOwnerUserId(userId) !== userId || messageQueue.getCurrentCampaignId(userId) !== campaignId) {
            if (campaign.pause_reason === 'whatsapp_disconnected') {
                await this._assertOwnerConnected(userId, campaign.provider || 'web');
                messageQueue.setIO(io);
                await messageQueue.start(campaignId, parseJsonField(campaign.settings, {}), userId);
                return;
            }
            throw new Error('This campaign is not currently loaded in the queue.');
        }
        await this._assertOwnerConnected(userId, campaign.provider || 'web');
        messageQueue.setIO(io);
        return messageQueue.resume(userId);
    }

    async stop(campaignId, userId) {
        const ownedCampaign = await this.get(campaignId, userId);
        if (!ownedCampaign) throw new Error('Campaign not found');
        if (messageQueue.getCurrentCampaignId(userId) !== campaignId) {
            if (!['running', 'paused'].includes(ownedCampaign.status)) return;
            // Force-stop from DB even if queue doesn't match
            await db.update('campaign_contacts', { status: 'skipped' }, 'campaign_id = ? AND user_id = ? AND status IN (\'pending\', \'processing\')', [campaignId, userId]);
            const counters = await db.recountCampaignCounters(campaignId, userId);
            await db.update('campaigns', { ...counters, status: 'stopped', completed_at: new Date(), updated_at: new Date() }, 'id = ? AND user_id = ?', [campaignId, userId]);
            return;
        }
        if (messageQueue.getCurrentOwnerUserId(userId) === userId) await messageQueue.stop(userId);
    }

    async delete(id, userId) {
        if (!await this.get(id, userId)) throw new Error('Campaign not found');
        await this.stop(id, userId);
        await db.del('campaigns', 'id = ? AND user_id = ?', [id, userId]);
    }

    async deleteMany(ids, userId) {
        const deleted = [];
        const skipped = [];
        for (const id of ids) {
            if (!await this.get(id, userId)) {
                skipped.push(id);
                continue;
            }
            await this.stop(id, userId);
            await db.del('campaigns', 'id = ? AND user_id = ?', [id, userId]);
            deleted.push(id);
        }
        return { deleted, skipped };
    }

    async getContacts(campaignId, userId, { page = 1, limit = 50, status } = {}) {
        let where = 'campaign_id = ? AND user_id = ?';
        const params = [campaignId, userId];
        if (status) {
            where += ' AND status = ?';
            params.push(status);
        }

        const [total, rows] = await Promise.all([
            db.count('campaign_contacts', where, [...params]),
            db.select('campaign_contacts', '*, contacts(phone, name, company, city)', where, [...params], 'id asc', limit, (page - 1) * limit),
        ]);

        const data = rows.map((cc) => {
            const contact = cc.contacts;
            return {
                ...cc,
                phone: contact?.phone || '',
                name: contact?.name || '',
                company: contact?.company || '',
                city: contact?.city || '',
            };
        });

        return { total, page, limit, data };
    }

    async estimateRemaining(campaignId, userId) {
        const campaign = await this.get(campaignId, userId);
        if (!campaign) throw new Error('Campaign not found');
        const contacts = await db.count(
            'campaign_contacts',
            "campaign_id = ? AND user_id = ? AND status IN ('pending', 'processing')",
            [campaignId, userId],
        );
        const settings = parseJsonField(campaign.settings, {});
        const schedulerService = require('./schedulerService');
        const RateLimiter = require('./rateLimiter');
        const durationMs = schedulerService._computeDurationMs(settings, contacts);
        const now = new Date();
        const rateLimiter = new RateLimiter(settings);
        let startAt = now;
        if (campaign.status === 'paused') {
            startAt = null;
        } else if (!rateLimiter.isWithinBusinessHours()) {
            startAt = new Date(now.getTime() + rateLimiter.msUntilBusinessHours(now));
        }
        return {
            campaignId,
            contacts,
            durationMs,
            durationLabel: schedulerService._humanDuration(durationMs),
            startAt: startAt?.toISOString() || null,
            endAt: startAt ? new Date(startAt.getTime() + durationMs).toISOString() : null,
        };
    }

    async stats(userId) {
        const total = await db.count('campaigns', 'user_id = ?', [userId]);
        const active = await db.count('campaigns', 'user_id = ? AND status = ?', [userId, 'running']);
        const campaigns = [];
        const pageSize = 500;
        for (let offset = 0; ; offset += pageSize) {
            const page = await db.select('campaigns', 'sent, failed, replies, opt_outs', 'user_id = ?', [userId], 'id', pageSize, offset);
            campaigns.push(...page);
            if (page.length < pageSize) break;
        }

        const totalSent = campaigns.reduce((sum, c) => sum + (parseInt(c.sent) || 0), 0);
        const totalFailed = campaigns.reduce((sum, c) => sum + (parseInt(c.failed) || 0), 0);
        const totalReplies = campaigns.reduce((sum, c) => sum + (parseInt(c.replies) || 0), 0);
        const totalOptOuts = campaigns.reduce((sum, c) => sum + (parseInt(c.opt_outs) || 0), 0);

        const failedCampaigns = await db.count('campaigns', 'user_id = ? AND status = ?', [userId, 'failed']);
        const campaignsWithErrors = await db.count('campaigns', 'user_id = ? AND status = ?', [userId, 'completed_with_errors']);
        return { total, active, totalSent, totalFailed, totalReplies, totalOptOuts, failedCampaigns, campaignsWithErrors };
    }

    getQueueStatus(userId) {
        if (messageQueue.getCurrentOwnerUserId(userId) !== userId) {
            return { running: false, paused: false, currentCampaignId: null };
        }
        return {
            running: messageQueue.isRunning(userId),
            paused: messageQueue.isPaused(userId),
            currentCampaignId: messageQueue.getCurrentCampaignId(userId),
        };
    }
}

module.exports = new CampaignService();
