// =============================================================
// Public mechanic / technician registration — POST /api/public/technician
//
// No authentication. Same protections as the vendor KYC form
// (routes/kycPublic.js): IP rate limit before the body is read, multer
// size/count limits, magic-byte checks and full server-side validation.
// =============================================================
const express = require('express');
const multer = require('multer');
const { technicianSubmitLimiter } = require('../middleware/rateLimiterMiddleware');
const { DOCUMENT_MAX_BYTES } = require('../kyc/kycSchema');
const { DOCUMENTS, validateRegistration } = require('../technician/technicianSchema');
const { createRegistration } = require('../technician/technicianService');

const router = express.Router();

const parseUploads = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: DOCUMENT_MAX_BYTES,
        files: DOCUMENTS.length,
        fields: 50,
        fieldSize: 16 * 1024,
        parts: 70,
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

router.post('/', technicianSubmitLimiter, (req, res) => {
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
            const { values, documents, errors } = validateRegistration(req.body || {}, files);
            if (Object.keys(errors).length) {
                return res.status(400).json({ error: 'Please correct the highlighted fields and submit again.', fields: errors });
            }
            const result = await createRegistration({
                values,
                documents,
                meta: { ip: req.ip, userAgent: req.get('user-agent') },
            });
            console.log(`[technician] registration ${result.reference} received`);
            return res.status(201).json({ ok: true, ...result });
        } catch (error) {
            return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Your form could not be submitted. Please try again.' });
        }
    });
});

module.exports = router;
