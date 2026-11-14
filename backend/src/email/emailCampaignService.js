// =============================================================
// Bulk email campaigns — the email twin of WhatsApp bulk messaging.
//
// Flow: upload Excel/CSV (or paste addresses) → write a subject + message
// with {{name}}-style fields → preview / test to yourself → start. A
// background runner sends one email at a time with a pause between each,
// respects a rolling 24-hour limit (Gmail free ≈ 500/day), and keeps going
// by itself after the limit window frees up or the server restarts.
//
// Data lives in email_campaigns / email_campaign_recipients (see
// supabase-email-campaigns-migration.sql) — never in the WhatsApp tables.
// =============================================================
const crypto = require('node:crypto');
const db = require('../database/db');
const emailSender = require('./emailSender');

const CAMPAIGNS = 'email_campaigns';
const RECIPIENTS = 'email_campaign_recipients';
const UNSUBSCRIBES = 'email_unsubscribes';

const MAX_RECIPIENTS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SETTINGS = { delaySeconds: 5, dailyLimit: 400 };
const MAX_CONSECUTIVE_FAILURES = 5;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

const runners = new Map(); // campaignId -> { cancelled, wake }

// ─── helpers ──────────────────────────────────────────────────

function migrationError(error) {
    const text = `${error?.code || ''} ${error?.message || ''}`;
    if (/42P01|PGRST205|does not exist|Could not find the table/i.test(text) && /email_/i.test(text)) {
        const err = new Error('Bulk email needs a one-time database update. Ask your administrator to run supabase-email-campaigns-migration.sql in Supabase.');
        err.statusCode = 503;
        err.code = 'EMAIL_MIGRATION_PENDING';
        return err;
    }
    return error;
}

function userError(message, statusCode = 400) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

function cleanEmail(value) {
    return String(value ?? '').trim().replace(/^mailto:/i, '').replace(/^<|>$/g, '').trim().toLowerCase();
}

function isValidEmail(value) {
    return EMAIL_RE.test(value) && value.length <= 254;
}

function normalizeColumn(name) {
    return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function isEmailHeader(name) {
    const col = normalizeColumn(name);
    return ['email', 'e_mail', 'mail', 'email_id', 'emailid', 'email_address', 'mail_id', 'gmail'].includes(col)
        || /^(?:[a-z]+_)*e_?mail(?:_?(?:id|address|\d+))?$/.test(col);
}

function canonicalColumn(name) {
    const col = normalizeColumn(name);
    if (['dealer_name', 'business_name', 'full_name', 'customer_name', 'contact_name'].includes(col)) return 'name';
    if (['place', 'town', 'location'].includes(col)) return 'city';
    return col;
}

function stringifyCell(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'object') {
        if (value.text !== undefined) return stringifyCell(value.text);
        if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
        if (value.hyperlink) return String(value.hyperlink);
        if (value.result !== undefined) return stringifyCell(value.result);
        return '';
    }
    return String(value).trim();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function looksLikeHtml(text) {
    return /<\/?(p|div|br|a|b|strong|i|em|ul|ol|li|h[1-6]|table|img|span)\b[^>]*>/i.test(text);
}

function findField(fields, key) {
    if (fields[key] !== undefined) return fields[key];
    const found = Object.keys(fields).find(k => k.toLowerCase() === key);
    return found ? fields[found] : undefined;
}

/** Replace {{field}} with the recipient's value; missing → ''. */
function fillFields(template, fields, transform = v => v) {
    return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, field) => {
        const value = findField(fields, normalizeColumn(field));
        return value === undefined || value === null ? '' : transform(String(value));
    });
}

