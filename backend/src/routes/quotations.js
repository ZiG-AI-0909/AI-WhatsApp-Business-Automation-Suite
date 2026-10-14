'use strict';

const express = require('express');
const domain = require('../documents/quotationDomain');
const service = require('../documents/quotationService');
const sessionManager = require('../whatsapp/sessionManager');

const router = express.Router();
const QUOTE_PREFIX = 'SP';

function safeQuoteHeader(body = {}) {
    const result = {};
    for (const key of [
        'customer_name', 'customer_phone', 'customer_address', 'customer_state',
        'customer_gstin', 'project_name', 'payment_terms', 'delivery_terms', 'notes',
    ]) {
        if (body[key] !== undefined) result[key] = String(body[key] ?? '').trim();
    }
    if (body.validity_days !== undefined) {
        result.validity_days = domain.parseFiniteNumber(body.validity_days, 'Validity days', { min: 1, max: 3650 });
        if (!Number.isInteger(result.validity_days)) throw new Error('Validity days must be a whole number.');
    }
    if (body.freight !== undefined) result.freight = domain.parseFiniteNumber(body.freight, 'Freight', { min: 0 });
    if (body.discount_percent !== undefined) result.discount_percent = domain.parseFiniteNumber(body.discount_percent, 'Discount', { min: 0, max: 100 });
    if (body.status !== undefined) {
        if (!['draft', 'accepted', 'rejected', 'expired'].includes(body.status)) {
            throw new Error('Status must be draft, accepted, rejected, or expired. Use Send via WhatsApp to mark as sent.');
        }
        result.status = body.status;
    }
    return result;
}

function normalizeItem(input, index, userId, quotationId) {
    const quantity = domain.parseFiniteNumber(input.quantity, `Line ${index + 1} quantity`, { min: 0 });
    const rate = domain.parseFiniteNumber(input.rate, `Line ${index + 1} rate`, { min: 0, nullable: true });
    const discountPercent = domain.parseFiniteNumber(input.discount_percent ?? 0, `Line ${index + 1} discount`, { min: 0, max: 100 });
    const gstPercent = domain.parseFiniteNumber(input.gst_percent ?? 0, `Line ${index + 1} GST`, { min: 0, max: 100 });
    const matchStatus = input.match_status || 'manual';
    if (!['matched', 'manual', 'unmatched'].includes(matchStatus)) throw new Error(`Line ${index + 1} has an invalid match status.`);
    return {
        ...(input.id ? { id: input.id } : {}),
        quotation_id: quotationId,
        user_id: userId,
        line_no: index + 1,
        boq_item_ref: input.boq_item_ref || {},
        price_list_item_id: input.price_list_item_id || null,
        description: String(input.description || '').trim(),
        size: String(input.size || '').trim(),
        unit: String(input.unit || '').trim(),
        quantity,
        rate,
        discount_percent: discountPercent,
        gst_percent: gstPercent,
        hsn_code: String(input.hsn_code || '').trim(),
        amount: 0,
        match_status: matchStatus,
        updated_at: new Date().toISOString(),
    };
}

async function confirmedBoq(id, userId) {
    const document = await service.selectOwned('boq_documents', id, userId);
    if (!document) return null;
    if (document.status !== 'confirmed') {
        const error = new Error('Confirm the BOQ document before creating a quotation.');
        error.statusCode = 400;
        throw error;
    }
    return document;
}

async function loadQuote(quotationId, userId) {
    const quotation = await service.selectOwned('quotations', quotationId, userId);
    if (!quotation) return null;
    const items = await service.getItems(quotation.id, userId);
    const settings = await service.getSettings(userId);
    const totals = domain.calculateQuotation(items, quotation, settings.state);
    return { ...quotation, items: totals.items, totals, amount_in_words: service.amountInWordsIndian(totals.grand_total) };
}

async function assertReady(quotation, items) {
    service.validateQuoteItems(items);
    const settings = await service.getSettings(quotation.user_id);
    if (!settings.state || !quotation.customer_state) {
        throw new Error('Enter your company state in Settings and the customer state on the quotation to calculate GST correctly.');
    }
    return { ...quotation, ...domain.calculateQuotation(items, quotation, settings.state) };
}

