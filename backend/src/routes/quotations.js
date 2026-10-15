'use strict';

// BOQ -> Quotation API. Mounted at /api behind requireAuth; every query is
// scoped by req.user.id. Totals are always computed here, never taken from
// the browser. Rates start empty and are typed by a human; the BOQ's own
// rate/amount columns are stored only as read-only references.

const express = require('express');
const domain = require('../documents/quotationDomain');
const service = require('../documents/quotationService');
const exporter = require('../documents/quotationExport');
const sessionManager = require('../whatsapp/sessionManager');
const { ensureCountryCode, resolveCountryCode } = require('../utils/countryCodes');
const { requireConfirmedDocument, parseJsonArray } = require('./boq');
const { sendLimiter } = require('../middleware/rateLimiterMiddleware');

const router = express.Router();
const { supabase } = service;
const MAX_BULK_ITEMS = 2000;
const SEND_CLAIM_STALE_MS = 5 * 60 * 1000;
const LIST_COLUMNS = 'id,boq_document_id,version,quote_number,quote_date,customer_name,project_name,status,subtotal,grand_total,unpriced_lines,sent_at,created_at,updated_at';
const COPY_ITEM_FIELDS = ['line_no', 'section', 'include', 'boq_item_no', 'boq_item_code', 'description', 'boq_description', 'size_mm', 'unit', 'qty', 'rate', 'hsn', 'remarks', 'ref_rate', 'ref_amount', 'spec', 'flags'];

function httpError(status, message, extra) {
    const error = new Error(message);
    error.statusCode = status;
    if (extra) error.extra = extra;
    return error;
}

function sendError(res, error, fallback) {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(`[quotations] ${fallback}`, error.message || error);
    res.status(status).json({
        error: status >= 500 ? fallback : error.message,
        ...(error.details ? { details: error.details } : {}),
        ...(error.extra || {}),
    });
}

function assertDraft(view) {
    if (view.status !== 'draft') throw httpError(409, 'This quotation is finalized and read-only. Duplicate it to make changes.');
}

async function loadOr404(id, userId) {
    const view = await service.loadView(id, userId);
    if (!view) throw httpError(404, 'Quotation not found.');
    return view;
}

async function respondWithView(res, id, userId, status = 200, extra = {}) {
    const view = await loadOr404(id, userId);
    await service.persistSummary(view, userId);
    res.status(status).json({ ...view, ...extra });
}

function fileBase(view) {
    return String(view.quote_number || `draft-quotation-${view.id}`).replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-|-$/g, '');
}

// POST /api/boq/:id/quotation — idempotent per BOQ: returns the latest
// quotation for this BOQ unless { new_version: true } is sent.
router.post('/boq/:id/quotation', async (req, res) => {
    const userId = req.user.id;
    let created = null;
    try {
        const doc = await service.selectOwned('boq_documents', req.params.id, userId);
        if (!doc) return res.status(404).json({ error: 'Document not found.' });
        if (requireConfirmedDocument(doc, res, 'Confirm the BOQ before creating a quotation.')) return;
        const boqItems = parseJsonArray(doc.items);
        if (!boqItems.length) return res.status(400).json({ error: 'This BOQ has no extracted items.' });

        const latest = await service.latestForBoq(userId, doc.id);
        if (latest && req.body?.new_version !== true) {
            return respondWithView(res, latest.id, userId, 200, { created: false });
        }

        const { company } = await service.getCompany(userId);
        const header = domain.parseBoqHeader(doc.document_text);
        const { rows, integrity } = domain.buildDraftItems(boqItems, doc.document_text);
        const { data, error } = await supabase.from('quotations').insert({
            user_id: userId,
            boq_document_id: doc.id,
            version: (latest?.version || 0) + 1,
            quote_number: null,
            quote_date: domain.istDate(),
            validity_days: 30,
            customer_name: header.customer_name,
            customer_address: '',
            customer_gstin: '',
            project_name: header.project_name,
            reference_text: header.reference_text,
            supply_type: 'intra',
            gst_percent: 18,
            discount_percent: 0,
            freight: 0,
            status: 'draft',
            terms: domain.defaultTerms(company),
            company,
            integrity,
        }).select('*').single();
        if (error) {
            // A concurrent click created the same version: return that one.
            if (error.code === '23505') {
                const existing = await service.latestForBoq(userId, doc.id);
                if (existing) return respondWithView(res, existing.id, userId, 200, { created: false });
            }
            throw error;
        }
        created = data;
        await service.insertItems(rows.map((row) => ({ ...row, quotation_id: created.id, user_id: userId })));
        await respondWithView(res, created.id, userId, 201, { created: true });
    } catch (error) {
        if (created?.id) await service.deleteQuotation(created.id, userId).catch(() => {});
        sendError(res, error, 'Could not create the quotation.');
    }
});