function missingFields(template, fields) {
    const names = [...String(template || '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => normalizeColumn(m[1]));
    return [...new Set(names)].filter(name => {
        const v = findField(fields, name);
        return v === undefined || v === null || String(v).trim() === '';
    });
}

function linkify(escapedText) {
    return escapedText.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g, url => `<a href="${url}">${url}</a>`);
}

/** Render one recipient's email. Plain-text bodies become simple HTML. */
function renderEmail(subject, body, fields) {
    const renderedSubject = fillFields(subject, fields).replace(/[\r\n]+/g, ' ').trim();
    let html;
    if (looksLikeHtml(body)) {
        html = fillFields(body, fields, escapeHtml);
    } else {
        const text = fillFields(body, fields);
        html = escapeHtml(text)
            .split(/\n{2,}/)
            .map(paragraph => `<p>${linkify(paragraph).replace(/\n/g, '<br>')}</p>`)
            .join('\n');
    }
    return { subject: renderedSubject, html };
}

function htmlToText(html) {
    return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n\n')
        .replace(/<a\s[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_m, href, label) => (label === href ? href : `${label} (${href})`))
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function wrapHtml(innerHtml, unsubscribeUrl) {
    const footer = unsubscribeUrl
        ? `<p style="margin-top:32px;font-size:12px;color:#888">Don't want these emails? <a href="${escapeHtml(unsubscribeUrl)}" style="color:#888">Unsubscribe</a></p>`
        : '';
    return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:640px">${innerHtml}${footer}</body></html>`;
}

// ─── pictures ────────────────────────────────────────────────
// Up to 3 pictures per campaign, kept in the campaign row and sent as
// inline (CID) attachments, so they show in the email without any public
// image hosting.
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function normalizeImages(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw userError('Pictures could not be read. Please add them again.');
    if (list.length > MAX_IMAGES) throw userError(`You can add up to ${MAX_IMAGES} pictures.`);
    return list.map((img, i) => {
        const contentType = String(img?.contentType || '').toLowerCase();
        if (!IMAGE_TYPES.has(contentType)) throw userError('Pictures must be JPG, PNG, GIF or WEBP.');
        const data = String(img?.data || '').replace(/^data:[^,]*,/, '');
        if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) throw userError('A picture could not be read. Please add it again.');
        if (Buffer.byteLength(data, 'base64') > MAX_IMAGE_BYTES) throw userError('Each picture must be 1 MB or smaller.');
        const filename = String(img?.filename || `picture-${i + 1}`).replace(/[^\w.-]+/g, '_').slice(0, 80);
        return { filename, contentType, data };
    });
}

function imagesHtml(images, srcFor) {
    return images.map((img, i) => `<p><img src="${srcFor(img, i)}" alt="" style="max-width:100%;height:auto;border-radius:6px"></p>`).join('\n');
}

function inlineAttachments(images) {
    return images.map((img, i) => ({ filename: img.filename, content: Buffer.from(img.data, 'base64'), contentType: img.contentType, cid: `img${i}@campaign` }));
}

// ─── unsubscribe tokens ───────────────────────────────────────

function tokenSecret() {
    return process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.ENCRYPTION_KEY || 'email-unsubscribe-dev-secret';
}

function unsubscribeToken(userId, email) {
    const payload = Buffer.from(`${userId}\n${email}`).toString('base64url');
    const sig = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url').slice(0, 32);
    return `${payload}.${sig}`;
}

function readUnsubscribeToken(token) {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url').slice(0, 32);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const [userId, email] = Buffer.from(payload, 'base64url').toString('utf8').split('\n');
    return userId && email ? { userId, email } : null;
}

function sleep(ms, runner) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        if (runner) runner.wake = () => { clearTimeout(timer); resolve(); };
    });
}

// ─── recipient parsing ────────────────────────────────────────

/** Build recipients from a header row + data rows (shared by xlsx/csv). */
function buildRecipients(table) {
    const headerIndex = table.findIndex(row => row.some(cell => isEmailHeader(cell)));
    let headers;
    let dataRows;
    if (headerIndex >= 0) {
        headers = table[headerIndex].map(cell => canonicalColumn(cell));
        dataRows = table.slice(headerIndex + 1).map((cells, i) => ({ cells, rowNumber: headerIndex + i + 2 }));
    } else {
        // No recognisable header: use the first column that holds addresses.
        const width = Math.max(0, ...table.map(r => r.length));
        const emailCol = [...Array(width).keys()].find(c => table.some(r => isValidEmail(cleanEmail(r[c]))));
        if (emailCol === undefined) throw userError('No email addresses were found. Add a column called "Email" with one address per row.');
        headers = [...Array(width).keys()].map(c => (c === emailCol ? 'email' : `column_${c + 1}`));
        dataRows = table.map((cells, i) => ({ cells, rowNumber: i + 1 }));
    }

    const emailIndex = headers.findIndex(h => isEmailHeader(h)) >= 0 ? headers.findIndex(h => isEmailHeader(h)) : headers.indexOf('email');
    const columns = [...new Set(headers.filter(Boolean).map(h => (isEmailHeader(h) ? 'email' : h)))];
    const seen = new Set();
    const recipients = [];
    const invalid = [];
    let duplicates = 0;

    for (const { cells, rowNumber } of dataRows) {
        if (!cells.some(cell => String(cell ?? '').trim())) continue;
        const raw = String(cells[emailIndex] ?? '').trim();
        // One cell may hold several addresses: "a@x.com; b@y.com".
        const candidates = raw.split(/[;,\s/]+/).map(cleanEmail).filter(Boolean);
        const fields = {};
        headers.forEach((header, i) => {
            if (!header || i === emailIndex) return;
            const value = String(cells[i] ?? '').trim();
            if (value && fields[header] === undefined) fields[header] = value;
        });
        if (!candidates.length) {
            invalid.push({ row: rowNumber, value: '', reason: 'No email address' });
            continue;
        }
        for (const email of candidates) {
            if (!isValidEmail(email)) {
                invalid.push({ row: rowNumber, value: email, reason: 'Not a valid email address' });
                continue;
            }
            if (seen.has(email)) { duplicates += 1; continue; }
            seen.add(email);
            recipients.push({ email, name: fields.name || '', fields: { ...fields, email } });
        }
    }
    return { columns, recipients, invalid, duplicates };
}

