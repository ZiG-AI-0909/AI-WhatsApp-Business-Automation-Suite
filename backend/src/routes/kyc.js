// =============================================================
// Vendor KYC review (staff) — /api/kyc/*
//
// Mounted behind requireAuth. GET /access answers whether the signed-in
// user is a KYC reviewer (the sidebar uses it); every other route also
// requires private.kyc_staff membership (requireKycStaff).
// =============================================================
const express = require('express');
const service = require('../kyc/kycService');
const exporter = require('../kyc/kycExport');
const { validateReview } = require('../kyc/kycSchema');

const router = express.Router();

function fail(res, error, fallback) {
    if (!error.statusCode) console.error(`[kyc] ${fallback}:`, error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : fallback, code: error.code });
}

function fileSafe(text) {
    return String(text || 'vendor').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'vendor';
}

router.get('/access', async (req, res) => {
    try {
        res.json({ staff: await service.isKycStaff(req.user?.authId) });
    } catch (error) {
        // Not set up yet (migration pending) → simply not a reviewer.
        if (error.code !== 'KYC_MIGRATION_PENDING') console.error('[kyc] access check failed:', error.message);
        res.json({ staff: false, setupRequired: error.code === 'KYC_MIGRATION_PENDING' });
    }
});

router.use(service.requireKycStaff);

router.get('/', async (req, res) => {
    try {
        const filters = service.readFilters(req.query);
        const { rows, total, limit } = await service.listSubmissions(filters);
        res.json({ submissions: rows.map((row) => ({ ...row, reference: service.referenceFor(row.id) })), total, limit });
    } catch (error) {
        fail(res, error, 'Could not load submitted forms.');
    }
});

router.get('/export/excel', async (req, res) => {
    try {
        const filters = service.readFilters(req.query);
        const { rows } = await service.exportSubmissions(filters);
        const label = [
            filters.status && `status=${filters.status}`,
            req.query.from && `from=${req.query.from}`,
            req.query.to && `to=${req.query.to}`,
            filters.q && `search="${filters.q}"`,
        ].filter(Boolean).join(', ') || 'none (all submissions)';
        const buffer = await exporter.buildKycWorkbook(rows, { filtersLabel: label });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="vendor-kyc-submissions-${new Date().toISOString().slice(0, 10)}.xlsx"`);
        res.send(buffer);
    } catch (error) {
        fail(res, error, 'Could not export submitted forms.');
    }
});

router.get('/:id', async (req, res) => {
    try {
        const submission = await service.getSubmission(req.params.id);
        const links = await service.documentLinks(submission);
        res.json({
            submission: { ...submission, reference: service.referenceFor(submission.id) },
            documentLinks: links,
            linksExpireInSeconds: service.SIGNED_URL_SECONDS,
        });
    } catch (error) {
        fail(res, error, 'Could not load the submission.');
    }
});

router.put('/:id/review', async (req, res) => {
    try {
        const { values, errors } = validateReview(req.body || {});
        if (Object.keys(errors).length) {
            return res.status(400).json({ error: 'Please correct the highlighted review fields.', fields: errors });
        }
        const updated = await service.updateReview(req.params.id, values, req.user?.authId);
        res.json({ submission: { ...updated, reference: service.referenceFor(updated.id) } });
    } catch (error) {
        fail(res, error, 'Could not save the review.');
    }
});

router.get('/:id/export/pdf', async (req, res) => {
    try {
        const submission = await service.getSubmission(req.params.id);
        const reference = service.referenceFor(submission.id);
        const pdf = await exporter.renderKycPdf(submission, { reference });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="KYC_${fileSafe(submission.legal_name)}_${reference}.pdf"`);
        res.send(pdf);
    } catch (error) {
        fail(res, error, 'Could not create the PDF.');
    }
});

module.exports = router;
