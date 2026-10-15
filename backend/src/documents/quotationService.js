'use strict';

// Quotation persistence. Every query is scoped by user_id (the service-role
// client bypasses RLS, so application-layer scoping is the real isolation).

const { supabase } = require('../database/supabaseClient');
const domain = require('./quotationDomain');

const PAGE_SIZE = 500;
const COMPANY_KEYS = ['BUSINESS_NAME', 'COMPANY_ADDRESS', 'COMPANY_STATE', 'COMPANY_GSTIN', 'COMPANY_PHONE', 'COMPANY_EMAIL', 'COMPANY_BANK_DETAILS', 'COMPANY_LOGO'];

function isId(value) {
    return /^\d{1,18}$/.test(String(value ?? ''));
}

async function selectOwned(table, id, userId) {
    if (!isId(id)) return null;
    const { data, error } = await supabase.from(table).select('*')
        .eq('id', id).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data || null;
}

async function getItems(quotationId, userId) {
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
        const { data, error } = await supabase.from('quotation_items').select('*')
            .eq('quotation_id', quotationId).eq('user_id', userId)
            .order('line_no', { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < PAGE_SIZE) break;
    }
    return rows.map(normalizeItemRow);
}

// numeric columns arrive as strings from some PostgREST versions.
function numericOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeItemRow(row) {
    return {
        ...row,
        qty: numericOrNull(row.qty),
        rate: numericOrNull(row.rate),
        size_mm: numericOrNull(row.size_mm),
        ref_rate: numericOrNull(row.ref_rate),
        ref_amount: numericOrNull(row.ref_amount),
        include: row.include === true,
        section: row.section === 'A' ? 'A' : 'B',
        spec: row.spec && typeof row.spec === 'object' ? row.spec : {},
        flags: Array.isArray(row.flags) ? row.flags : [],
    };
}

function normalizeQuotationRow(row) {
    return {
        ...row,
        gst_percent: numericOrNull(row.gst_percent) ?? 18,
        discount_percent: numericOrNull(row.discount_percent) ?? 0,
        freight: numericOrNull(row.freight) ?? 0,
        validity_days: numericOrNull(row.validity_days) ?? 30,
        supply_type: row.supply_type === 'inter' ? 'inter' : 'intra',
        terms: Array.isArray(row.terms) ? row.terms : [],
        company: row.company && typeof row.company === 'object' ? row.company : {},
        integrity: row.integrity && typeof row.integrity === 'object' ? row.integrity : {},
    };
}

async function getCompany(userId) {
    const { data, error } = await supabase.from('app_settings').select('key,value')
        .eq('user_id', userId).in('key', COMPANY_KEYS);
    if (error) throw error;
    const values = {};
    for (const row of data || []) values[row.key] = row.value;
    return { company: domain.companyFromSettings(values), logo: String(values.COMPANY_LOGO || '') };
}

// Drafts show the live Settings profile; finalized quotations keep the
// snapshot taken at finalize so a later Settings change cannot alter them.
function effectiveCompany(quotation, liveCompany) {
    const snapshot = quotation.company || {};
    if (quotation.status !== 'draft' && snapshot.name) return snapshot;
    return liveCompany;
}

function buildView(rawQuotation, items, liveCompany) {
    const quotation = normalizeQuotationRow(rawQuotation);
    const company = effectiveCompany(quotation, liveCompany);
    const totals = domain.calculateTotals(quotation, items);
    const byLine = new Map(totals.lines.map((line) => [line.line_no, line]));
    const { lines, ...summary } = totals;
    return {
        ...quotation,
        company,
        items: items.map((item) => ({ ...item, amount: byLine.get(item.line_no)?.amount ?? null, warnings: byLine.get(item.line_no)?.warnings || [] })),
        totals: summary,
        unpriced_lines: summary.unpriced_lines,
        finalize: domain.finalizeCheck(quotation, items, company),
    };
}

async function loadView(quotationId, userId) {
    const quotation = await selectOwned('quotations', quotationId, userId);
    if (!quotation) return null;
    const [items, { company, logo }] = await Promise.all([getItems(quotation.id, userId), getCompany(userId)]);
    const view = buildView(quotation, items, company);
    Object.defineProperty(view, 'logo', { value: logo, enumerable: false });
    return view;
}

// Snapshot of the server totals for the list view (never browser totals).
async function persistSummary(view, userId) {
    const { error } = await supabase.from('quotations').update({
        subtotal: view.totals.subtotal,
        grand_total: view.totals.grand_total,
        unpriced_lines: view.totals.unpriced_lines,
    }).eq('id', view.id).eq('user_id', userId);
    if (error) throw error;
}

async function insertItems(rows) {
    for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
        const { error } = await supabase.from('quotation_items').insert(rows.slice(offset, offset + PAGE_SIZE));
        if (error) throw error;
    }
}

async function upsertItems(rows) {
    for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
        const { error } = await supabase.from('quotation_items')
            .upsert(rows.slice(offset, offset + PAGE_SIZE), { onConflict: 'id' });
        if (error) throw error;
    }
}

async function latestForBoq(userId, boqDocumentId) {
    const { data, error } = await supabase.from('quotations').select('*')
        .eq('user_id', userId).eq('boq_document_id', boqDocumentId)
        .order('version', { ascending: false }).limit(1);
    if (error) throw error;
    return data?.[0] || null;
}

async function deleteQuotation(quotationId, userId) {
    const { error } = await supabase.from('quotations').delete().eq('id', quotationId).eq('user_id', userId);
    if (error) throw error;
}

module.exports = {
    supabase,
    isId,
    selectOwned,
    getItems,
    getCompany,
    normalizeItemRow,
    normalizeQuotationRow,
    buildView,
    loadView,
    persistSummary,
    insertItems,
    upsertItems,
    latestForBoq,
    deleteQuotation,
};
