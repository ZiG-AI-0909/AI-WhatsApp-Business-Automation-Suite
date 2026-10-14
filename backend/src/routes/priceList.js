'use strict';

const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { parse: parseCsv } = require('csv-parse/sync');
const domain = require('../documents/quotationDomain');
const { supabase } = require('../database/supabaseClient');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => callback(null, /\.(xlsx|csv)$/i.test(file.originalname || '')),
});

function cellText(cell) {
    if (cell === null || cell === undefined) return '';
    if (typeof cell === 'object' && 'text' in cell) return cell.text;
    if (typeof cell === 'object' && 'result' in cell) return cell.result;
    return String(cell).trim();
}

async function readRows(file) {
    let headers;
    let sourceRows;
    if (/\.csv$/i.test(file.originalname)) {
        const records = parseCsv(file.buffer, { bom: true, skip_empty_lines: true, trim: true, relax_column_count: true });
        headers = (records.shift() || []).map(cellText);
        sourceRows = records.map((values, index) => ({ rowNumber: index + 2, values }));
    } else {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(file.buffer);
        const worksheet = workbook.worksheets[0];
        if (!worksheet || worksheet.rowCount < 2) throw new Error('The price list needs a header row and at least one data row.');
        headers = worksheet.getRow(1).values.slice(1).map(cellText);
        sourceRows = [];
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            sourceRows.push({ rowNumber, values: row.values.slice(1).map(cellText) });
        });
    }
    if (!sourceRows?.length) throw new Error('The price list needs a header row and at least one data row.');
    const mapped = domain.mapPriceListHeaders(headers);
    for (const required of ['item_code', 'name', 'unit', 'rate']) {
        if (mapped[required] === undefined) throw new Error(`Required price-list column not found: ${required.replace('_', ' ')}.`);
    }
    const seen = new Set();
    const rows = [];
    for (const { rowNumber, values } of sourceRows) {
        if (values.every((value) => !String(value ?? '').trim())) continue;
        const result = domain.validatePriceListRow(values, mapped, rowNumber);
        const code = domain.normalizeText(result.item.item_code);
        if (code && seen.has(code)) {
            result.valid = false;
            result.errors.push('duplicate item code in this upload');
        }
        if (code) seen.add(code);
        rows.push(result);
    }
    return rows;
}

function sendError(res, error, fallback = 'Price-list request failed.') {
    const status = error.code ? 500 : 400;
    if (status >= 500) console.error('[price-list] request failed:', error.message);
    res.status(status).json({ error: status === 400 ? error.message : fallback });
}

router.get('/template', async (_req, res) => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Price List');
    worksheet.addRow(['Item Code', 'Description', 'Category', 'Size', 'PN / Pressure Class', 'Specification / Standard', 'Unit', 'Rate', 'HSN', 'GST %']);
    worksheet.addRow(['PIPE-001', 'Example pipe', 'Pipes', '50 mm', 'PN 10', 'IS 1239', 'metre', 125.5, '7306', 18]);
    worksheet.getRow(1).font = { bold: true };
    worksheet.columns = [{ width: 18 }, { width: 28 }, { width: 18 }, { width: 14 }, { width: 22 }, { width: 26 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 10 }];
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', 'attachment; filename="price-list-import-template.xlsx"');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buffer));
});

router.get('/', async (req, res) => {
    try {
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        let query = supabase.from('price_list_items').select('*', { count: 'exact' })
            .eq('user_id', req.user.id).order('item_code', { ascending: true }).range(offset, offset + limit - 1);
        if (req.query.active !== 'false') query = query.eq('active', true);
        if (req.query.search) {
            const search = `%${String(req.query.search).replace(/[%(),]/g, ' ').trim()}%`;
            query = query.or(`item_code.ilike.${search},name.ilike.${search},category.ilike.${search},size.ilike.${search}`);
        }
        const { data, error, count } = await query;
        if (error) throw error;
        res.json({ data: data || [], total: count || 0, limit, offset });
    } catch (error) { sendError(res, error, 'Could not load the price list.'); }
});

