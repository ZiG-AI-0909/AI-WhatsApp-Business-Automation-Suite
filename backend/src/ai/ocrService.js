// =============================================================
// NVIDIA OCR service — the single place that knows how to call
// Nemotron OCR for one image.
//
// Extracted from routes/imageExtractor.js so other features
// (BOQ scanned-PDF OCR) reuse the SAME endpoint, response
// parsing, and env-var knobs instead of duplicating them.
//
// Request shape (verified against the live endpoint pattern in
// imageExtractor.js): POST { input: [{ type: 'image_url', url:
// 'data:image/png;base64,...' }] } → { ocr_txts: [...] }.
// =============================================================
const axios = require('axios');

/**
 * OCR one image (PNG/JPEG buffer) with the NVIDIA Nemotron OCR
 * endpoint. Returns the recognized plain text ('' when the page
 * has nothing readable).
 * @param {Buffer} imageBuffer PNG or JPEG bytes.
 * @param {object} [options]
 * @param {string} [options.mimeType] image mime type (default image/png).
 * @param {number} [options.timeoutMs] request timeout (default 60000).
 * @param {string} [options.logLabel] prefix for warnings.
 */
async function ocrImage(imageBuffer, { mimeType = 'image/png', timeoutMs = 60000, logLabel = 'ocr' } = {}) {
    const key = process.env.NVIDIA_API_KEY || process.env.AI_API_KEY;
    if (!key) throw new Error('NVIDIA_API_KEY is not configured on the server.');

    const imageUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
    const requestConfig = {
        headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
    };

    // Same URL derivation as the Image Extractor: NVIDIA_OCR_URL points at
    // the service (local deployments need /infer appended; the hosted one
    // does not).
    const ocrUrl = process.env.NVIDIA_OCR_URL || 'https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v1';
    const ocrEndpoint = process.env.NVIDIA_OCR_ENDPOINT
        || (ocrUrl.includes('localhost') || ocrUrl.includes('127.0.0.1') ? `${ocrUrl}/infer` : ocrUrl);

    const response = await axios.post(ocrEndpoint, {
        input: [{ type: 'image_url', url: imageUrl }],
    }, requestConfig);

    const ocr = response.data || {};
    const ocrTexts = ocr.ocr_txts || ocr.texts || ocr.text || ocr.extracted_text || [];
    const text = Array.isArray(ocrTexts)
        ? ocrTexts.map((item) => typeof item === 'string' ? item : item?.text || item?.parsed_text || '').filter(Boolean).join('\n')
        : String(ocrTexts || '');
    return text;
}

module.exports = { ocrImage };
