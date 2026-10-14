const db = require('../database/db');
const contactService = require('../contacts/contactService');
const excelParser = require('./excelParser');
const { downloadFromStorage, isRemotePath } = require('../middleware/upload');
const fieldRenderer = require('./fieldRenderer');
const messageQueue = require('./messageQueue');
const { resolveCountryCode, findCountry } = require('../utils/countryCodes');
const { parseJsonField } = require('../utils/jsonField');
const { CAMPAIGN_MIGRATION_PENDING_MESSAGE, isMissingMigrationError } = require('../database/campaignReliabilityMigrationGuard');

function translateCampaignMigrationError(error) {
    if (!isMissingMigrationError(error)) return error;
    return new Error(CAMPAIGN_MIGRATION_PENDING_MESSAGE);
}

function getCampaignContactData(row) {
    return Object.fromEntries(Object.entries(row || {}).filter(([key]) => !key.startsWith('_')));
}

function validateExcludeCampaignIds(ids) {
    if (ids == null) return null;
    if (!Array.isArray(ids) || ids.some(id => !Number.isInteger(Number(id)) || Number(id) <= 0)) {
        throw new Error('excludeCampaignIds must be an array of positive campaign ids.');
    }
    return [...new Set(ids.map(Number))];
}

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
        const validation = { ...result.validation };
        delete validation.rejectedRows;
        validation.rejectedRowCount = result.validation.rejectedRows.length;
        return {
            ...validation,
            dynamicFields,
            phoneColumn: result.phoneColumn,
            ignoredSheets: result.ignoredSheets,
            countryCode: resolvedCode,
            countryName: findCountry(resolvedCode)?.name || null,
            rejectedCsv: excelParser.getRejectedCsv(result),
            rejectedCsvFilename: 'campaign-rejected-rows.csv',
            previewRows: validRows.slice(0, 3).map(r => {
                const preview = { ...r };
                delete preview._rowIndex;
                delete preview._sheetName;
                delete preview._sourcePhone;
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
        const validation = { ...result.validation };
        delete validation.rejectedRows;
        validation.rejectedRowCount = result.validation.rejectedRows.length;
        return {
            ...validation,
            dynamicFields,
            phoneColumn: result.phoneColumn,
            ignoredSheets: result.ignoredSheets,
            countryCode: resolvedCode,
            countryName: findCountry(resolvedCode)?.name || null,
            rejectedCsv: excelParser.getRejectedCsv(result),
            rejectedCsvFilename: 'campaign-rejected-rows.csv',
            previewRows: validRows.slice(0, 3).map(r => {
                const preview = { ...r };
                delete preview._rowIndex;
                delete preview._sheetName;
                delete preview._sourcePhone;
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

    async create(userId, { name, templateMessage, filePath, settings = {}, allowMissingFields = false, mediaPath = null, mediaBucket = null, mediaObjectPath = null, mediaType = null, mediaFilename = null, mediaMimetype = null, buttons = [], countryCode = null, excludeMessaged = false, excludeCampaignIds = null }) {
        excludeCampaignIds = validateExcludeCampaignIds(excludeCampaignIds);
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
            media_bucket: mediaBucket,
            media_object_path: mediaObjectPath,
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
        const previouslyMessaged = excludeMessaged
            ? await this._previouslyMessagedContactIds(userId, excludeCampaignIds)
            : new Set();
        let excludedCount = 0;
        let insertedContactCount = 0;
        const membershipBatchSize = 100;

        // Insert campaign memberships in batches so large workbooks don't
        // require one database round trip per contact.
        for (let offset = 0; offset < validRows.length; offset += membershipBatchSize) {
            const membershipRows = [];
            for (const row of validRows.slice(offset, offset + membershipBatchSize)) {
                const phone = row[result.phoneColumn] || row._phone;
                const contact = contactsByPhone.get(contactService._cleanPhone(phone));
                if (!contact) throw new Error(`Failed to resolve imported contact on row ${row._rowIndex}.`);
                if (previouslyMessaged.has(String(contact.id))) {
                    excludedCount++;
                    continue;
                }

                // Check opt-out
                if (!contact.marketing_opt_in) {
                    membershipRows.push({
                        campaign_id: campaignId,
                        contact_id: contact.id,
                        rendered_message: null,
                        contact_data: getCampaignContactData(row),
                        status: 'opted_out',
                        user_id: userId,
                    });
                    insertedContactCount++;
                    continue;
                }

                const rendered = fieldRenderer.render(templateMessage, row, { strict: !allowMissingFields });
                membershipRows.push({
                    campaign_id: campaignId,
                    contact_id: contact.id,
                    rendered_message: rendered,
                    contact_data: getCampaignContactData(row),
                    status: 'pending',
                    user_id: userId,
                });
                insertedContactCount++;
            }
            if (membershipRows.length) await db.insertMany('campaign_contacts', membershipRows);
        }

        if (excludeMessaged) {
            await db.update('campaigns', { total_contacts: insertedContactCount }, 'id = ? AND user_id = ?', [campaignId, userId]);
        }
        const created = await db.getById('campaigns', campaignId, userId);
        created.excluded_messaged_count = excludedCount;
        return this._parseCampaign(created);
    }

    async _previouslyMessagedContactIds(userId, campaignIds = null) {
        const allowedCampaignIds = Array.isArray(campaignIds) && campaignIds.length
            ? new Set(campaignIds.map(String))
            : null;
        const contactIds = new Set();
        const batchSize = 500;
        for (let offset = 0; ; offset += batchSize) {
            const rows = await db.select(
                'campaign_contacts',
                'campaign_id,contact_id',
                'user_id = ? AND status = ?',
                [userId, 'sent'],
                'id',
                batchSize,
                offset,
            );
            for (const row of rows) {
                if (!allowedCampaignIds || allowedCampaignIds.has(String(row.campaign_id))) {
                    contactIds.add(String(row.contact_id));
                }
            }
            if (rows.length < batchSize) break;
        }
        return contactIds;
    }

    async duplicate(campaignId, userId, { name, contacts = 'all', excludeMessaged = false, excludeCampaignIds = null } = {}) {
        excludeCampaignIds = validateExcludeCampaignIds(excludeCampaignIds);
        const source = await this.get(campaignId, userId);
        if (!source) throw Object.assign(new Error('Campaign not found'), { statusCode: 404 });
        if (!['completed', 'completed_with_errors', 'failed', 'stopped'].includes(source.status)) {
            throw new Error('Only completed, failed, or stopped campaigns can be duplicated.');
        }
        if (!['all', 'unsent', 'failed', 'none'].includes(contacts)) {
            throw new Error("contacts must be 'all', 'unsent', 'failed', or 'none'.");
        }

        const requestedName = String(name || '').trim();
        const copy = await db.insert('campaigns', {
            user_id: userId,
            name: (requestedName || `${source.name} (copy)`).slice(0, 200),
            status: 'draft',
            source_campaign_id: source.id,
            template_message: source.template_message,
            settings: JSON.stringify(parseJsonField(source.settings, {})),
            buttons: JSON.stringify(parseJsonField(source.buttons, [])),
            provider: source.provider || 'web',
            media_path: source.media_path || null,
            media_bucket: source.media_bucket || null,
            media_object_path: source.media_object_path || null,
            media_type: source.media_type || null,
            media_filename: source.media_filename || null,
            media_mimetype: source.media_mimetype || null,
            total_contacts: 0,
            processed: 0,
            sent: 0,
            failed: 0,
            opt_outs: 0,
            updated_at: new Date(),
        });

        let skippedOptedOut = 0;
        let excludedMessaged = 0;
        let copiedCount = 0;
        try {
            if (contacts === 'none') return { campaign: this._parseCampaign(copy), skippedOptedOut, excludedMessaged };

            const statusFilter = contacts === 'failed'
                ? 'failed'
                : contacts === 'unsent'
                    ? ['pending', 'skipped', 'failed']
                    : null;
            const previous = excludeMessaged
                ? await this._previouslyMessagedContactIds(userId, excludeCampaignIds)
                : new Set();
            const batchSize = 100;
            for (let offset = 0; ; offset += batchSize) {
                let where = 'campaign_id = ? AND user_id = ?';
                const params = [source.id, userId];
                if (statusFilter === 'failed') {
                    where += ' AND status = ?';
                    params.push('failed');
                } else if (Array.isArray(statusFilter)) {
                    where += ' AND status IN (?)';
                    params.push(statusFilter);
                }
                const rows = await db.select(
                    'campaign_contacts',
                    'id,contact_id,status,contact_data,contacts(*)',
                    where,
                    params,
                    'id',
                    batchSize,
                    offset,
                );
                if (!rows.length) break;
                const memberships = [];
                for (const row of rows) {
                    const contact = row.contacts;
                    if (!contact || contact.marketing_opt_in === false || contact.marketing_opt_in === 0) {
                        skippedOptedOut++;
                        continue;
                    }
                    if (previous.has(String(row.contact_id))) {
                        excludedMessaged++;
                        continue;
                    }
                    const fields = {
                        ...(row.contact_data && typeof row.contact_data === 'object' ? row.contact_data : {}),
                        ...contact,
                        ...(contact.data && typeof contact.data === 'object' ? contact.data : {}),
                        name: contact.name || '',
                        company: contact.company || '',
                        city: contact.city || '',
                    };
                    memberships.push({
                        campaign_id: copy.id,
                        contact_id: row.contact_id,
                        rendered_message: fieldRenderer.render(source.template_message, fields, { strict: false }),
                        contact_data: row.contact_data || null,
                        status: 'pending',
                        attempts: 0,
                        user_id: userId,
                    });
                }
                if (memberships.length) {
                    await db.insertMany('campaign_contacts', memberships);
                    copiedCount += memberships.length;
                }
                if (rows.length < batchSize) break;
            }
            await db.update('campaigns', { total_contacts: copiedCount }, 'id = ? AND user_id = ?', [copy.id, userId]);
            const created = await this.get(copy.id, userId);
            return { campaign: created, skippedOptedOut, excludedMessaged };
        } catch (error) {
            await db.del('campaigns', 'id = ? AND user_id = ?', [copy.id, userId]);
            throw error;
        }
    }

    async updateDraft(campaignId, userId, changes = {}) {
        changes.excludeCampaignIds = validateExcludeCampaignIds(changes.excludeCampaignIds);
        const campaign = await this.get(campaignId, userId);
        if (!campaign) throw Object.assign(new Error('Campaign not found'), { statusCode: 404 });
        if (campaign.status !== 'draft') {
            throw new Error(`Only draft campaigns can be edited (current status: ${campaign.status}).`);
        }

        const update = { updated_at: new Date() };
        const editableFields = {
            name: null,
            template_message: 'templateMessage',
            media_path: 'mediaPath',
            media_bucket: 'mediaBucket',
            media_object_path: 'mediaObjectPath',
            media_type: 'mediaType',
            media_filename: 'mediaFilename',
            media_mimetype: 'mediaMimetype',
        };
        for (const [field, alias] of Object.entries(editableFields)) {
            if (Object.hasOwn(changes, field)) update[field] = changes[field];
            else if (alias && Object.hasOwn(changes, alias)) update[field] = changes[alias];
        }
        if (Object.hasOwn(changes, 'settings')) {
            const settings = changes.settings || {};
            if (settings.delayBetweenMessages != null
                && (!Number.isFinite(Number(settings.delayBetweenMessages)) || Number(settings.delayBetweenMessages) < 17500)) {
                throw new Error('Message delay must be at least 17.5 seconds.');
            }
            for (const limit of ['maxPerHour', 'maxPerDay']) {
                if (settings[limit] != null && (!Number.isFinite(Number(settings[limit])) || Number(settings[limit]) < 1)) {
                    throw new Error(`${limit} must be at least 1 to preserve WhatsApp safety limits.`);
                }
            }
            update.settings = JSON.stringify(settings);
        }
        if (Object.hasOwn(changes, 'buttons')) update.buttons = JSON.stringify(changes.buttons || []);

        const replacingRecipients = !!changes.filePath;
        let excludedCountResult = 0;
        if (replacingRecipients) {
            const parsed = await excelParser.parse(await this._resolveExcelSource(changes.filePath), {
                countryCode: await resolveCountryCode(userId, changes.countryCode),
            });
            const rows = excelParser.getValidRows(parsed);
            if (!rows.length) throw new Error('No valid contacts found in the Excel file.');
            const entries = rows.map(row => ({
                phone: row[parsed.phoneColumn] || row._phone,
                data: { name: row.name || row.Name || '', company: row.company || row.Company || '', city: row.city || row.City || '' },
            }));
            const contactsByPhone = await contactService.upsertMany(entries, userId);
            const excluded = changes.excludeMessaged
                ? await this._previouslyMessagedContactIds(userId, changes.excludeCampaignIds)
                : new Set();
            const existingContactIds = new Set();
            if (changes.recipientsMode === 'add') {
                for (let offset = 0; ; offset += 500) {
                    const existing = await db.select(
                        'campaign_contacts',
                        'contact_id',
                        'campaign_id = ? AND user_id = ?',
                        [campaignId, userId],
                        'id',
                        500,
                        offset,
                    );
                    existing.forEach(item => existingContactIds.add(String(item.contact_id)));
                    if (existing.length < 500) break;
                }
            }
            const memberships = [];
            let excludedCount = 0;
            for (const row of rows) {
                const phone = row[parsed.phoneColumn] || row._phone;
                const contact = contactsByPhone.get(contactService._cleanPhone(phone));
                if (!contact) continue;
                if (excluded.has(String(contact.id))) {
                    excludedCount++;
                    continue;
                }
                if (existingContactIds.has(String(contact.id))) continue;
                if (!contact.marketing_opt_in) {
                    memberships.push({
                        campaign_id: campaignId,
                        contact_id: contact.id,
                        rendered_message: null,
                        contact_data: getCampaignContactData(row),
                        status: 'opted_out',
                        user_id: userId,
                    });
                    continue;
                }
                memberships.push({
                    campaign_id: campaignId,
                    contact_id: contact.id,
                    rendered_message: fieldRenderer.render(update.template_message || campaign.template_message, row, { strict: false }),
                    contact_data: getCampaignContactData(row),
                    status: 'pending',
                    user_id: userId,
                });
            }
            if (changes.recipientsMode !== 'add') {
                await db.del('campaign_contacts', 'campaign_id = ? AND user_id = ?', [campaignId, userId]);
            }
            for (let offset = 0; offset < memberships.length; offset += 100) {
                await db.insertMany('campaign_contacts', memberships.slice(offset, offset + 100));
            }
            update.total_contacts = changes.recipientsMode === 'add'
                ? Number(campaign.total_contacts || 0) + memberships.length
                : memberships.length;
            excludedCountResult = excludedCount;
        }
        if (update.template_message) {
            for (let offset = 0; ; offset += 500) {
                const pending = await db.select(
                    'campaign_contacts',
                    'id,contact_data,contacts(*)',
                    'campaign_id = ? AND user_id = ? AND status = ?',
                    [campaignId, userId, 'pending'],
                    'id',
                    500,
                    offset,
                );
                if (!pending.length) break;
                for (const row of pending) {
                    const contact = row.contacts || {};
                    const fields = { ...(row.contact_data || {}), ...contact, ...(contact.data || {}), name: contact.name || '', company: contact.company || '', city: contact.city || '' };
                    await db.update(
                        'campaign_contacts',
                        { rendered_message: fieldRenderer.render(update.template_message, fields, { strict: false }) },
                        'id = ? AND campaign_id = ? AND user_id = ? AND status = ?',
                        [row.id, campaignId, userId, 'pending'],
                    );
                }
                if (pending.length < 500) break;
            }
        }
        await db.update('campaigns', update, 'id = ? AND user_id = ? AND status = ?', [campaignId, userId, 'draft']);
        const updated = await this.get(campaignId, userId);
        if (replacingRecipients) updated.excluded_messaged_count = excludedCountResult;
        return updated;
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
        try {
            const campaign = await this.get(campaignId, userId);
            if (!campaign) throw new Error('Campaign not found');
            if (!['draft', 'stopped', 'paused'].includes(campaign.status)) {
                throw new Error(`Cannot start campaign in status: ${campaign.status}`);
            }
            const recipientCount = await db.count('campaign_contacts', 'campaign_id = ? AND user_id = ?', [campaignId, userId]);
            if (!recipientCount) throw new Error('This campaign has no recipients. Upload or add an Excel list before starting.');
            await this._assertOwnerConnected(userId, campaign.provider || 'web');

            messageQueue.setIO(io);
            const settings = parseJsonField(campaign.settings, {});
            await messageQueue.start(campaignId, settings, userId);
        } catch (error) {
            throw translateCampaignMigrationError(error);
        }
    }

    async queue(campaignId, userId) {
        const campaign = await this.get(campaignId, userId);
        if (!campaign) throw new Error('Campaign not found');
        if (!['draft', 'stopped'].includes(campaign.status)) {
            throw new Error(`Cannot queue campaign in status: ${campaign.status}`);
        }
        const recipientCount = await db.count('campaign_contacts', 'campaign_id = ? AND user_id = ?', [campaignId, userId]);
        if (!recipientCount) throw new Error('This campaign has no recipients. Upload or add an Excel list before queueing.');
        return messageQueue.queueCampaign(campaignId, userId);
    }

    async unqueue(campaignId, userId) {
        return messageQueue.unqueueCampaign(campaignId, userId);
    }

    async reorderQueue(orderedIds, userId) {
        if (!Array.isArray(orderedIds) || orderedIds.some(id => !Number.isInteger(Number(id)))) {
            throw new Error('orderedIds must be an array of campaign ids.');
        }
        return messageQueue.reorderQueue(userId, orderedIds.map(Number));
    }

    async retryFailed(campaignId, io, userId) {
        try {
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
        } catch (error) {
            throw translateCampaignMigrationError(error);
        }
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
            if (['whatsapp_disconnected', 'repeated_send_failures', 'media_upload_failed', 'media_load_failed'].includes(campaign.pause_reason)) {
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
        const campaign = await this.get(id, userId);
        if (!campaign) throw new Error('Campaign not found');
        await this.stop(id, userId);
        await db.del('campaigns', 'id = ? AND user_id = ?', [id, userId]);
        if (campaign.status === 'queued') await messageQueue.normalizeQueuePositions(userId);
        if (campaign.media_object_path) {
            const references = await db.select(
                'campaigns',
                'id',
                'user_id = ? AND media_object_path = ?',
                [userId, campaign.media_object_path],
                'id',
                1,
                0,
            );
            if (!references.length) await require('./campaignMediaStorage').deleteCampaignMedia(campaign);
        }
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

    async estimateQueue(userId) {
        const campaigns = [];
        const pageSize = 500;
        for (let offset = 0; ; offset += pageSize) {
            const page = await db.select(
                'campaigns',
                '*',
                'user_id = ? AND status IN (?)',
                [userId, ['running', 'queued']],
                'queue_position asc',
                pageSize,
                offset,
            );
            campaigns.push(...page);
            if (page.length < pageSize) break;
        }
        const active = campaigns.find(campaign => campaign.status === 'running');
        const queued = campaigns.filter(campaign => campaign.status === 'queued')
            .sort((a, b) => Number(a.queue_position || 0) - Number(b.queue_position || 0));
        const estimateById = new Map();
        const estimable = [...(active ? [active] : []), ...queued];
        for (let offset = 0; offset < estimable.length; offset += 25) {
            const batch = await Promise.all(estimable.slice(offset, offset + 25).map(async campaign => [
                String(campaign.id),
                await this.estimateRemaining(campaign.id, userId),
            ]));
            for (const [id, estimate] of batch) estimateById.set(id, estimate);
        }

        const activeEstimate = active ? estimateById.get(String(active.id)) : null;
        let nextStart = activeEstimate?.endAt ? new Date(activeEstimate.endAt) : null;
        for (const campaign of queued) {
            const estimate = estimateById.get(String(campaign.id));
            if (!estimate) continue;
            if (!nextStart) nextStart = estimate.startAt ? new Date(estimate.startAt) : new Date();
            estimate.startAt = nextStart.toISOString();
            estimate.endAt = new Date(nextStart.getTime() + estimate.durationMs).toISOString();
            nextStart = new Date(estimate.endAt);
        }
        return Object.fromEntries(estimateById);
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
