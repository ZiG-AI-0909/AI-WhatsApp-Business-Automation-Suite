const express = require('express');
const multer = require('multer');
const axios = require('axios');
const db = require('../database/db');
const { respondIfInvalidUpload } = require('../middleware/fileValidation');

const router = express.Router();

// Same image constraints as lead extraction (shared upload pattern).
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, /image\/(jpeg|png|webp)/i.test(file.mimetype)),
});

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// Suggestion payload shape — every field is an AI suggestion for manual
// verification, never a certain fact.
const SUGGESTION_KEYS = ['product_category', 'size', 'specification', 'markings', 'condition_notes', 'confidence'];

function cleanSuggestion(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const cleaned = {};
    for (const key of SUGGESTION_KEYS) {
        if (key === 'confidence') {
            cleaned[key] = Math.max(0, Math.min(1, Number(source.confidence) || 0));
        } else if (key === 'markings') {
            // Array field: keep readable strings only (model may return a
            // single string — wrap it).
            const value = source.markings;
            cleaned[key] = Array.isArray(value)
                ? value.map((v) => String(v ?? '').trim()).filter(Boolean)
                : (String(value ?? '').trim() ? [String(value).trim()] : []);
        } else {
            cleaned[key] = String(source[key] ?? '').trim();
        }
    }
    return cleaned;
}

function normalizeResponse(content) {
    const text = String(content || '');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
    const attempt = (input) => {
        try { return JSON.parse(input); } catch { return null; }
    };
    let parsed = attempt(String(fenced).trim());
    if (parsed === null) {
        const start = fenced.indexOf('{');
        const end = fenced.lastIndexOf('}');
        if (start >= 0 && end > start) parsed = attempt(fenced.slice(start, end + 1));
    }
    if (parsed === null) throw new Error('The vision model did not return a structured identification. Try another photo.');
    return cleanSuggestion(parsed);
}

/**
 * Vision identification using the SAME NVIDIA vision service as lead
 * extraction (same key/base URL/model env chain), with a different
 * extraction prompt/schema for product photos.
 */
async function identifyWithNvidia(file) {
    const key = process.env.NVIDIA_API_KEY || process.env.AI_API_KEY;
    if (!key) throw new Error('NVIDIA_API_KEY is not configured on the server.');
    const baseURL = process.env.NVIDIA_BASE_URL || process.env.AI_BASE_URL || 'https://integrate.api.nvidia.com/v1';
    const model = process.env.NVIDIA_STRUCTURED_MODEL || 'meta/llama-3.2-11b-vision-instruct';
    const imageUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;

    const prompt = `You are helping a pipe company's sales team identify a product from a photo. This is a SUGGESTION for manual verification, not a certain fact — never state certainty.

Look at the photo and return ONLY valid JSON:
{"product_category":"","size":"","specification":"","markings":[],"condition_notes":"","confidence":0}

Rules:
- product_category: your best-guess category (e.g. "HDPE pipe", "uPVC pipe", "pipe fitting", "valve"). Say "unknown" if unclear.
- size: any readable diameter/size (e.g. "110mm", "6 inch", "DN200") ONLY if printed on or measurable from the product; otherwise empty.
- specification: any readable standard/class marking (e.g. "PE100 PN10", "IS 4985"); otherwise empty.
- markings: every readable text/mark you can see on the product (brand, standard, batch, color codes). Empty array if none readable.
- condition_notes: brief factual note on what the photo shows (color, visible joints, surface). No speculation about age or quality.
- confidence: 0 to 1, how confident the category guess is.
- Never invent markings that are not visible. If the photo is too unclear, say so in condition_notes and set confidence low.`;

    const response = await axios.post(
        `${baseURL}/chat/completions`,
        {
            model,
            stream: false,
            response_format: { type: 'json_object' },
            temperature: 0.1,
            max_tokens: 800,
            top_p: 1,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: imageUrl } },
                ],
            }],
        },
        {
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            timeout: 90000,
        }
    );
    return normalizeResponse(response.data?.choices?.[0]?.message?.content);
}

// POST /api/image-extractor/identify — analyze one product photo.
router.post('/identify', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Upload a JPG, PNG, or WEBP image of the product.' });
    if (!respondIfInvalidUpload(req, res)) return;
    try {
        const suggestion = await identifyWithNvidia(req.file);
        const created = await db.insert('product_identifications', {
            source_image: req.file.originalname,
            product_category: suggestion.product_category,
            size: suggestion.size,
            specification: suggestion.specification,
            markings: JSON.stringify(suggestion.markings || []),
            condition_notes: suggestion.condition_notes,
            confidence: suggestion.confidence,
            review_status: 'pending_review',
            user_id: req.user.id,
        });
        res.status(201).json(serialize(created));
    } catch (error) {
        console.error('[identify] failed:', error.response?.data?.detail || error.message);
        res.status(500).json({ error: error.response?.data?.detail || error.message });
    }
});

function parseMarkings(value) {
    if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
    const text = String(value || '').trim();
    return text ? [text] : [];
}

// GET /api/image-extractor/identifications — this user's past suggestions.
router.get('/identifications', async (req, res) => {
    try {
        const rows = await db.select(
            'product_identifications',
            '*',
            'user_id = ?',
            [req.user.id],
            'id',
            1000,
            0
        );
        res.json(rows.reverse().map(serialize));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/image-extractor/identifications/:id/review — confirm/reject.
router.post('/identifications/:id/review', async (req, res) => {
    const reviewStatus = String(req.body?.review_status || '').trim();
    if (!['confirmed', 'rejected', 'pending_review'].includes(reviewStatus)) {
        return res.status(400).json({ error: 'review_status must be confirmed, rejected, or pending_review.' });
    }
    try {
        const updated = await db.update('product_identifications', {
            review_status: reviewStatus,
            updated_at: new Date(),
        }, 'id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!updated || updated.length === 0) return res.status(404).json({ error: 'Identification not found.' });
        res.json(serialize(await db.getById('product_identifications', req.params.id, req.user.id)));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// DELETE /api/image-extractor/identifications/:id
router.delete('/identifications/:id', async (req, res) => {
    try {
        const deleted = await db.del('product_identifications', 'id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!deleted || deleted.length === 0) return res.status(404).json({ error: 'Identification not found.' });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

function serialize(row) {
    return { ...row, markings: parseJsonArray(row.markings) };
}

module.exports = { router, cleanSuggestion, normalizeResponse, identifyWithNvidia };
