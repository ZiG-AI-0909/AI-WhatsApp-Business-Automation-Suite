'use strict';

// Proforma invoice persistence. Every query is scoped by user_id (the
// service-role client bypasses RLS, so application-layer scoping is the
// real isolation), as in documents/quotationService.js.

const { supabase } = require('../database/supabaseClient');
const { fiscalYearFor } = require('../documents/quotationDomain');
const { mergeProfile } = require('./proformaDefaults');
const { sanitizeInvoice } = require('./proformaValidation');
const calc = require('./proformaCalculation');

const LIST_COLUMNS = 'id,invoice_number,invoice_date,consignee_name,buyer_name,currency,grand_total,created_at,updated_at';
const MIGRATION_MESSAGE = 'Saving proforma invoices needs a database update: run supabase-proforma-migration.sql in the Supabase SQL Editor. Preview and Excel export still work.';

function httpError(status, message, extra) {
    const error = new Error(message);
    error.statusCode = status;
    error.expose = true;
    if (extra) error.extra = extra;
    return error;
}

// Table missing (migration not run yet): PostgREST PGRST205 / Postgres 42P01.
function isMissingTable(error) {
    return ['PGRST205', '42P01'].includes(error?.code) || /proforma_(invoices|profiles)/.test(String(error?.message || '')) && /does not exist|could not find/i.test(String(error?.message || ''));
}

function rethrow(error) {
    if (isMissingTable(error)) throw httpError(503, MIGRATION_MESSAGE, { code: 'PROFORMA_MIGRATION_PENDING' });
    throw error;
}

function isId(value) {
    return /^\d{1,18}$/.test(String(value ?? ''));
}

async function getProfile(userId) {
    const { data, error } = await supabase.from('proforma_profiles').select('profile').eq('user_id', userId).maybeSingle();
    if (error) {
        if (isMissingTable(error)) return { profile: mergeProfile(), saved: false, persistence: false };
        throw error;
    }
    return { profile: mergeProfile(data?.profile), saved: Boolean(data), persistence: true };
}

async function saveProfile(userId, profile) {
    const { error } = await supabase.from('proforma_profiles')
        .upsert({ user_id: userId, profile, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (error) rethrow(error);
    return mergeProfile(profile);
}

function rowFor(invoice, userId) {
    const totals = calc.calculate(invoice);
    return {
        user_id: userId,
        invoice_number: invoice.invoice.number.trim(),
        invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(invoice.invoice.date) ? invoice.invoice.date : null,
        consignee_name: invoice.consignee.name.trim().slice(0, 300),
        buyer_name: invoice.buyer.name.trim().slice(0, 300),
        currency: ['USD', 'EUR', 'GBP', 'AED'].includes(invoice.invoice.currency) ? invoice.invoice.currency : 'USD',
        grand_total: Number.isFinite(totals.grand_total) && Math.abs(totals.grand_total) < 1e14 ? totals.grand_total : 0,
        data: invoice,
    };
}

function numberClash(error, invoice) {
    if (error?.code === '23505') throw httpError(409, `Another saved invoice already uses the number "${invoice.invoice.number.trim()}". Change the number or open that invoice.`);
}

function view(row) {
    return { id: row.id, created_at: row.created_at, updated_at: row.updated_at, invoice: sanitizeInvoice(row.data) };
}

async function list(userId, { search = '', limit = 30, offset = 0 } = {}) {
    let query = supabase.from('proforma_invoices').select(LIST_COLUMNS, { count: 'exact' })
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit - 1);
    const term = String(search || '').replace(/[%_,()*\\"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (term) query = query.or(`invoice_number.ilike.%${term}%,consignee_name.ilike.%${term}%,buyer_name.ilike.%${term}%`);
    const { data, error, count } = await query;
    if (error) rethrow(error);
    return { data: data || [], total: count || 0, limit, offset };
}

async function get(id, userId) {
    if (!isId(id)) return null;
    const { data, error } = await supabase.from('proforma_invoices').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
    if (error) rethrow(error);
    return data ? view(data) : null;
}

async function create(userId, invoice) {
    const { data, error } = await supabase.from('proforma_invoices').insert(rowFor(invoice, userId)).select('*').single();
    if (error) {
        numberClash(error, invoice);
        rethrow(error);
    }
    return view(data);
}

async function update(id, userId, invoice) {
    if (!isId(id)) return null;
    const { user_id: _owner, ...patch } = rowFor(invoice, userId);
    const { data, error } = await supabase.from('proforma_invoices').update(patch)
        .eq('id', id).eq('user_id', userId).select('*').maybeSingle();
    if (error) {
        numberClash(error, invoice);
        rethrow(error);
    }
    return data ? view(data) : null;
}

async function remove(id, userId) {
    if (!isId(id)) return false;
    const { data, error } = await supabase.from('proforma_invoices').delete()
        .eq('id', id).eq('user_id', userId).select('id');
    if (error) rethrow(error);
    return Array.isArray(data) ? data.length > 0 : Boolean(data);
}

// "Alfatth_26-27/PI-04": the next {seq} after the highest saved number that
// matches the pattern for this prefix and financial year (April-March).
function shortFiscalYear(date) {
    const [start, end] = fiscalYearFor(date).split('-');
    return `${start.slice(2)}-${end}`;
}

function formatNumber(numbering, prefix, date, seq) {
    return numbering.pattern
        .replace(/\{prefix\}/g, prefix)
        .replace(/\{fy\}/g, shortFiscalYear(date))
        .replace(/\{seq\}/g, String(seq).padStart(numbering.seq_digits, '0'));
}

async function nextNumber(userId, { prefix, date }) {
    const { profile } = await getProfile(userId);
    const numbering = profile.numbering;
    const cleanPrefix = String(prefix ?? numbering.prefix ?? '').replace(/[^A-Za-z0-9-]+/g, '').slice(0, 40);
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const values = { prefix: escape(cleanPrefix), fy: escape(shortFiscalYear(date)), seq: '(\\d+)' };
    // Revisions such as "PI-03R5" still count as sequence 03.
    const source = numbering.pattern.split(/(\{prefix\}|\{fy\}|\{seq\})/)
        .map((part) => (/^\{(prefix|fy|seq)\}$/.test(part) ? values[part.slice(1, -1)] : escape(part))).join('');
    const pattern = new RegExp(`^${source}`, 'i');
    const { data, error } = await supabase.from('proforma_invoices').select('invoice_number').eq('user_id', userId).limit(5000);
    if (error && !isMissingTable(error)) throw error;
    const highest = (data || []).reduce((max, row) => {
        const match = String(row.invoice_number || '').match(pattern);
        return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return { number: formatNumber(numbering, cleanPrefix, date, highest + 1), prefix: cleanPrefix, numbering };
}

module.exports = {
    MIGRATION_MESSAGE,
    httpError,
    isMissingTable,
    getProfile,
    saveProfile,
    list,
    get,
    create,
    update,
    remove,
    nextNumber,
    formatNumber,
    shortFiscalYear,
};