router.get('/quotations', async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        let query = supabase.from('quotations').select(LIST_COLUMNS, { count: 'exact' })
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);
        if (req.query.status) {
            if (!domain.STATUSES.includes(req.query.status)) throw httpError(400, 'Status must be draft, final or sent.');
            query = query.eq('status', req.query.status);
        }
        if (req.query.boq_document_id) {
            if (!service.isId(req.query.boq_document_id)) throw httpError(400, 'Invalid BOQ document id.');
            query = query.eq('boq_document_id', req.query.boq_document_id);
        }
        const term = String(req.query.search || '').replace(/[%_,()*\\"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (term) query = query.or(`quote_number.ilike.%${term}%,customer_name.ilike.%${term}%,project_name.ilike.%${term}%`);
        const { data, error, count } = await query;
        if (error) throw error;
        res.json({ data: data || [], total: count || 0, limit, offset });
    } catch (error) {
        sendError(res, error, 'Could not load quotations.');
    }
});

router.get('/quotations/:id', async (req, res) => {
    try {
        res.json(await loadOr404(req.params.id, req.user.id));
    } catch (error) {
        sendError(res, error, 'Could not load the quotation.');
    }
});

router.put('/quotations/:id', async (req, res) => {
    try {
        const view = await loadOr404(req.params.id, req.user.id);
        assertDraft(view);
        const patch = domain.normalizeQuotationPatch(req.body || {});
        if (Object.keys(patch).length) {
            const { data, error } = await supabase.from('quotations').update(patch)
                .eq('id', view.id).eq('user_id', req.user.id).eq('status', 'draft').select('id').maybeSingle();
            if (error) throw error;
            if (!data) throw httpError(409, 'This quotation was finalized meanwhile. Reload it.');
        }
        await respondWithView(res, view.id, req.user.id);
    } catch (error) {
        sendError(res, error, 'Could not save the quotation.');
    }
});

// Bulk line edit: [{ id, rate, qty, unit, description, include, section, remarks, hsn, size_mm }]
router.put('/quotations/:id/items', async (req, res) => {
    try {
        const list = req.body?.items;
        if (!Array.isArray(list) || !list.length) throw httpError(400, 'items must be a non-empty array.');
        if (list.length > MAX_BULK_ITEMS) throw httpError(400, `At most ${MAX_BULK_ITEMS} lines can be saved at once.`);
        const view = await loadOr404(req.params.id, req.user.id);
        assertDraft(view);
        const byId = new Map(view.items.map((item) => [String(item.id), item]));
        const seen = new Set();
        const patches = list.map((entry, index) => {
            const normalized = domain.normalizeItemPatch(entry, index);
            if (!byId.has(normalized.id)) throw httpError(400, `Line id ${normalized.id} does not belong to this quotation.`);
            if (seen.has(normalized.id)) throw httpError(400, `Line id ${normalized.id} appears twice.`);
            seen.add(normalized.id);
            return normalized;
        });
        const now = new Date().toISOString();
        const rows = patches.filter(({ patch }) => Object.keys(patch).length).map(({ id, patch }) => {
            const { amount: _amount, warnings: _warnings, ...stored } = byId.get(id);
            return { ...stored, ...patch, quotation_id: view.id, user_id: req.user.id, updated_at: now };
        });
        if (rows.length) await service.upsertItems(rows);
        await respondWithView(res, view.id, req.user.id);
    } catch (error) {
        sendError(res, error, 'Could not save the quotation lines.');
    }
});

