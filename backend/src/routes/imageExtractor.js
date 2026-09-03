const express = require('express');
const multer = require('multer');
const axios = require('axios');
const XLSX = require('xlsx');
const db = require('../database/db');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => cb(null, /image\/(jpeg|png|webp)/i.test(file.mimetype)),
});

db.exec(`
  CREATE TABLE IF NOT EXISTS image_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_image TEXT DEFAULT '',
    extraction_group_id TEXT DEFAULT '',
    business_name TEXT DEFAULT '',
    phone_numbers TEXT DEFAULT '[]',
    emails TEXT DEFAULT '[]',
    website TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    country TEXT DEFAULT '',
    postal_code TEXT DEFAULT '',
    business_category TEXT DEFAULT '',
    contact_person TEXT DEFAULT '',
    social_links TEXT DEFAULT '[]',
    raw_text TEXT DEFAULT '',
    duplicate_status TEXT DEFAULT '',
    review_status TEXT DEFAULT 'pending_review',
    confidence REAL DEFAULT 0,
    processing_status TEXT DEFAULT 'completed',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

for (const column of [
  'extraction_group_id TEXT DEFAULT \'\'',
  'review_status TEXT DEFAULT \'pending_review\'',
]) {
  try { db.exec(`ALTER TABLE image_leads ADD COLUMN ${column}`); } catch (error) {
    if (!error.message.includes('duplicate column')) throw error;
  }
}

function parseJson(value, fallback = []) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function cleanField(value) {
  const normalized = String(value || '').trim().replace(/[.,;:!?]+\s*$/, '').trim();
  return /^(not available|n\/a|na|none|null)$/i.test(normalized) ? '' : normalized;
}

function compactUnique(values) {
  return [...new Set((Array.isArray(values) ? values : [values]).map(cleanField).filter(Boolean))];
}

function readArrayLead(lead, field) {
  return compactUnique(Array.isArray(lead[field]) ? lead[field] : lead[field] ? [lead[field]] : []);
}

function cleanContactArray(values) {
  return compactUnique(values).filter((value) => !/^(not available|n\/a|na|none|null)$/i.test(value));
}

function asLead(value, sourceImage, extractionGroupId = '') {
  const lead = value && typeof value === 'object' ? value : {};
  const address = cleanField(lead.address);
  const postalCode = cleanField(lead.postal_code) || address.match(/\b\d{5,6}\b/)?.[0] || '';
  const rawText = String(lead.raw_text || lead.extracted_text || '');
  return {
    source_image: sourceImage,
    extraction_group_id: extractionGroupId,
    business_name: cleanField(lead.business_name),
    phone_numbers: cleanContactArray(readArrayLead(lead, 'phone_numbers')),
    emails: cleanContactArray(readArrayLead(lead, 'emails')),
    website: cleanField(lead.website),
    address,
    city: cleanField(lead.city),
    state: cleanField(lead.state),
    country: cleanField(lead.country),
    postal_code: postalCode,
    business_category: cleanField(lead.business_category),
    contact_person: cleanField(lead.contact_person),
    social_links: cleanContactArray(readArrayLead(lead, 'social_links')),
    raw_text: rawText,
    confidence: Number(lead.confidence) || 0,
    review_status: cleanField(lead.review_status) || 'pending_review',
  };
}

function markDuplicates() {
  const leads = db.prepare('SELECT * FROM image_leads ORDER BY id').all();
  const update = db.prepare("UPDATE image_leads SET duplicate_status = ?, updated_at = datetime('now') WHERE id = ?");
  for (const lead of leads) {
    const phones = parseJson(lead.phone_numbers);
    const emails = parseJson(lead.emails);
    const duplicate = leads.some(other => other.id !== lead.id && (
      (lead.business_name && other.business_name.toLowerCase() === lead.business_name.toLowerCase()) ||
      phones.some(phone => parseJson(other.phone_numbers).includes(phone)) ||
      emails.some(email => parseJson(other.emails).includes(email)) ||
      (lead.website && other.website && other.website.toLowerCase() === lead.website.toLowerCase())
    ));
    update.run(duplicate ? 'Possible Duplicate' : '', lead.id);
  }
}

function normalizeResponse(content) {
  const normalizedContent = Array.isArray(content)
    ? content.map(part => typeof part === 'string' ? part : part?.text || '').join('')
    : content?.text || content;
  const fenced = String(normalizedContent || '').match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || normalizedContent;
  const text = String(fenced || '').trim();

  const parseJsonBlock = (input) => {
    try { return JSON.parse(input); } catch { return null; }
  };

  const parsed = parseJsonBlock(text);
  if (parsed !== null) return parsed;

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const arrayText = text.slice(start, end + 1);
    const arrayParsed = parseJsonBlock(arrayText);
    if (arrayParsed !== null) return arrayParsed;
  }

  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    const objectText = text.slice(objectStart, objectEnd + 1);
    const objectParsed = parseJsonBlock(objectText);
    if (objectParsed !== null) return objectParsed;
    return recoverLeadObject(objectText);
  }

  throw new Error('The vision model did not return structured lead data.');
}

function recoverLeadObject(text) {
  const readString = (key) => {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (!match) return '';
    try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
  };
  const readArray = (key) => {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*(\\[[\\s\\S]*?\\])`));
    if (!match) return [];
    try { return JSON.parse(match[1].replace(/,\\s*]/g, ']')); } catch {
      return match[1].split(',').map(value => value.replace(/[\\[\\]"']/g, '').trim()).filter(Boolean);
    }
  };
  return {
    business_name: readString('business_name'),
    phone_numbers: readArray('phone_numbers'),
    emails: readArray('emails'),
    website: readString('website'),
    address: readString('address'),
    city: readString('city'),
    state: readString('state'),
    country: readString('country'),
    postal_code: readString('postal_code'),
    business_category: readString('business_category'),
    contact_person: readString('contact_person'),
    social_links: readArray('social_links'),
    raw_text: readString('raw_text'),
    confidence: Number(text.match(/"confidence"\\s*:\\s*([0-9.]+)/)?.[1]) || 0,
  };
}

function normalizeLeadList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

function coerceLeadArray(value) {
  return normalizeLeadList(value)
    .map((entry) => {
      const lead = entry && typeof entry === 'object' ? entry : {};
      return {
        ...lead,
        raw_text: String(lead.raw_text || lead.extracted_text || ''),
      };
    })
    .filter((lead) => {
      const hasName = cleanField(lead.business_name);
      const hasContact = cleanContactArray([...(lead.phone_numbers || []), ...(lead.emails || []), lead.website]).length > 0;
      const hasRawText = String(lead.raw_text || '').trim().length > 0;
      return hasName || hasContact || hasRawText;
    });
}

function enrichFromText(lead, text) {
  const source = String(text || '');
  if (!source.trim()) return lead;
  const phones = source.match(/(?:\+?\d[\d\s().-]{6,}\d)/g) || [];
  const emails = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const websites = source.match(/(?:https?:\/\/|www\.)[^\s,<>]+/gi) || [];
  return {
    ...lead,
    phone_numbers: [...new Set([...(lead.phone_numbers || []), ...phones.map(value => value.trim())])],
    emails: [...new Set([...(lead.emails || []), ...emails.map(value => value.trim())])],
    website: lead.website || websites[0] || '',
    raw_text: lead.raw_text || source,
  };
}

async function extractWithNvidia(file) {
  const key = process.env.NVIDIA_API_KEY || process.env.AI_API_KEY;
  if (!key) throw new Error('NVIDIA_API_KEY is not configured on the server.');
  const baseURL = process.env.NVIDIA_BASE_URL || process.env.AI_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const model = process.env.NVIDIA_STRUCTURED_MODEL || 'meta/llama-3.2-11b-vision-instruct';
  const imageUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
  const requestConfig = { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 90000 };

  const ocrUrl = process.env.NVIDIA_OCR_URL || 'https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v1';
  const ocrEndpoint = process.env.NVIDIA_OCR_ENDPOINT || (ocrUrl.includes('localhost') || ocrUrl.includes('127.0.0.1') ? `${ocrUrl}/infer` : ocrUrl);
  let rawText = '';
  try {
    const ocrResponse = await axios.post(ocrEndpoint, {
      input: [{ type: 'image_url', url: imageUrl }],
    }, requestConfig);
    const ocr = ocrResponse.data || {};
    const ocrTexts = ocr.ocr_txts || ocr.texts || ocr.text || ocr.extracted_text || [];
    rawText = Array.isArray(ocrTexts)
      ? ocrTexts.map(item => typeof item === 'string' ? item : item?.text || item?.parsed_text || '').filter(Boolean).join('\n')
      : String(ocrTexts || '');
  } catch (error) {
    console.warn(`Nemotron OCR unavailable: ${error.response?.status || error.message}`);
  }

  const prompt = `You are extracting business leads from an image. Return JSON only.
- If the image shows multiple distinct businesses/entities, return an ARRAY of lead objects.
- If it shows one business/entity, you may return a single lead object for backward compatibility.
- Only include an entity if a business name or a contact method is clearly visible.
- Do not infer additional businesses that are not explicitly visible.
- Do not merge unrelated businesses into one object.
- If a block is raw or unstructured text and you cannot confidently identify a business_name, keep business_name empty/null and still preserve any raw_text, phone numbers, emails, websites, or addresses you can read.
- Preserve every readable word in raw_text for each lead.
- Never invent missing values.

Return each lead using this exact shape:
{"business_name":"","phone_numbers":[],"emails":[],"website":"","address":"","city":"","state":"","country":"","postal_code":"","business_category":"","contact_person":"","social_links":[],"raw_text":"","confidence":0}

OCR transcription:
${rawText}`;
  const payload = {
    model,
    stream: false,
    response_format: { type: 'json_object' },
    frequency_penalty: 0,
    presence_penalty: 0,
    temperature: 0.1,
    max_tokens: 1600,
    top_p: 1,
    messages: [{ role: 'user', content: rawText.trim()
      ? prompt
      : [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }] }],
  };
  const response = await axios.post(`${baseURL}/chat/completions`, payload, requestConfig);
  try {
    const normalized = normalizeResponse(response.data?.choices?.[0]?.message?.content);
    return { leads: coerceLeadArray(normalized).map((lead) => enrichFromText(lead, rawText)), rawResponse: response.data?.choices?.[0]?.message?.content };
  } catch {
    payload.response_format = undefined;
    payload.messages[0].content = [{ type: 'text', text: 'Extract all visible business leads. Return JSON only. Output either one lead object or an array of lead objects using the exact keys: business_name, phone_numbers, emails, website, address, city, state, country, postal_code, business_category, contact_person, social_links, raw_text, confidence.' }];
    if (!rawText.trim()) payload.messages[0].content.push({ type: 'image_url', image_url: { url: imageUrl } });
    const retry = await axios.post(`${baseURL}/chat/completions`, payload, requestConfig);
    const normalized = normalizeResponse(retry.data?.choices?.[0]?.message?.content);
    return { leads: coerceLeadArray(normalized).map((lead) => enrichFromText(lead, rawText)), rawResponse: retry.data?.choices?.[0]?.message?.content };
  }
}