async function insertAudit(userId, quotationId, itemId, fieldName, oldValue, newValue) {
    const { error } = await service.supabase.from('quotation_audit').insert({
        user_id: userId,
        quotation_id: quotationId,
        quotation_item_id: itemId || null,
        actor_user_id: userId,
        field_name: fieldName,
        old_value: oldValue === undefined ? null : oldValue,
        new_value: newValue === undefined ? null : newValue,
    });
    if (error) throw error;
}

function serverError(res, error, fallback = 'Quotation request failed.') {
    const status = error.statusCode || (error.code === 'PGRST116' ? 404 : error.code ? 500 : 400);
    if (status >= 500) console.error('[quotations] request failed:', error.message);
    res.status(status).json({ error: status >= 500 ? fallback : error.message });
}

router.post('/boq/:id/quotation/match', async (req, res) => {
    try {
        const document = await confirmedBoq(req.params.id, req.user.id);
        if (!document) return res.status(404).json({ error: 'Document not found.' });
        const items = service.parseJsonArray(document.items);
        res.json({ matches: await service.matchBoqItems(req.user.id, items) });
    } catch (error) {
        serverError(res, error, 'Could not match BOQ items against the price list.');
    }
});

router.post('/boq/:id/quotation', async (req, res) => {
    let created;
    try {
        const document = await confirmedBoq(req.params.id, req.user.id);
        if (!document) return res.status(404).json({ error: 'Document not found.' });
        const now = new Date();
        const fiscalYear = domain.fiscalYearFor(now);
        const { data: sequence, error: sequenceError } = await service.supabase.rpc('next_quotation_number', {
            p_user_id: req.user.id,
            p_fiscal_year: fiscalYear,
        });
        if (sequenceError) throw sequenceError;
        const quoteNumber = `${QUOTE_PREFIX}/${fiscalYear}/${String(Number(sequence)).padStart(4, '0')}`;
        const { data, error } = await service.supabase.from('quotations').insert({
            ...safeQuoteHeader(req.body),
            user_id: req.user.id,
            boq_document_id: document.id,
            quote_number: quoteNumber,
            status: 'draft',
            validity_days: Number(req.body?.validity_days) || 30,
            freight: Number(req.body?.freight) || 0,
            discount_percent: Number(req.body?.discount_percent) || 0,
            subtotal: 0,
            tax_total: 0,
            grand_total: 0,
        }).select('*').single();
        if (error) throw error;
        created = data;
        const boqItems = service.parseJsonArray(document.items);
        const matches = await service.matchBoqItems(req.user.id, boqItems);
        const rows = boqItems.map((item, index) => ({
            ...service.quoteItemFromBoq(item, index + 1, matches[index]),
            quotation_id: created.id,
            user_id: req.user.id,
        }));
        for (let offset = 0; offset < rows.length; offset += 500) {
            const { error: itemsError } = await service.supabase.from('quotation_items').insert(rows.slice(offset, offset + 500));
            if (itemsError) throw itemsError;
        }
        const result = await loadQuote(created.id, req.user.id);
        const saved = await service.calculateAndPersist(created, result.items, req.user.id);
        res.status(201).json(saved);
    } catch (error) {
        if (created?.id) {
            await service.supabase.from('quotations').delete().eq('id', created.id).eq('user_id', req.user.id);
        }
        serverError(res, error, 'Could not create the quotation.');
    }
});

router.get('/quotations', async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        let query = service.supabase.from('quotations').select('*', { count: 'exact' })
            .eq('user_id', req.user.id).order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (req.query.status) query = query.eq('status', String(req.query.status));
        if (req.query.search) {
            const search = `%${String(req.query.search).replace(/[%(),]/g, ' ').trim()}%`;
            query = query.or(`quote_number.ilike.${search},customer_name.ilike.${search},project_name.ilike.${search}`);
        }
        const { data, error, count } = await query;
        if (error) throw error;
        res.json({ data: data || [], total: count || 0, limit, offset });
    } catch (error) {
        serverError(res, error, 'Could not load quotations.');
    }
});

