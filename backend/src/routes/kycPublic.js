// =============================================================
// Public vendor KYC submission — POST /api/public/kyc
//
// No authentication: outside vendors fill this in. Protected by an IP
// rate limit (kycSubmitLimiter, applied BEFORE the multipart body is
// read), multer size/count limits, magic-byte checks on every file and
// the full server-side validation in kyc/kycSchema.js.
// =============================================================
const express = require('express');
const multer = require('multer');
const { kycSubmitLimiter } = require('../middleware/rateLimiterMiddleware');
const { DOCUMENTS, DOCUMENT_MAX_BYTES, validateSubmission } = require('../kyc/kycSchema');
const { createSubmission } = require('../kyc/kycService');

const router = express.Router();

const parseUploads = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: DOCUMENT_MAX_BYTES,
        files: DOCUMENTS.length,
        fields: 80,
        fieldSize: 16 * 1024,
        parts: 100,
    },
}).fields(DOCUMENTS.map((document) => ({ name: document.key, maxCount: 1 })));

const MULTER_MESSAGES = {
    LIMIT_FILE_SIZE: 'Each file must be 5 MB or smaller.',
    LIMIT_FILE_COUNT: 'Too many files attached.',
    LIMIT_UNEXPECTED_FILE: 'Unexpected file field. Please reload the form and try again.',
    LIMIT_FIELD_VALUE: 'One of the text fields is too long.',
    LIMIT_FIELD_COUNT: 'Too many form fields.',
    LIMIT_PART_COUNT: 'Too many form fields.',
};

router.post('/', kycSubmitLimiter, (req, res) => {
    parseUploads(req, res, async (uploadError) => {
        if (uploadError) {
            const field = uploadError.field && DOCUMENTS.some((document) => document.key === uploadError.field) ? uploadError.field : null;
            const message = MULTER_MESSAGES[uploadError.code] || 'The upload could not be read. Please try again.';
            return res.status(400).json({ error: message, fields: field ? { [field]: message } : {} });
        }
        try {
            const files = Object.fromEntries(DOCUMENTS
                .map((document) => [document.key, req.files?.[document.key]?.[0]])
                .filter(([, file]) => file));
            const { values, documents, errors } = validateSubmission(req.body || {}, files);
            if (Object.keys(errors).length) {
                return res.status(400).json({ error: 'Please correct the highlighted fields and submit again.', fields: errors });
            }
            const result = await createSubmission({
                values,
                documents,
                meta: { ip: req.ip, userAgent: req.get('user-agent') },
            });
            console.log(`[kyc] submission ${result.reference} received`);
            return res.status(201).json({ ok: true, ...result });
        } catch (error) {
            return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Your form could not be submitted. Please try again.' });
        }
    });
});

module.exports = router;