async function parseFile(buffer, filename) {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    let table;
    if (ext === 'csv' || ext === 'txt') {
        const { parse } = require('csv-parse/sync');
        const text = buffer.toString('utf8').replace(/^﻿/, '');
        const delimiter = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
        table = parse(text, { delimiter, relax_column_count: true, skip_empty_lines: true, trim: true });
    } else if (ext === 'xlsx') {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        table = [];
        // Use the first sheet that contains an email address.
        for (const sheet of workbook.worksheets) {
            const rows = [];
            sheet.eachRow({ includeEmpty: false }, row => {
                const values = [];
                row.eachCell({ includeEmpty: true }, (cell, col) => { values[col - 1] = stringifyCell(cell.value); });
                rows.push(Array.from(values, v => v ?? ''));
            });
            if (rows.some(r => r.some(c => c.includes('@')))) { table = rows; break; }
        }
    } else {
        throw userError('Please upload an Excel (.xlsx) or CSV (.csv) file.');
    }
    if (!table.length) throw userError('The file is empty or has no email addresses.');
    return finishParse(buildRecipients(table));
}

/** Pasted text: one person per line — "email" or "Name, email" or "email, Name". */
function parsePasted(text) {
    const table = String(text || '').split(/\r?\n/).map(line => line.split(/[,\t;]/).map(s => s.trim())).filter(r => r.some(Boolean));
    if (!table.length) throw userError('Paste at least one email address.');
    const rows = table.map(cells => {
        const email = cells.find(c => c.includes('@')) || '';
        const name = cells.find(c => c && !c.includes('@')) || '';
        return [email, name];
    });
    return finishParse(buildRecipients([['email', 'name'], ...rows]));
}

function finishParse(result) {
    if (result.recipients.length > MAX_RECIPIENTS) {
        throw userError(`This list has ${result.recipients.length} addresses. One campaign can send to at most ${MAX_RECIPIENTS}; please split the file.`);
    }
    if (!result.recipients.length) throw userError('No valid email addresses were found in this list.');
    return { ...result, invalid: result.invalid.slice(0, 200), invalidCount: result.invalid.length };
}

function normalizeSettings(input = {}) {
    const delaySeconds = Math.min(120, Math.max(2, Number(input.delaySeconds) || DEFAULT_SETTINGS.delaySeconds));
    const dailyLimit = Math.min(10000, Math.max(1, Math.floor(Number(input.dailyLimit) || DEFAULT_SETTINGS.dailyLimit)));
    return { delaySeconds, dailyLimit };
}

function sanitizeRecipients(list) {
    if (!Array.isArray(list) || !list.length) throw userError('Add at least one recipient.');
    if (list.length > MAX_RECIPIENTS) throw userError(`One campaign can send to at most ${MAX_RECIPIENTS} addresses.`);
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const email = cleanEmail(item?.email);
        if (!isValidEmail(email) || seen.has(email)) continue;
        seen.add(email);
        const fields = {};
        for (const [key, value] of Object.entries(item?.fields || {})) {
            const k = normalizeColumn(key);
            if (k && value !== null && value !== undefined && Object.keys(fields).length < 50) fields[k] = String(value).slice(0, 2000);
        }
        fields.email = email;
        const name = String(item?.name || fields.name || '').slice(0, 200);
        if (name && !fields.name) fields.name = name;
        out.push({ email, name, fields });
    }
    if (!out.length) throw userError('None of the recipients has a valid email address.');
    return out;
}