router.get('/quotations/:id', async (req, res) => {
    try {
        const quote = await loadQuote(req.params.id, req.user.id);
        if (!quote) return res.status(404).json({ error: 'Quotation not found.' });
        const { data: audit, error } = await service.supabase.from('quotation_audit').select('*')
            .eq('quotation_id', quote.id).eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        res.json({ ...quote, audit: audit || [] });
    } catch (error) {
        serverError(res, error, 'Could not load quotation.');
    }
});

async function updateQuotation(req, res) {
    try {
        const current = await loadQuote(req.params.id, req.user.id);
        if (!current) return res.status(404).json({ error: 'Quotation not found.' });
        if (current.status !== 'draft') {
            const allowedKeys = new Set(['status']);
            if (current.status !== 'sent' || Object.keys(req.body || {}).some((key) => !allowedKeys.has(key))
                || !['accepted', 'rejected', 'expired'].includes(req.body?.status)) {
                return res.status(409).json({ error: 'Only draft quotations can be edited. Sent quotations may only be marked accepted, rejected, or expired.' });
            }
            const { data, error } = await service.supabase.from('quotations').update({
                status: req.body.status, updated_at: new Date().toISOString(),
            }).eq('id', current.id).eq('user_id', req.user.id).eq('status', 'sent').select('*').single();
            if (error) throw error;
            await insertAudit(req.user.id, current.id, null, 'status', current.status, data.status);
            return res.json({ ...data, items: current.items });
        }
        const updates = safeQuoteHeader(req.body);
        if (updates.status && updates.status !== 'draft') {
            return res.status(400).json({ error: 'A draft can only become sent through Send via WhatsApp.' });
        }
        if (Object.keys(updates).length) {
            const { data, error } = await service.supabase.from('quotations').update({
                ...updates, updated_at: new Date().toISOString(),
            }).eq('id', current.id).eq('user_id', req.user.id).select('*').single();
            if (error) throw error;
            Object.assign(current, data);
        }
        if (Array.isArray(req.body?.items)) {
            const nextItems = req.body.items.map((item, index) => normalizeItem(item, index, req.user.id, current.id));
            const rateChanges = [];
            for (const item of nextItems) {
                if (item.price_list_item_id) {
                    const { data: priceItem, error } = await service.supabase.from('price_list_items').select('id')
                        .eq('id', item.price_list_item_id).eq('user_id', req.user.id).maybeSingle();
                    if (error) throw error;
                    if (!priceItem) throw new Error(`Line ${item.line_no} references a price-list item that is unavailable.`);
                }
                const previous = current.items.find((row) => String(row.id) === String(item.id));
                if (previous && Number(previous.rate) !== Number(item.rate)) {
                    rateChanges.push({ itemId: previous.id, oldRate: previous.rate, newRate: item.rate });
                }
            }
            const keepIds = nextItems.filter((item) => item.id).map((item) => item.id);
            let deleteQuery = service.supabase.from('quotation_items').delete()
                .eq('quotation_id', current.id).eq('user_id', req.user.id);
            if (keepIds.length) deleteQuery = deleteQuery.not('id', 'in', `(${keepIds.join(',')})`);
            const { error: deleteError } = await deleteQuery;
            if (deleteError) throw deleteError;
            for (const item of nextItems) {
                const { id, ...payload } = item;
                if (id) {
                    const { data, error } = await service.supabase.from('quotation_items').update(payload)
                        .eq('id', id).eq('quotation_id', current.id).eq('user_id', req.user.id).select('id').maybeSingle();
                    if (error) throw error;
                    if (!data) throw new Error(`Line ${item.line_no} could not be updated.`);
                } else {
                    const { data, error } = await service.supabase.from('quotation_items').insert(payload).select('id').single();
                    if (error) throw error;
                    if (item.rate !== null) rateChanges.push({ itemId: data.id, oldRate: null, newRate: item.rate });
                }
            }
            for (const change of rateChanges) {
                await insertAudit(req.user.id, current.id, change.itemId, 'rate', change.oldRate, change.newRate);
            }
        }
        const refreshed = await loadQuote(current.id, req.user.id);
        const saved = await service.calculateAndPersist(current, refreshed.items, req.user.id);
        res.json(saved);
    } catch (error) {
        serverError(res, error, 'Could not save quotation.');
    }
}