function serializeLead(lead) {
  return {
    ...lead,
    phone_numbers: parseJson(lead.phone_numbers),
    emails: parseJson(lead.emails),
    social_links: parseJson(lead.social_links),
  };
}

router.get('/stats', (_req, res) => {
  const total = db.prepare('SELECT COUNT(*) count FROM image_leads').get().count;
  const phones = db.prepare("SELECT COUNT(*) count FROM image_leads WHERE phone_numbers != '[]'").get().count;
  const emails = db.prepare("SELECT COUNT(*) count FROM image_leads WHERE emails != '[]'").get().count;
  const duplicates = db.prepare("SELECT COUNT(*) count FROM image_leads WHERE duplicate_status = 'Possible Duplicate'").get().count;
  res.json({ images_processed: db.prepare('SELECT COUNT(DISTINCT source_image || ":" || extraction_group_id) count FROM image_leads').get().count, leads_extracted: total, valid_phones: phones, emails_found: emails, possible_duplicates: duplicates });
});

router.get('/leads', (_req, res) => res.json(db.prepare('SELECT * FROM image_leads ORDER BY id DESC').all().map(serializeLead)));

async function processFile(file) {
  const extractionGroupId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const result = await extractWithNvidia(file);
    const leads = (result.leads || []).map((lead) => asLead(lead, file.originalname, extractionGroupId));
    const insert = db.prepare(`INSERT INTO image_leads
      (source_image, extraction_group_id, business_name, phone_numbers, emails, website, address, city, state, country, postal_code, business_category, contact_person, social_links, raw_text, review_status, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const items = leads.length ? leads : [asLead({ raw_text: '', business_name: '', phone_numbers: [], emails: [], social_links: [] }, file.originalname, extractionGroupId)];
    db.exec('BEGIN');
    const rows = [];
    try {
      for (const lead of items) {
        const row = insert.run(
          lead.source_image,
          lead.extraction_group_id,
          lead.business_name,
          JSON.stringify(lead.phone_numbers),
          JSON.stringify(lead.emails),
          lead.website,
          lead.address,
          lead.city,
          lead.state,
          lead.country,
          lead.postal_code,
          lead.business_category,
          lead.contact_person,
          JSON.stringify(lead.social_links),
          lead.raw_text,
          'pending_review',
          lead.confidence,
        );
        rows.push({ ...lead, id: Number(row.lastInsertRowid), processing_status: 'completed', review_status: 'pending_review' });
      }
      db.exec('COMMIT');
    } catch (transactionError) {
      try { db.exec('ROLLBACK'); } catch {}
      throw transactionError;
    }
    return {
      source_image: file.originalname,
      extraction_group_id: extractionGroupId,
      processing_status: 'completed',
      raw_response: result.rawResponse,
      leads: rows,
    };
  } catch (error) {
    return { source_image: file.originalname, processing_status: 'failed', error: error.response?.data?.detail || error.message };
  }
}

router.post('/process-one', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a JPG, PNG, or WEBP image.' });
  const result = await processFile(req.file);
  markDuplicates();
  res.json({ result, stats: db.prepare('SELECT COUNT(*) count FROM image_leads').get() });
});

router.post('/process-batch', upload.array('images', 20), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Upload at least one JPG, PNG, or WEBP image.' });
  const results = await Promise.all(req.files.map(processFile));
  markDuplicates();
  res.json({ results, stats: db.prepare('SELECT COUNT(*) count FROM image_leads').get() });
});

router.put('/leads/:id', (req, res) => {
  const lead = asLead(req.body, req.body.source_image || '', req.body.extraction_group_id || '');
  const result = db.prepare(`UPDATE image_leads SET business_name=?, phone_numbers=?, emails=?, website=?, address=?, city=?, state=?, country=?, postal_code=?, business_category=?, contact_person=?, social_links=?, raw_text=?, review_status=COALESCE(?, review_status), updated_at=datetime('now') WHERE id=?`)
    .run(lead.business_name, JSON.stringify(lead.phone_numbers), JSON.stringify(lead.emails), lead.website, lead.address, lead.city, lead.state, lead.country, lead.postal_code, lead.business_category, lead.contact_person, JSON.stringify(lead.social_links), lead.raw_text, cleanField(req.body.review_status) || null, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Lead not found' });
  markDuplicates();
  res.json(serializeLead(db.prepare('SELECT * FROM image_leads WHERE id=?').get(req.params.id)));
});

router.post('/leads/:id/review', (req, res) => {
  const reviewStatus = cleanField(req.body.review_status || req.body.status);
  if (!['confirmed', 'rejected', 'pending_review'].includes(reviewStatus)) {
    return res.status(400).json({ error: 'review_status must be confirmed, rejected, or pending_review.' });
  }
  const result = db.prepare(`UPDATE image_leads SET review_status=?, updated_at=datetime('now') WHERE id=?`).run(reviewStatus, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Lead not found' });
  res.json(serializeLead(db.prepare('SELECT * FROM image_leads WHERE id=?').get(req.params.id)));
});

router.delete('/leads/:id', (req, res) => {
  const result = db.prepare('DELETE FROM image_leads WHERE id=?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Lead not found' });
  markDuplicates();
  res.json({ ok: true });
});

router.post('/leads/bulk-delete', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const remove = db.prepare('DELETE FROM image_leads WHERE id=?');
  for (const id of ids) remove.run(id);
  markDuplicates();
  res.json({ ok: true });
});

function exportRows() {
  return db.prepare("SELECT * FROM image_leads WHERE review_status = 'confirmed' ORDER BY id DESC").all().map(lead => ({
    'Business Name': lead.business_name,
    'Phone Number': parseJson(lead.phone_numbers).join(', '),
    'Email': parseJson(lead.emails).join(', '),
    Website: lead.website,
    Address: lead.address,
    City: lead.city,
    State: lead.state,
    Country: lead.country,
    'Postal Code': lead.postal_code,
    Category: lead.business_category,
    'Contact Person': lead.contact_person,
    'Social Links': parseJson(lead.social_links).join(', '),
    'Extracted Text': lead.raw_text,
    'Source Image': lead.source_image,
    Confidence: lead.confidence,
    'Review Status': lead.review_status,
  }));
}

router.get('/export/csv', (_req, res) => {
  const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(exportRows()));
  res.setHeader('Content-Disposition', 'attachment; filename="lead-image-extractor.csv"');
  res.type('text/csv').send(csv);
});

router.get('/export/excel', (_req, res) => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportRows()), 'Leads');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="lead-image-extractor.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
});

module.exports = router;