function validateContent({ subject, body }) {
    if (!String(subject || '').trim()) throw userError('Please write a subject line.');
    if (String(subject).length > 300) throw userError('The subject line is too long (300 characters at most).');
    if (!String(body || '').trim()) throw userError('Please write the email message.');
    if (String(body).length > 100000) throw userError('The message is too long.');
}

// ─── service ──────────────────────────────────────────────────

class EmailCampaignService {
    parseFile(buffer, filename) { return parseFile(buffer, filename); }
    parsePasted(text) { return parsePasted(text); }

    preview({ subject, body, recipients = [], images: rawImages }) {
        validateContent({ subject, body });
        const images = normalizeImages(rawImages);
        const sample = (recipients.length ? recipients : [{ email: 'customer@example.com', name: 'Customer', fields: { name: 'Customer' } }]).slice(0, 3);
        return sample.map(r => {
            const fields = { ...(r.fields || {}), email: r.email, ...(r.name && !r.fields?.name ? { name: r.name } : {}) };
            const rendered = renderEmail(subject, body, fields);
            const pics = imagesHtml(images, img => `data:${img.contentType};base64,${img.data}`);
            return { email: r.email, subject: rendered.subject, html: wrapHtml(rendered.html + pics, '#'), missingFields: [...new Set([...missingFields(subject, fields), ...missingFields(body, fields)])] };
        });
    }

    async sendTest(userId, toEmail, { subject, body, recipient, images: rawImages }) {
        validateContent({ subject, body });
        const images = normalizeImages(rawImages);
        if (!toEmail) throw userError('Your account has no email address to send the test to.');
        const fields = recipient ? { ...(recipient.fields || {}), email: recipient.email, name: recipient.name || recipient.fields?.name || '' } : { name: 'Customer', email: toEmail };
        const rendered = renderEmail(subject, body, fields);
        const html = wrapHtml(rendered.html + imagesHtml(images, (_img, i) => `cid:img${i}@campaign`), null);
        await emailSender.send(userId, { to: toEmail, subject: `[Test] ${rendered.subject}`, html, text: htmlToText(html), attachments: inlineAttachments(images) });
        return { message: `Test email sent to ${toEmail}. Check your inbox (and spam folder).` };
    }

    async list(userId) {
        try {
            const rows = await db.select(CAMPAIGNS, '*', 'user_id = ?', [userId], 'created_at desc', 100, 0);
            // Pictures stay on the server; the list only needs how many.
            return rows.map(r => ({ ...r, settings: { ...(r.settings || {}), images: undefined, imageCount: (r.settings?.images || []).length } }));
        } catch (error) { throw migrationError(error); }
    }

    async get(id, userId) {
        try {
            const [row] = await db.select(CAMPAIGNS, '*', 'id = ? AND user_id = ?', [id, userId], '', 1, 0);
            return row || null;
        } catch (error) { throw migrationError(error); }
    }

    async _require(id, userId) {
        const campaign = await this.get(id, userId);
        if (!campaign) throw userError('Campaign not found.', 404);
        return campaign;
    }

    async getRecipients(id, userId, { status, page = 1, limit = 50 } = {}) {
        await this._require(id, userId);
        const where = status ? 'campaign_id = ? AND user_id = ? AND status = ?' : 'campaign_id = ? AND user_id = ?';
        const params = status ? [id, userId, status] : [id, userId];
        const safeLimit = Math.min(200, Math.max(1, limit));
        const [rows, total] = await Promise.all([
            db.select(RECIPIENTS, 'id, email, name, status, error, sent_at, attempts', where, params, 'id', safeLimit, (Math.max(1, page) - 1) * safeLimit),
            db.count(RECIPIENTS, where, params),
        ]);
        return { recipients: rows, total, page, limit: safeLimit };
    }