router.delete('/quotations/:id', async (req, res) => {
    try {
        const quotation = await service.selectOwned('quotations', req.params.id, req.user.id);
        if (!quotation) throw httpError(404, 'Quotation not found.');
        if (quotation.status !== 'draft') throw httpError(409, 'Only drafts can be deleted; numbered quotations are kept as history.');
        await service.deleteQuotation(quotation.id, req.user.id);
        res.json({ success: true });
    } catch (error) {
        sendError(res, error, 'Could not delete the quotation.');
    }
});

router.post('/quotations/:id/duplicate', async (req, res) => {
    const userId = req.user.id;
    let created = null;
    try {
        const source = await loadOr404(req.params.id, userId);
        const latest = source.boq_document_id ? await service.latestForBoq(userId, source.boq_document_id) : null;
        const { data, error } = await supabase.from('quotations').insert({
            user_id: userId,
            boq_document_id: source.boq_document_id,
            source_quotation_id: source.id,
            version: (latest?.version || source.version || 0) + 1,
            quote_number: null,
            quote_date: domain.istDate(),
            validity_days: source.validity_days,
            customer_name: source.customer_name,
            customer_address: source.customer_address,
            customer_gstin: source.customer_gstin,
            project_name: source.project_name,
            reference_text: source.reference_text,
            supply_type: source.supply_type,
            gst_percent: source.gst_percent,
            discount_percent: source.discount_percent,
            freight: source.freight,
            status: 'draft',
            terms: source.terms,
            company: source.company,
            integrity: source.integrity,
        }).select('*').single();
        if (error) {
            if (error.code === '23505') throw httpError(409, 'Another copy was created at the same moment. Reload and try again.');
            throw error;
        }
        created = data;
        await service.insertItems(source.items.map((item) => ({
            ...Object.fromEntries(COPY_ITEM_FIELDS.map((field) => [field, item[field] ?? null])),
            quotation_id: created.id,
            user_id: userId,
        })));
        await respondWithView(res, created.id, userId, 201);
    } catch (error) {
        if (created?.id) await service.deleteQuotation(created.id, userId).catch(() => {});
        sendError(res, error, 'Could not duplicate the quotation.');
    }
});

// Finalize assigns SP/<FY>/<NNNN> atomically in the database (row lock +
// per-user per-financial-year counter) and makes the quotation read-only.
router.post('/quotations/:id/finalize', async (req, res) => {
    try {
        const view = await loadOr404(req.params.id, req.user.id);
        assertDraft(view);
        if (!view.finalize.ready) {
            throw httpError(422, 'This quotation cannot be finalized yet.', {
                blockers: view.finalize.blockers,
                unpriced_lines: view.finalize.unpriced_lines,
                placeholders: view.finalize.placeholders,
            });
        }
        const { error: snapshotError } = await supabase.from('quotations').update({ company: view.company })
            .eq('id', view.id).eq('user_id', req.user.id).eq('status', 'draft');
        if (snapshotError) throw snapshotError;
        const { error } = await supabase.rpc('finalize_quotation', { p_user_id: req.user.id, p_quotation_id: view.id });
        if (error) {
            const message = String(error.message || '');
            if (message.includes('quotation_unpriced_lines')) throw httpError(422, 'Every included line needs a rate greater than zero.');
            if (message.includes('quotation_not_draft')) throw httpError(409, 'This quotation is already finalized.');
            if (message.includes('quotation_not_found')) throw httpError(404, 'Quotation not found.');
            throw error;
        }
        await respondWithView(res, view.id, req.user.id);
    } catch (error) {
        sendError(res, error, 'Could not finalize the quotation.');
    }
});

router.get('/quotations/:id/export/excel', async (req, res) => {
    try {
        const view = await loadOr404(req.params.id, req.user.id);
        const internal = ['1', 'true'].includes(String(req.query.internal || ''));
        const buffer = await exporter.buildQuotationWorkbook({
            quotation: view, items: view.items, totals: view.totals, company: view.company, logo: view.logo, internal,
        });
        res.setHeader('Content-Disposition', `attachment; filename="${fileBase(view)}${internal ? '-INTERNAL' : ''}.xlsx"`);
        res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
    } catch (error) {
        sendError(res, error, 'Could not build the quotation spreadsheet.');
    }
});