router.put('/quotations/:id', updateQuotation);
router.put('/quotations/:id/items', updateQuotation);

router.post('/quotations/:id/finalize', async (req, res) => {
    try {
        const quote = await loadQuote(req.params.id, req.user.id);
        if (!quote) return res.status(404).json({ error: 'Quotation not found.' });
        if (quote.status !== 'draft') return res.status(409).json({ error: 'Only draft quotations can be finalized.' });
        const ready = await assertReady(quote, quote.items);
        const saved = await service.calculateAndPersist(quote, ready.items, req.user.id);
        res.json({ ready: true, ...saved, amount_in_words: service.amountInWordsIndian(saved.totals.grand_total) });
    } catch (error) {
        serverError(res, error, 'Quotation cannot be finalized.');
    }
});

router.post('/quotations/:id/duplicate', async (req, res) => {
    let created;
    try {
        const source = await loadQuote(req.params.id, req.user.id);
        if (!source) return res.status(404).json({ error: 'Quotation not found.' });
        const now = new Date();
        const fiscalYear = domain.fiscalYearFor(now);
        const { data: sequence, error: sequenceError } = await service.supabase.rpc('next_quotation_number', {
            p_user_id: req.user.id, p_fiscal_year: fiscalYear,
        });
        if (sequenceError) throw sequenceError;
        const { data, error } = await service.supabase.from('quotations').insert({
            user_id: req.user.id,
            boq_document_id: source.boq_document_id,
            quote_number: `${QUOTE_PREFIX}/${fiscalYear}/${String(Number(sequence)).padStart(4, '0')}`,
            customer_name: source.customer_name,
            customer_phone: source.customer_phone,
            customer_address: source.customer_address,
            customer_state: source.customer_state,
            customer_gstin: source.customer_gstin,
            project_name: source.project_name,
            status: 'draft',
            validity_days: source.validity_days,
            payment_terms: source.payment_terms,
            delivery_terms: source.delivery_terms,
            freight: source.freight,
            discount_percent: source.discount_percent,
            notes: source.notes,
        }).select('*').single();
        if (error) throw error;
        created = data;
        const cloned = source.items.map((item) => ({
            quotation_id: created.id,
            user_id: req.user.id,
            line_no: item.line_no,
            boq_item_ref: item.boq_item_ref,
            price_list_item_id: item.price_list_item_id,
            description: item.description,
            size: item.size,
            unit: item.unit,
            quantity: item.quantity,
            rate: item.rate,
            discount_percent: item.discount_percent,
            gst_percent: item.gst_percent,
            hsn_code: item.hsn_code,
            amount: item.amount,
            match_status: item.match_status,
        }));
        if (cloned.length) {
            const { error: itemsError } = await service.supabase.from('quotation_items').insert(cloned);
            if (itemsError) throw itemsError;
        }
        res.status(201).json(await loadQuote(created.id, req.user.id));
    } catch (error) {
        if (created?.id) await service.supabase.from('quotations').delete().eq('id', created.id).eq('user_id', req.user.id);
        serverError(res, error, 'Could not duplicate quotation.');
    }
});