    async create(userId, { name, subject, body, recipients, settings, images: rawImages }) {
        if (!String(name || '').trim()) throw userError('Please give the campaign a name.');
        validateContent({ subject, body });
        const images = normalizeImages(rawImages);
        const clean = sanitizeRecipients(recipients);

        let unsubscribed = new Set();
        try {
            const rows = await db.select(UNSUBSCRIBES, 'email', 'user_id = ?', [userId], '', 50000, 0);
            unsubscribed = new Set(rows.map(r => r.email));
        } catch (error) { throw migrationError(error); }

        let campaign;
        try {
            campaign = await db.insert(CAMPAIGNS, {
                user_id: userId,
                name: String(name).trim().slice(0, 200),
                subject: String(subject).trim(),
                body: String(body),
                status: 'draft',
                total: clean.length,
                settings: { ...normalizeSettings(settings), images },
            });
        } catch (error) { throw migrationError(error); }

        const rows = clean.map(r => {
            const rendered = renderEmail(campaign.subject, campaign.body, r.fields);
            const skip = unsubscribed.has(r.email);
            return {
                campaign_id: campaign.id,
                user_id: userId,
                email: r.email,
                name: r.name || null,
                fields: r.fields,
                rendered_subject: rendered.subject,
                rendered_body: rendered.html,
                status: skip ? 'skipped' : 'pending',
                error: skip ? 'This person unsubscribed earlier' : null,
            };
        });
        try {
            for (let i = 0; i < rows.length; i += 500) await db.insertMany(RECIPIENTS, rows.slice(i, i + 500));
        } catch (error) {
            await db.del(CAMPAIGNS, 'id = ? AND user_id = ?', [campaign.id, userId]).catch(() => {});
            throw migrationError(error);
        }
        await this._recount(campaign.id, userId);
        return this.get(campaign.id, userId);
    }

    async start(id, userId, { publicBaseUrl } = {}) {
        const campaign = await this._require(id, userId);
        if (!['draft', 'paused'].includes(campaign.status)) {
            throw userError(campaign.status === 'running' ? 'This campaign is already sending.' : 'This campaign has finished. Use "Retry failed" or duplicate it to send again.');
        }
        const sender = await emailSender.getConfig(userId);
        if (!sender.ready) throw userError('Email sending is not set up yet. Open Settings → Email and add your sending account first.');

        const others = await db.select(CAMPAIGNS, 'id', 'user_id = ? AND status = ?', [userId, 'running'], '', 5, 0);
        if (others.some(o => Number(o.id) !== Number(id))) {
            throw userError('Another email campaign is already sending. Pause it or wait for it to finish — emails go out one campaign at a time to protect your sending account.');
        }

        const settings = { ...(campaign.settings || {}), ...(publicBaseUrl ? { publicBaseUrl } : {}) };
        await db.update(CAMPAIGNS, {
            status: 'running',
            last_error: null,
            settings,
            started_at: campaign.started_at || new Date(),
            completed_at: null,
            updated_at: new Date(),
        }, 'id = ? AND user_id = ?', [id, userId]);
        this._launch(id, userId);
        return this.get(id, userId);
    }

    async pause(id, userId) {
        const campaign = await this._require(id, userId);
        if (campaign.status !== 'running') throw userError('Only a sending campaign can be paused.');
        await db.update(CAMPAIGNS, { status: 'paused', last_error: null, updated_at: new Date() }, 'id = ? AND user_id = ?', [id, userId]);
        this._cancel(id);
        return this.get(id, userId);
    }

    resume(id, userId, opts) { return this.start(id, userId, opts); }

    async stop(id, userId) {
        const campaign = await this._require(id, userId);
        if (!['running', 'paused', 'draft'].includes(campaign.status)) throw userError('This campaign has already finished.');
        this._cancel(id);
        await db.update(CAMPAIGNS, { status: 'stopped', completed_at: new Date(), updated_at: new Date() }, 'id = ? AND user_id = ?', [id, userId]);
        await db.update(RECIPIENTS, { status: 'skipped', error: 'Campaign was stopped before this email was sent' }, 'campaign_id = ? AND user_id = ? AND status = ?', [id, userId, 'pending']);
        await this._recount(id, userId);
        return this.get(id, userId);
    }