router.post('/import/preview', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Choose an XLSX or CSV price-list file.' });
        const rows = await readRows(req.file);
        res.json({
            rows,
            total: rows.length,
            valid: rows.filter((row) => row.valid).length,
            invalid: rows.filter((row) => !row.valid).length,
        });
    } catch (error) { sendError(res, error, 'Could not read the price-list file.'); }
});

router.post('/import', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Choose an XLSX or CSV price-list file.' });
        const parsed = await readRows(req.file);
        const validRows = parsed.filter((row) => row.valid).map((row) => ({
            ...row.item,
            user_id: req.user.id,
            updated_at: new Date().toISOString(),
        }));
        let imported = 0;
        for (let offset = 0; offset < validRows.length; offset += 500) {
            const { data, error } = await supabase.from('price_list_items')
                .upsert(validRows.slice(offset, offset + 500), { onConflict: 'user_id,item_code' }).select('id');
            if (error) throw error;
            imported += data?.length || 0;
        }
        res.json({
            imported,
            skipped: parsed.length - imported,
            errors: parsed.filter((row) => !row.valid).map(({ rowNumber, errors }) => ({ rowNumber, errors })),
        });
    } catch (error) { sendError(res, error, 'Could not import price-list rows.'); }
});

router.post('/', async (req, res) => {
    try {
        const body = domain.validatePriceListRow([
            req.body?.item_code, req.body?.name, req.body?.category, req.body?.size,
            req.body?.pressure_class, req.body?.specification, req.body?.unit,
            req.body?.rate, req.body?.hsn_code, req.body?.gst_percent ?? 18,
        ], Object.fromEntries(['item_code', 'name', 'category', 'size', 'pressure_class', 'specification', 'unit', 'rate', 'hsn_code', 'gst_percent'].map((field, index) => [field, index])), 1);
        if (!body.valid) return res.status(400).json({ error: body.errors.join('; ') });
        const { data, error } = await supabase.from('price_list_items').insert({
            ...body.item, user_id: req.user.id, updated_at: new Date().toISOString(),
        }).select('*').single();
        if (error) throw error;
        res.status(201).json(data);
    } catch (error) { sendError(res, error, 'Could not add price-list item.'); }
});

router.put('/:id', async (req, res) => {
    try {
        const { data: existing, error: readError } = await supabase.from('price_list_items').select('id')
            .eq('id', req.params.id).eq('user_id', req.user.id).maybeSingle();
        if (readError) throw readError;
        if (!existing) return res.status(404).json({ error: 'Price-list item not found.' });
        const body = domain.validatePriceListRow([
            req.body?.item_code, req.body?.name, req.body?.category, req.body?.size,
            req.body?.pressure_class, req.body?.specification, req.body?.unit,
            req.body?.rate, req.body?.hsn_code, req.body?.gst_percent ?? 18,
        ], Object.fromEntries(['item_code', 'name', 'category', 'size', 'pressure_class', 'specification', 'unit', 'rate', 'hsn_code', 'gst_percent'].map((field, index) => [field, index])), 1);
        if (!body.valid) return res.status(400).json({ error: body.errors.join('; ') });
        const { data, error } = await supabase.from('price_list_items').update({
            ...body.item,
            active: req.body.active !== false,
            updated_at: new Date().toISOString(),
        }).eq('id', req.params.id).eq('user_id', req.user.id).select('*').single();
        if (error) throw error;
        res.json(data);
    } catch (error) { sendError(res, error, 'Could not update price-list item.'); }
});

router.post('/:id/deactivate', async (req, res) => {
    try {
        const { data, error } = await supabase.from('price_list_items').update({
            active: false, updated_at: new Date().toISOString(),
        }).eq('id', req.params.id).eq('user_id', req.user.id).select('*').maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Price-list item not found.' });
        res.json(data);
    } catch (error) { sendError(res, error, 'Could not deactivate price-list item.'); }
});

module.exports = router;
module.exports.readRows = readRows;
