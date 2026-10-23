// =============================================================
// Public mechanic / technician registration — POST /api/public/technician
//
// No authentication. Same protections as the vendor KYC form
// (routes/kycPublic.js): IP rate limit before the body is read, multer
// size/count limits, magic-byte checks and full server-side validation.
//
// Staff mode (?staff=1 + registration_source=staff): a field staff member
// registers a partner. The staff member is identified on the server — a
// linked, signed-in app account or Staff ID + PIN — never from a name the
// browser sends. Without registration_source=staff the registration is
// 'self' and any staff fields are ignored.
// =============================================================
const express = require('express');
const multer = require('multer');
const { technicianSubmitLimiter, technicianStaffSubmitLimiter, technicianStaffVerifyLimiter } = require('../middleware/rateLimiterMiddleware');
const { DOCUMENT_MAX_BYTES } = require('../kyc/kycSchema');
const { DOCUMENTS, validateRegistration } = require('../technician/technicianSchema');
const { createRegistration } = require('../technician/technicianService');
const staffService = require('../technician/technicianStaff');

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

const publicStaff = (staff) => ({ staff_code: staff.staff_code, full_name: staff.full_name, via: staff.via });
const submitLimiter = (req, res, next) => (req.query?.staff === '1' ? technicianStaffSubmitLimiter : technicianSubmitLimiter)(req, res, next);

/**
 * Staff check before filling in the form, so the staff member sees their
 * name. Empty body + a signed-in, linked account → that staff member;
 * empty body otherwise → { staff: null } (the form asks for ID + PIN).
 */
router.post('/staff/verify', technicianStaffVerifyLimiter, express.json({ limit: '4kb' }), async (req, res) => {
    try {
        const body = req.body || {};
        const authUserId = await staffService.authUserFromRequest(req);
        if (!body.staff_code && !body.staff_pin) {
            if (!authUserId) return res.json({ staff: null });
            const linked = await staffService.resolveStaff({ authUserId });
            if (linked.staff) return res.json({ staff: publicStaff(linked.staff) });
            if (linked.errors?.staff_code === 'staff_inactive') return res.status(400).json({ error: 'staff_inactive', fields: linked.errors });
            return res.json({ staff: null });
        }
        const { staff, errors } = await staffService.resolveStaff({ code: body.staff_code, pin: body.staff_pin });
        if (errors) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });
        return res.json({ staff: publicStaff(staff) });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'The staff check failed. Please try again.' });
    }
});


router.post('/', submitLimiter, (req, res) => {
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
            const staffMode = req.body?.registration_source === 'staff';
            if (req.query?.staff === '1' && !staffMode) {
                return res.status(400).json({ error: 'Choose Staff mode again and submit.', fields: { staff_code: 'staff_required' } });
            }
            let attribution = null;
            if (staffMode) {
                const authUserId = await staffService.authUserFromRequest(req);
                const check = await staffService.resolveStaff({ code: req.body.staff_code, pin: req.body.staff_pin, authUserId });
                if (check.errors) Object.assign(errors, check.errors);
                else attribution = staffService.attributionFor(check.staff);
            }
            if (Object.keys(errors).length) {
                return res.status(400).json({ error: 'Please correct the highlighted fields and submit again.', fields: errors });
            }
            const result = await createRegistration({
                values,
                documents,
                meta: { ip: req.ip, userAgent: req.get('user-agent') },
                clientId: req.body?.client_submission_id,
                attribution,
            });
            console.log(`[technician] registration ${result.reference} ${result.duplicate ? 'repeated (already saved)' : 'received'}${attribution ? ` (staff ${attribution.staff_code})` : ''}`);
            return res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
        } catch (error) {
            return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Your form could not be submitted. Please try again.' });
        }
    });
});

module.exports = router;