    async retryFailed(id, userId, opts) {
        const campaign = await this._require(id, userId);
        if (campaign.status === 'running') throw userError('Wait for the campaign to finish, or pause it, before retrying.');
        const failed = await db.count(RECIPIENTS, 'campaign_id = ? AND user_id = ? AND status = ?', [id, userId, 'failed']);
        if (!failed) throw userError('There are no failed emails to retry.');
        await db.update(RECIPIENTS, { status: 'pending', error: null }, 'campaign_id = ? AND user_id = ? AND status = ?', [id, userId, 'failed']);
        await db.update(CAMPAIGNS, { status: 'paused', completed_at: null, updated_at: new Date() }, 'id = ? AND user_id = ?', [id, userId]);
        await this._recount(id, userId);
        return this.start(id, userId, opts);
    }

    async delete(id, userId) {
        await this._require(id, userId);
        this._cancel(id);
        await db.del(RECIPIENTS, 'campaign_id = ? AND user_id = ?', [id, userId]);
        await db.del(CAMPAIGNS, 'id = ? AND user_id = ?', [id, userId]);
        return { success: true };
    }

    async unsubscribe(token) {
        const parsed = readUnsubscribeToken(token);
        if (!parsed) return false;
        const existing = await db.select(UNSUBSCRIBES, 'id', 'user_id = ? AND email = ?', [parsed.userId, parsed.email], '', 1, 0);
        if (!existing.length) await db.insert(UNSUBSCRIBES, { user_id: parsed.userId, email: parsed.email });
        // Stop anything still queued for this address.
        await db.update(RECIPIENTS, { status: 'skipped', error: 'This person unsubscribed' }, 'user_id = ? AND email = ? AND status = ?', [parsed.userId, parsed.email, 'pending']);
        return true;
    }

    /** After a restart: continue campaigns that were sending. */
    async resumeInterrupted() {
        if (!db.isAvailable()) return { resumed: 0 };
        let running;
        try {
            running = await db.select(CAMPAIGNS, 'id, user_id', 'status = ?', ['running'], 'id', 200, 0);
        } catch (error) {
            const err = migrationError(error);
            if (err.code === 'EMAIL_MIGRATION_PENDING') return { resumed: 0, skipped: 'migration pending' };
            throw err;
        }
        for (const c of running) {
            // An email that was mid-send when the server stopped may or may not
            // have gone out; mark it failed rather than risk sending it twice.
            await db.update(RECIPIENTS, { status: 'failed', error: 'Interrupted by a server restart — it may or may not have been sent' },
                'campaign_id = ? AND status = ?', [c.id, 'sending']);
            this._launch(c.id, c.user_id);
        }
        return { resumed: running.length };
    }

    isRunning(id) { return runners.has(Number(id)); }

    // ─── runner ───────────────────────────────────────────────

    _launch(id, userId) {
        const key = Number(id);
        if (runners.has(key)) return;
        const runner = { cancelled: false, wake: null };
        runners.set(key, runner);
        this._run(key, userId, runner)
            .catch(async error => {
                console.error(`[email-campaign ${key}] runner crashed:`, error.message);
                await db.update(CAMPAIGNS, { status: 'paused', last_error: 'Sending stopped because of an unexpected problem. Press Resume to continue.', updated_at: new Date() },
                    'id = ? AND user_id = ?', [key, userId]).catch(() => {});
            })
            .finally(() => { if (runners.get(key) === runner) runners.delete(key); });
    }

    _cancel(id) {
        const runner = runners.get(Number(id));
        if (runner) {
            runner.cancelled = true;
            if (runner.wake) runner.wake();
            runners.delete(Number(id));
        }
    }

    async _recount(id, userId) {
        const base = 'campaign_id = ? AND user_id = ? AND status = ?';
        const [sent, failed, skipped] = await Promise.all(['sent', 'failed', 'skipped'].map(s => db.count(RECIPIENTS, base, [id, userId, s])));
        await db.update(CAMPAIGNS, { sent, failed, skipped, updated_at: new Date() }, 'id = ? AND user_id = ?', [id, userId]);
        return { sent, failed, skipped };
    }

    async _sentInLastDay(userId) {
        const since = new Date(Date.now() - DAY_MS);
        const count = await db.count(RECIPIENTS, 'user_id = ? AND sent_at >= ?', [userId, since]);
        if (count === 0) return { count, oldest: null };
        const [oldest] = await db.select(RECIPIENTS, 'sent_at', 'user_id = ? AND sent_at >= ?', [userId, since], 'sent_at', 1, 0);
        return { count, oldest: oldest?.sent_at ? new Date(oldest.sent_at) : null };
    }

