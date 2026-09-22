// =============================================================
// NVIDIA OCR service — the single place that knows how to call
// Nemotron OCR for one image.
//
// Extracted from routes/imageExtractor.js so other features
// (BOQ scanned-PDF OCR) reuse the SAME endpoint, response
// parsing, and env-var knobs instead of duplicating them.
//
// Request shape: POST { input: [{ type: 'image_url', url:
// 'data:image/png;base64,...' }] }.
// RESPONSE SHAPE (verified 2026-09 against the live hosted endpoint AND
// docs.nvidia.com NIM Image OCR reference): the recognized text lives at
//   data[].text_detections[].text_prediction.text
// — NOT at a top-level "ocr_txts" field. The original parser read
// ocr_txts, found nothing, and silently returned '' for a fully
// successful OCR response: every page logged "ok (0 chars)" with no
// error while NVIDIA had in fact read the scan perfectly. Legacy
// ocr_txts/texts fields are still accepted as fallbacks.
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

    let response;
    try {
        response = await axios.post(ocrEndpoint, {
            input: [{ type: 'image_url', url: imageUrl }],
        }, requestConfig);
    } catch (error) {
        // TEMP DIAGNOSTIC (remove after live verify): surface the provider's
        // error body for non-2xx responses (rate limits, auth, payload
        // rejections) instead of just axios's status-code message.
        if (process.env.BOQ_OCR_DIAG_DUMP === '1') {
            console.warn(`[ocr-diag:${logLabel}] HTTP ${error.response?.status ?? 'no response'} error — RAW body (first 2000 chars): ${String(JSON.stringify(error.response?.data ?? null)).slice(0, 2000)}`);
        }
        throw error;
    }

    const ocr = response.data || {};

    // TEMP DIAGNOSTIC (live-verify 2026-09, remove after the real-upload
    // check): HTTP status + the RAW response's top-level keys for every
    // call. logLabel carries the page number on the BOQ path, so this line
    // pairs with pdfOcr's "[boq:…] OCR page N/M ok … (X chars)" line.
    console.log(`[ocr-diag:${logLabel}] HTTP ${response.status} | raw response top-level keys: ${Object.keys(ocr).join(', ') || '(none)'}`);

    // Canonical hosted-endpoint schema: one entry per input image, each
    // with text_detections[].text_prediction.text. Detections arrive
    // roughly in reading order but that is not contractual — sort by
    // bounding box (top edge, then left edge) so table pages (BOQ rows,
    // columns) always join in visual reading order.
    const dataEntries = Array.isArray(ocr.data) ? ocr.data : [];
    let text = '';
    if (dataEntries.length) {
        const lines = [];
        for (const entry of dataEntries) {
            const detections = Array.isArray(entry?.text_detections) ? entry.text_detections : [];
            for (const det of detections) {
                const points = det?.bounding_box?.points;
                det.__top = Array.isArray(points) && points.length
                    ? Math.min(...points.map((p) => Number(p?.y ?? 0)))
                    : 0;
                det.__left = Array.isArray(points) && points.length
                    ? Math.min(...points.map((p) => Number(p?.x ?? 0)))
                    : 0;
            }
            detections.sort((a, b) => (a.__top - b.__top) || (a.__left - b.__left));
            for (const det of detections) {
                const line = det?.text_prediction?.text;
                if (typeof line === 'string' && line.trim()) lines.push(line.trim());
            }
        }
        text = lines.join('\n');
        if (!text.trim()) {
            console.warn(`[ocr:${logLabel}] NVIDIA response had text_detections for ${dataEntries.length} image(s) but every detection was empty`);
        }
    } else {
        // Legacy/experimental response shapes (older NIM builds):
        const ocrTexts = ocr.ocr_txts || ocr.texts || ocr.text || ocr.extracted_text;
        if (ocrTexts !== undefined) {
            text = Array.isArray(ocrTexts)
                ? ocrTexts.map((item) => typeof item === 'string' ? item : item?.text || item?.parsed_text || '').filter(Boolean).join('\n')
                : String(ocrTexts || '');
        } else {
            // The exact failure mode that silently zeroed OCR output for
            // weeks: a successful HTTP response whose shape we do not
            // recognize must NEVER parse to a quiet ''. Say so, loudly.
            console.warn(`[ocr:${logLabel}] unrecognized NVIDIA OCR response shape — top-level keys: ${Object.keys(ocr).join(', ') || '(none)'}`);
        }
    }
    // TEMP DIAGNOSTIC (remove after live verify): a 200 response that
    // parses to 0 chars must be diagnosable from Render logs alone —
    // dump the raw body (first 2000 chars) when BOQ_OCR_DIAG_DUMP=1.
    if (!text.trim() && process.env.BOQ_OCR_DIAG_DUMP === '1') {
        console.warn(`[ocr-diag:${logLabel}] parsed 0 chars — RAW response body (first 2000 chars): ${String(JSON.stringify(ocr)).slice(0, 2000)}`);
    }
    return text;
}

module.exports = { ocrImage };
