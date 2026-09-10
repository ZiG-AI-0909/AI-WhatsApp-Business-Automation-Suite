const express = require('express');
const multer = require('multer');
const axios = require('axios');
const XLSX = require('xlsx');
const db = require('../database/db');
const { respondIfInvalidUpload, validateUploadBuffer } = require('../middleware/fileValidation');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => cb(null, /image\/(jpeg|png|webp)/i.test(file.mimetype)),
});

// Note: Table creation is done via the SQL migration file.
// This fallback ensures the table exists if migration hasn't been run.
async function ensureImageLeadsTable() {
    try {
        // Try to query the table; if it doesn't exist, the migration should have created it
        await db.count('image_leads');
    } catch (error) {
        console.warn('[imageExtractor] image_leads table may not exist. Run supabase-data-migration.sql in Supabase dashboard.');
    }
}

ensureImageLeadsTable();

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

async function markDuplicates(userId) {
  const leads = await db.select('image_leads', '*', 'user_id = ?', [userId], 'id', 10000, 0);
  for (const lead of leads) {
    const phones = parseJson(lead.phone_numbers);
    const emails = parseJson(lead.emails);
    const duplicate = leads.some(other => other.id !== lead.id && (
      (lead.business_name && other.business_name.toLowerCase() === lead.business_name.toLowerCase()) ||
      phones.some(phone => parseJson(other.phone_numbers).includes(phone)) ||
      emails.some(email => parseJson(other.emails).includes(email)) ||
      (lead.website && other.website && other.website.toLowerCase() === lead.website.toLowerCase())
    ));
    await db.update('image_leads', {
      duplicate_status: duplicate ? 'Possible Duplicate' : '',
      updated_at: new Date(),
    }, 'id = ? AND user_id = ?', [lead.id, userId]);
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
    const match = text.match(new RegExp(`\"${key}\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"`));
    if (!match) return '';
    try { return JSON.parse(`\"${match[1]}\"`); } catch { return match[1]; }
  };
  const readArray = (key) => {
    const match = text.match(new RegExp(`\"${key}\"\\s*:\\s*(\\[[\\s\\S]*?\\])`));
    if (!match) return [];
    try { return JSON.parse(match[1].replace(/,\s*]/g, ']')); } catch {
      return match[1].split(',').map(value => value.replace(/[\\[\\]\"']/g, '').trim()).filter(Boolean);
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
    confidence: Number(text.match(/\"confidence\"\\s*:\\s*([0-9.]+)/)?.[1]) || 0,
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

router.get('/stats', async (req, res) => {
  try {
    const total = await db.count('image_leads', 'user_id = ?', [req.user.id]);
    const phones = await db.count('image_leads', "user_id = ? AND phone_numbers != ?", [req.user.id, '[]']);
    const emails = await db.count('image_leads', "user_id = ? AND emails != ?", [req.user.id, '[]']);
    const duplicates = await db.count('image_leads', "user_id = ? AND duplicate_status = ?", [req.user.id, 'Possible Duplicate']);
    
    // Distinct (source_image, extraction_group_id) pairs: SQL aggregate +
    // concat syntax is not valid PostgREST, so fetch the two columns (paged
    // in case of >1000 rows) and count distinct pairs in JS.
    const pairs = [];
    let offset = 0;
    for (;;) {
      const page = await db.select('image_leads', 'source_image, extraction_group_id', 'user_id = ?', [req.user.id], 'id', 1000, offset);
      pairs.push(...page);
      if (page.length < 1000) break;
      offset += 1000;
    }
    const imagesProcessed = new Set(pairs.map((r) => `${r.source_image}:${r.extraction_group_id}`)).size;
    
    res.json({ 
      images_processed: imagesProcessed || total,
      leads_extracted: total, 
      valid_phones: phones, 
      emails_found: emails, 
      possible_duplicates: duplicates 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leads', async (req, res) => {
  try {
    const leads = await db.select('image_leads', '*', 'user_id = ?', [req.user.id], 'id', 10000, 0);
    res.json(leads.map(serializeLead).reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function processFile(file, userId) {
  const extractionGroupId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const result = await extractWithNvidia(file);
    const leads = (result.leads || []).map((lead) => asLead(lead, file.originalname, extractionGroupId));
    const items = leads.length ? leads : [asLead({ raw_text: '', business_name: '', phone_numbers: [], emails: [], social_links: [] }, file.originalname, extractionGroupId)];
    
    const createdLeads = [];
    for (const lead of items) {
      const created = await db.insert('image_leads', {
        source_image: lead.source_image,
        extraction_group_id: lead.extraction_group_id,
        business_name: lead.business_name,
        phone_numbers: JSON.stringify(lead.phone_numbers),
        emails: JSON.stringify(lead.emails),
        website: lead.website,
        address: lead.address,
        city: lead.city,
        state: lead.state,
        country: lead.country,
        postal_code: lead.postal_code,
        business_category: lead.business_category,
        contact_person: lead.contact_person,
        social_links: JSON.stringify(lead.social_links),
        raw_text: lead.raw_text,
        review_status: 'pending_review',
        confidence: lead.confidence,
        processing_status: 'completed',
        updated_at: new Date(),
        user_id: userId,
      });
      createdLeads.push({ ...lead, id: created.id, processing_status: 'completed', review_status: 'pending_review' });
    }
    
    return {
      source_image: file.originalname,
      extraction_group_id: extractionGroupId,
      processing_status: 'completed',
      raw_response: result.rawResponse,
      leads: createdLeads,
    };
  } catch (error) {
    return { source_image: file.originalname, processing_status: 'failed', error: error.response?.data?.detail || error.message };
  }
}

router.post('/process-one', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a JPG, PNG, or WEBP image.' });
  if (!respondIfInvalidUpload(req, res)) return;
  const result = await processFile(req.file, req.user.id);
  await markDuplicates(req.user.id);
  const count = await db.count('image_leads', 'user_id = ?', [req.user.id]);
  res.json({ result, stats: { count } });
});

router.post('/process-batch', upload.array('images', 20), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Upload at least one JPG, PNG, or WEBP image.' });
  for (const file of req.files) {
    const check = validateUploadBuffer(file.buffer, file.originalname);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  const results = await Promise.all(req.files.map(file => processFile(file, req.user.id)));
  await markDuplicates(req.user.id);
  const count = await db.count('image_leads', 'user_id = ?', [req.user.id]);
  res.json({ results, stats: { count } });
});

router.put('/leads/:id', async (req, res) => {
  try {
    const lead = asLead(req.body, req.body.source_image || '', req.body.extraction_group_id || '');
    const updated = await db.update('image_leads', {
      business_name: lead.business_name,
      phone_numbers: JSON.stringify(lead.phone_numbers),
      emails: JSON.stringify(lead.emails),
      website: lead.website,
      address: lead.address,
      city: lead.city,
      state: lead.state,
      country: lead.country,
      postal_code: lead.postal_code,
      business_category: lead.business_category,
      contact_person: lead.contact_person,
      social_links: JSON.stringify(lead.social_links),
      raw_text: lead.raw_text,
      review_status: cleanField(req.body.review_status) || null,
      updated_at: new Date(),
    }, 'id = ? AND user_id = ?', [req.params.id, req.user.id]);
    
    if (!updated || updated.length === 0) return res.status(404).json({ error: 'Lead not found' });
    
    await markDuplicates(req.user.id);
    const freshLead = await db.getById('image_leads', req.params.id, req.user.id);
    res.json(serializeLead(freshLead));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/:id/review', async (req, res) => {
  try {
    const reviewStatus = cleanField(req.body.review_status || req.body.status);
    if (!['confirmed', 'rejected', 'pending_review'].includes(reviewStatus)) {
      return res.status(400).json({ error: 'review_status must be confirmed, rejected, or pending_review.' });
    }
    const updated = await db.update('image_leads', {
      review_status: reviewStatus,
      updated_at: new Date(),
    }, 'id = ? AND user_id = ?', [req.params.id, req.user.id]);
    
    if (!updated || updated.length === 0) return res.status(404).json({ error: 'Lead not found' });
    
    const freshLead = await db.getById('image_leads', req.params.id, req.user.id);
    res.json(serializeLead(freshLead));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/bulk-review', async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : [])
      .map(value => Number(value))
      .filter(Number.isInteger))];
    const reviewStatus = cleanField(req.body.review_status || req.body.status);
    if (!ids.length) return res.status(400).json({ error: 'ids must contain at least one lead ID.' });
    if (!['confirmed', 'rejected'].includes(reviewStatus)) {
      return res.status(400).json({ error: 'review_status must be confirmed or rejected.' });
    }

    let updatedCount = 0;
    for (const id of ids) {
      const result = await db.update('image_leads', {
        review_status: reviewStatus,
        updated_at: new Date(),
      }, 'id = ? AND user_id = ? AND review_status = ?', [id, req.user.id, 'pending_review']);
      if (result && result.length > 0) updatedCount++;
    }

    res.json({ review_status: reviewStatus, requested_ids: ids, updated_count: updatedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/leads/all', async (req, res) => {
  try {
    const deleted = await db.del('image_leads', 'user_id = ?', [req.user.id]);
    res.json({ ok: true, deleted_count: deleted?.length || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/delete-all', async (req, res) => {
  try {
    const deleted = await db.del('image_leads', 'user_id = ?', [req.user.id]);
    res.json({ ok: true, deleted_count: deleted?.length || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/leads/:id', async (req, res) => {
  try {
    const deleted = await db.del('image_leads', 'id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!deleted || deleted.length === 0) return res.status(404).json({ error: 'Lead not found' });
    await markDuplicates(req.user.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/bulk-delete', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    for (const id of ids) {
      await db.del('image_leads', 'id = ? AND user_id = ?', [id, req.user.id]);
    }
    await markDuplicates(req.user.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function exportRows(includeAll = false, userId) {
  // This is now async and returns a promise
  return db.select(
    'image_leads',
    '*',
    includeAll ? 'user_id = ?' : "user_id = ? AND review_status = ?",
    includeAll ? [userId] : [userId, 'confirmed'],
    'id',
    10000,
    0
  ).then(leads => leads.map(lead => ({
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
  })));
}

router.get('/export/csv', async (req, res) => {
  try {
    const isAll = req.query.all === 'true' || req.query.scope === 'all';
    const rows = await exportRows(isAll, req.user.id);
    const data = rows.length ? rows : [{ Message: 'No leads found' }];
    const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(data));
    const filename = isAll ? 'all-leads.csv' : 'lead-image-extractor.csv';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type('text/csv').send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/export/excel', async (req, res) => {
  try {
    const isAll = req.query.all === 'true' || req.query.scope === 'all';
    const rows = await exportRows(isAll, req.user.id);
    const data = rows.length ? rows : [{ Message: 'No leads found' }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data), 'Leads');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const filename = isAll ? 'all-leads.xlsx' : 'lead-image-extractor.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