    async _run(id, userId, runner) {
        let consecutiveFailures = 0;
        while (!runner.cancelled) {
            const campaign = await this.get(id, userId);
            if (!campaign || campaign.status !== 'running') return;
            const settings = normalizeSettings(campaign.settings);
            const baseUrl = (process.env.BACKEND_PUBLIC_URL || campaign.settings?.publicBaseUrl || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

            const [recipient] = await db.select(RECIPIENTS, '*', 'campaign_id = ? AND user_id = ? AND status = ?', [id, userId, 'pending'], 'id', 1, 0);
            if (!recipient) {
                const totals = await this._recount(id, userId);
                await db.update(CAMPAIGNS, { status: totals.failed ? 'completed_with_errors' : 'completed', completed_at: new Date(), last_error: null, updated_at: new Date() },
                    'id = ? AND user_id = ? AND status = ?', [id, userId, 'running']);
                return;
            }

            // Rolling 24-hour limit — wait, then carry on automatically.
            const { count, oldest } = await this._sentInLastDay(userId);
            if (count >= settings.dailyLimit) {
                const resumeAt = oldest ? new Date(oldest.getTime() + DAY_MS + 1000) : new Date(Date.now() + 60 * 60 * 1000);
                const when = resumeAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
                await db.update(CAMPAIGNS, { last_error: `Daily limit of ${settings.dailyLimit} emails reached. Sending continues automatically around ${when}.`, updated_at: new Date() },
                    'id = ? AND user_id = ?', [id, userId]);
                await sleep(Math.min(Math.max(resumeAt - Date.now(), 1000), 10 * 60 * 1000), runner);
                continue;
            }
            if (campaign.last_error) await db.update(CAMPAIGNS, { last_error: null }, 'id = ? AND user_id = ?', [id, userId]);

            const blocked = await db.select(UNSUBSCRIBES, 'id', 'user_id = ? AND email = ?', [userId, recipient.email], '', 1, 0);
            if (blocked.length) {
                await db.update(RECIPIENTS, { status: 'skipped', error: 'This person unsubscribed' }, 'id = ?', [recipient.id]);
                continue;
            }

            await db.update(RECIPIENTS, { status: 'sending', attempts: (recipient.attempts || 0) + 1 }, 'id = ?', [recipient.id]);
            const unsubscribeUrl = baseUrl ? `${baseUrl}/api/public/email/unsubscribe/${unsubscribeToken(userId, recipient.email)}` : null;
            const images = Array.isArray(campaign.settings?.images) ? campaign.settings.images : [];
            const html = wrapHtml(recipient.rendered_body + imagesHtml(images, (_img, i) => `cid:img${i}@campaign`), unsubscribeUrl);
            const headers = unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined;

            try {
                const result = await emailSender.send(userId, { to: recipient.email, subject: recipient.rendered_subject, html, text: htmlToText(html), headers, attachments: inlineAttachments(images) });
                await db.update(RECIPIENTS, { status: 'sent', sent_at: new Date(), message_id: result.messageId, error: null }, 'id = ?', [recipient.id]);
                consecutiveFailures = 0;
            } catch (error) {
                if (error.fatal) {
                    // Account-level problem (login, limit, connection): this email was
                    // not sent — put it back and pause so nothing is lost.
                    await db.update(RECIPIENTS, { status: 'pending' }, 'id = ?', [recipient.id]);
                    await db.update(CAMPAIGNS, { status: 'paused', last_error: error.message, updated_at: new Date() }, 'id = ? AND user_id = ?', [id, userId]);
                    await this._recount(id, userId);
                    return;
                }
                await db.update(RECIPIENTS, { status: 'failed', error: error.message || 'Could not send' }, 'id = ?', [recipient.id]);
                consecutiveFailures += 1;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    await db.update(CAMPAIGNS, { status: 'paused', last_error: `${MAX_CONSECUTIVE_FAILURES} emails in a row failed, so sending was paused to protect your account. Check the failed list, then press Resume.`, updated_at: new Date() },
                        'id = ? AND user_id = ?', [id, userId]);
                    await this._recount(id, userId);
                    return;
                }
            }
            await this._recount(id, userId);
            await sleep(settings.delaySeconds * 1000, runner);
        }
    }
}

module.exports = new EmailCampaignService();
Object.assign(module.exports, {
    _internals: { renderEmail, htmlToText, buildRecipients, parsePasted, unsubscribeToken, readUnsubscribeToken, normalizeSettings, isValidEmail, runners },
});
