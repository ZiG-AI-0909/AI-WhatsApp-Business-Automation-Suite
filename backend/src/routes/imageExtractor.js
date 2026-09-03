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
    confidence REAL DEFAULT 0,
    processing_status TEXT DEFAULT 'completed',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

function parseJson(value, fallback = []) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function cleanField(value) {
  return String(value || '').trim().replace(/[.,;:!?]+\s*$/, '').trim();
}

function asLead(value, sourceImage) {
  const lead = value && typeof value === 'object' ? value : {};
  const array = (field) => {
    const values = Array.isArray(lead[field]) ? lead[field] : lead[field] ? [lead[field]] : [];
    return [...new Set(values.map(cleanField).filter(Boolean))];
  };
  const address = cleanField(lead.address);
  const postalCode = cleanField(lead.postal_code) || address.match(/\b\d{5,6}\b/)?.[0] || '';
  const rawText = String(lead.raw_text || lead.extracted_text || '');
  const contactPerson = cleanField(lead.contact_person) || rawText.match(/\b(?:call|contact|attn\.?)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\b/i)?.[1] || '';
  return {
    source_image: sourceImage,
    business_name: cleanField(lead.business_name),
    phone_numbers: array('phone_numbers'),
    emails: array('emails'),
    website: cleanField(lead.website),
    address,
    city: cleanField(lead.city),
    state: cleanField(lead.state),
    country: cleanField(lead.country),
    postal_code: postalCode,
    business_category: cleanField(lead.business_category),
    contact_person: contactPerson,
    social_links: array('social_links'),
    raw_text: rawText,
    confidence: Number(lead.confidence) || 0,
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
  try { return JSON.parse(text); } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { return recoverLeadObject(text.slice(start, end + 1)); }
    }
    throw new Error('The vision model did not return structured lead data.');
  }
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
  const lead = {
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
  if (!lead.business_name && !lead.raw_text && !lead.phone_numbers.length && !lead.emails.length) throw new Error('The vision model returned malformed lead data.');
  return lead;
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

  const prompt = `Convert this OCR transcription into lead data. Preserve every readable word in raw_text, including text that does not fit a field. Extract all visible phone numbers, email addresses, websites, names, addresses, ratings, labels, codes, and opening hours. Never invent or infer missing values. Your entire response MUST be one valid JSON object and nothing else. Always return this exact shape: {"business_name":"","phone_numbers":[],"emails":[],"website":"","address":"","city":"","state":"","country":"","postal_code":"","business_category":"","contact_person":"","social_links":[],"raw_text":"","confidence":0}. Use empty values only when unavailable. confidence must be a number from 0 to 1.\n\nOCR transcription:\n${rawText}`;
  const payload = {
    model,
    stream: false,
    response_format: { type: 'json_object' },
    frequency_penalty: 0,
    presence_penalty: 0,
    temperature: 0.1,
    max_tokens: 1200,
    top_p: 1,
    messages: [{ role: 'user', content: rawText.trim()
      ? prompt
      : [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }] }],
  };
  const response = await axios.post(`${baseURL}/chat/completions`, payload, requestConfig);
  try {
    return enrichFromText(normalizeResponse(response.data?.choices?.[0]?.message?.content), rawText);
  } catch {
    payload.response_format = undefined;
    payload.messages[0].content = [{ type: 'text', text: 'Read every visible word and value in this image. Reply with ONLY one JSON object, no markdown and no explanation. Use exactly these keys: business_name, phone_numbers, emails, website, address, city, state, country, postal_code, business_category, contact_person, social_links, raw_text, confidence. Put the complete readable transcription in raw_text and use empty values only when unavailable.' }];
    if (!rawText.trim()) payload.messages[0].content.push({ type: 'image_url', image_url: { url: imageUrl } });
    const retry = await axios.post(`${baseURL}/chat/completions`, payload, requestConfig);
    return enrichFromText(normalizeResponse(retry.data?.choices?.[0]?.message?.content), rawText);
  }
}

function serializeLead(lead) {
  return { ...lead, phone_numbers: parseJson(lead.phone_numbers), emails: parseJson(lead.emails), social_links: parseJson(lead.social_links) };
}

router.get('/stats', (_req, res) => {
  const total = db.prepare('SELECT COUNT(*) count FROM image_leads').get().count;
  const phones = db.prepare("SELECT COUNT(*) count FROM image_leads WHERE phone_numbers != '[]'").get().count;
  const emails = db.prepare("SELECT COUNT(*) count FROM image_leads WHERE emails != '[]'").get().count;
  const duplicates = db.prepare("SELECT COUNT(*) count FROM image_leads WHERE duplicate_status = 'Possible Duplicate'").get().count;
  res.json({ images_processed: total, leads_extracted: total, valid_phones: phones, emails_found: emails, possible_duplicates: duplicates });
});

router.get('/leads', (_req, res) => res.json(db.prepare('SELECT * FROM image_leads ORDER BY id DESC').all().map(serializeLead)));

async function processFile(file) {
  try {
    const lead = asLead(await extractWithNvidia(file), file.originalname);
    const result = db.prepare(`INSERT INTO image_leads
      (source_image, business_name, phone_numbers, emails, website, address, city, state, country, postal_code, business_category, contact_person, social_links, raw_text, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(lead.source_image, lead.business_name, JSON.stringify(lead.phone_numbers), JSON.stringify(lead.emails), lead.website, lead.address, lead.city, lead.state, lead.country, lead.postal_code, lead.business_category, lead.contact_person, JSON.stringify(lead.social_links), lead.raw_text, lead.confidence);
    return { ...lead, id: Number(result.lastInsertRowid), processing_status: 'completed' };
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
  const lead = asLead(req.body, req.body.source_image || '');
  const result = db.prepare(`UPDATE image_leads SET business_name=?, phone_numbers=?, emails=?, website=?, address=?, city=?, state=?, country=?, postal_code=?, business_category=?, contact_person=?, social_links=?, raw_text=?, updated_at=datetime('now') WHERE id=?`)
    .run(lead.business_name, JSON.stringify(lead.phone_numbers), JSON.stringify(lead.emails), lead.website, lead.address, lead.city, lead.state, lead.country, lead.postal_code, lead.business_category, lead.contact_person, JSON.stringify(lead.social_links), lead.raw_text, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Lead not found' });
  markDuplicates();
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
  return db.prepare('SELECT * FROM image_leads ORDER BY id DESC').all().map(lead => ({
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