router.get('/quotations/:id/export/pdf', async (req, res) => {
    try {
        const view = await loadOr404(req.params.id, req.user.id);
        const pdf = await exporter.renderQuotationPdf({
            quotation: view, items: view.items, totals: view.totals, company: view.company, logo: view.logo,
        });
        res.setHeader('Content-Disposition', `attachment; filename="${fileBase(view)}.pdf"`);
        res.type('application/pdf').send(pdf);
    } catch (error) {
        sendError(res, error, 'Could not build the quotation PDF.');
    }
});

// One PDF to one number typed (and confirmed) by the user. Never bulk.
router.post('/quotations/:id/send-whatsapp', sendLimiter, async (req, res) => {
    const userId = req.user.id;
    let claim = null;
    try {
        const view = await loadOr404(req.params.id, userId);
        if (!['final', 'sent'].includes(view.status)) throw httpError(409, 'Finalize the quotation before sending it.');
        const rawPhone = String(req.body?.phone || '').trim();
        if (!rawPhone) throw httpError(400, 'Enter the customer WhatsApp number.');
        const phone = ensureCountryCode(rawPhone, await resolveCountryCode(userId));
        if (!/^\d{8,15}$/.test(phone)) throw httpError(400, 'Enter a valid WhatsApp number with country code.');
        if (sessionManager.getStatus(userId) !== 'connected') {
            throw httpError(409, 'WhatsApp is not connected. Connect WhatsApp before sending the quotation.');
        }
        const pdf = await exporter.renderQuotationPdf({
            quotation: view, items: view.items, totals: view.totals, company: view.company, logo: view.logo,
        });

        claim = { id: view.id, at: new Date().toISOString() };
        const staleBefore = new Date(Date.now() - SEND_CLAIM_STALE_MS).toISOString();
        const { data: claimed, error: claimError } = await supabase.from('quotations').update({ send_claimed_at: claim.at })
            .eq('id', view.id).eq('user_id', userId).in('status', ['final', 'sent'])
            .or(`send_claimed_at.is.null,send_claimed_at.lt.${staleBefore}`)
            .select('id').maybeSingle();
        if (claimError) throw claimError;
        if (!claimed) {
            claim = null;
            throw httpError(409, 'This quotation is already being sent. Wait a moment and reload.');
        }

        const project = String(view.project_name || '').slice(0, 120);
        const caption = `Quotation ${view.quote_number} from ${view.company.name}${project ? ` for ${project}${view.project_name.length > 120 ? '...' : ''}` : ''}. Please find the PDF attached.`;
        try {
            await sessionManager.sendMessage(userId, phone, caption, null, {
                type: 'document',
                buffer: pdf,
                filename: `${fileBase(view)}.pdf`,
                mimetype: 'application/pdf',
            });
        } catch (sendFailure) {
            throw httpError(502, `WhatsApp could not deliver the quotation: ${sendFailure.message}`);
        }
        const sentAt = new Date().toISOString();
        const { error } = await supabase.from('quotations').update({
            status: 'sent', sent_at: sentAt, sent_to: phone, send_claimed_at: null,
        }).eq('id', view.id).eq('user_id', userId).eq('send_claimed_at', claim.at);
        if (error) throw error;
        claim = null;
        await respondWithView(res, view.id, userId, 200, { message: `Quotation sent to +${phone}.` });
    } catch (error) {
        if (claim) {
            await supabase.from('quotations').update({ send_claimed_at: null })
                .eq('id', claim.id).eq('user_id', userId).eq('send_claimed_at', claim.at)
                .then(() => {}, () => {});
        }
        if (error.statusCode === 502) {
            res.status(502).json({ error: error.message });
            return;
        }
        sendError(res, error, 'Could not send the quotation via WhatsApp.');
    }
});

module.exports = router;