router.delete('/quotations/:id', async (req, res) => {
    try {
        const quote = await service.selectOwned('quotations', req.params.id, req.user.id);
        if (!quote) return res.status(404).json({ error: 'Quotation not found.' });
        if (quote.status !== 'draft') return res.status(409).json({ error: 'Only draft quotations can be deleted; sent and decided quotations remain as history.' });
        const { error } = await service.supabase.from('quotations').delete()
            .eq('id', quote.id).eq('user_id', req.user.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (error) {
        serverError(res, error, 'Could not delete quotation.');
    }
});

router.get('/quotations/:id/export/pdf', async (req, res) => {
    try {
        const quote = await loadQuote(req.params.id, req.user.id);
        if (!quote) return res.status(404).json({ error: 'Quotation not found.' });
        const ready = await assertReady(quote, quote.items);
        const company = await service.getSettings(req.user.id);
        const pdf = await service.renderPdf(ready, ready.items, company);
        res.setHeader('Content-Disposition', `attachment; filename="${quote.quote_number.replace(/[^A-Za-z0-9-]/g, '-')}.pdf"`);
        res.type('application/pdf').send(pdf);
    } catch (error) {
        serverError(res, error, 'Could not generate quotation PDF.');
    }
});

router.get('/quotations/:id/export/excel', async (req, res) => {
    try {
        const quote = await loadQuote(req.params.id, req.user.id);
        if (!quote) return res.status(404).json({ error: 'Quotation not found.' });
        const ready = await assertReady(quote, quote.items);
        const workbook = await service.renderExcel({ ...ready, items: ready.items }, ready.items, await service.getSettings(req.user.id));
        res.setHeader('Content-Disposition', `attachment; filename="${quote.quote_number.replace(/[^A-Za-z0-9-]/g, '-')}.xlsx"`);
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(workbook));
    } catch (error) {
        serverError(res, error, 'Could not generate quotation spreadsheet.');
    }
});

router.post('/quotations/:id/send-whatsapp', async (req, res) => {
    let claimAt = null;
    let quoteId = null;
    try {
        const quote = await loadQuote(req.params.id, req.user.id);
        if (!quote) return res.status(404).json({ error: 'Quotation not found.' });
        if (quote.status !== 'draft') return res.status(409).json({ error: 'Only draft quotations can be sent.' });
        const phone = String(quote.customer_phone || '').replace(/[^\d]/g, '');
        if (!/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Add a valid customer phone number before sending.' });
        if (sessionManager.getStatus(req.user.id) !== 'connected') {
            return res.status(400).json({ error: 'WhatsApp is not connected. Connect WhatsApp before sending the quotation.' });
        }
        const ready = await assertReady(quote, quote.items);
        const pdf = await service.renderPdf(ready, ready.items, await service.getSettings(req.user.id));
        const caption = `Quotation ${quote.quote_number} for ${quote.project_name || quote.customer_name || 'your project'}`;
        claimAt = new Date().toISOString();
        quoteId = quote.id;
        const staleClaimBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { data: claimed, error: claimError } = await service.supabase.from('quotations').update({
            send_claimed_at: claimAt,
        }).eq('id', quote.id).eq('user_id', req.user.id).eq('status', 'draft')
            .or(`send_claimed_at.is.null,send_claimed_at.lt.${staleClaimBefore}`)
            .select('id').maybeSingle();
        if (claimError) throw claimError;
        if (!claimed) return res.status(409).json({ error: 'This quotation is already being sent. Wait a moment and refresh before retrying.' });
        try {
            await sessionManager.sendMessage(req.user.id, phone, caption, null, {
            type: 'document',
            buffer: pdf,
            filename: `${quote.quote_number.replace(/[^A-Za-z0-9-]/g, '-')}.pdf`,
            mimetype: 'application/pdf',
            });
        } catch (sendError) {
            await service.supabase.from('quotations').update({ send_claimed_at: null })
                .eq('id', quote.id).eq('user_id', req.user.id).eq('send_claimed_at', claimAt);
            throw sendError;
        }
        const sentAt = new Date().toISOString();
        const { data, error } = await service.supabase.from('quotations').update({
            status: 'sent', sent_at: sentAt, send_claimed_at: null, updated_at: sentAt,
        }).eq('id', quote.id).eq('user_id', req.user.id).eq('status', 'draft')
            .eq('send_claimed_at', claimAt).select('*').single();
        if (error) throw error;
        res.json({ ...data, message: `Quotation sent to ${phone}.` });
    } catch (error) {
        if (claimAt && quoteId) {
            await service.supabase.from('quotations').update({ send_claimed_at: null })
                .eq('id', quoteId).eq('user_id', req.user.id).eq('send_claimed_at', claimAt);
        }
        serverError(res, error, 'Could not send quotation via WhatsApp.');
    }
});

module.exports = router;
