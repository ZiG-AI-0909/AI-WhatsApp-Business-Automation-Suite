// =============================================================
// Mechanic / technician registration review (staff) — /api/technicians/*
//
// Mounted behind requireAuth; every route also requires the KYC reviewer
// list (private.kyc_staff), the same people who see vendor KYC forms.
// =============================================================
const express = require('express');
const { requireKycStaff, SIGNED_URL_SECONDS } = require('../kyc/kycService');
const service = require('../technician/technicianService');
const { validateReview } = require('../technician/technicianSchema');

const router = express.Router();

function fail(res, error, fallback) {
    if (!error.statusCode) console.error(`[technician] ${fallback}:`, error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : fallback, code: error.code });
}

router.use(requireKycStaff);

router.get('/', async (req, res) => {
    try {
        const { rows, total, limit } = await service.listRegistrations(service.readFilters(req.query));
        res.json({ registrations: rows.map((row) => ({ ...row, reference: service.referenceFor(row.id) })), total, limit });
    } catch (error) {
        fail(res, error, 'Could not load technician registrations.');
    }
});

router.get('/:id', async (req, res) => {
    try {
        const registration = await service.getRegistration(req.params.id);
        const links = await service.documentLinks(registration);
        res.json({
            registration: { ...registration, reference: service.referenceFor(registration.id) },
            documentLinks: links,
            linksExpireInSeconds: SIGNED_URL_SECONDS,
        });
    } catch (error) {
        fail(res, error, 'Could not load the registration.');
    }
});

router.put('/:id/review', async (req, res) => {
    try {
        const { values, errors } = validateReview(req.body || {});
        if (Object.keys(errors).length) {
            return res.status(400).json({ error: 'Please correct the highlighted review fields.', fields: errors });
        }
        const updated = await service.updateReview(req.params.id, values, req.user?.authId);
        res.json({ registration: { ...updated, reference: service.referenceFor(updated.id) } });
    } catch (error) {
        fail(res, error, 'Could not save the review.');
    }
});

module.exports = router;
