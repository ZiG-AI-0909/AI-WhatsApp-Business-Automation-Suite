// =============================================================
// Mechanic / technician registration review (staff) — /api/technicians/*
//
// Mounted behind requireAuth; every route also requires the KYC reviewer
// list (private.kyc_staff), the same people who see vendor KYC forms.
// They also manage the field-staff roster used by the form's Staff mode
// (/staff) and see each staff member's registrations and targets
// (/staff/performance). Field staff themselves have no access here.
// =============================================================
const express = require('express');
const { SIGNED_URL_SECONDS } = require('../kyc/kycService');
const { requireModule } = require('../security/teamAccess');
const service = require('../technician/technicianService');
const { validateReview } = require('../technician/technicianSchema');
const { buildTechnicianWorkbook, buildEmployeeWorkbook } = require('../technician/technicianExport');
const { filterEmployees } = require('../technician/employeeRegistration');
const staffService = require('../technician/technicianStaff');

const router = express.Router();

function fail(res, error, fallback) {
    if (!error.statusCode) console.error(`[technician] ${fallback}:`, error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : fallback, code: error.code });
}

// Technician registrations area (Team & access; before that, the KYC staff list).
router.use(requireModule('technicians'));

router.get('/', async (req, res) => {
    try {
        const { rows, total, limit } = await service.listRegistrations(service.readFilters(req.query));
        res.json({ registrations: rows.map((row) => ({ ...row, reference: service.referenceFor(row.id) })), total, limit });
    } catch (error) {
        fail(res, error, 'Could not load technician registrations.');
    }
});

// Same filters as the list (status, search), so the file matches the screen.
router.get('/export/excel', async (req, res) => {
    try {
        const filters = service.readFilters(req.query);
        const { rows } = await service.exportRegistrations(filters);
        const label = [
            filters.status && `status=${filters.status}`,
            filters.source && `registered by=${filters.source}`,
            filters.staff && `staff=${req.query.staff_label || filters.staff}`,
            req.query.from && `from=${req.query.from}`,
            req.query.to && `to=${req.query.to}`,
            filters.q && `search="${filters.q}"`,
        ].filter(Boolean).join(', ') || 'none (all registrations)';
        const buffer = await buildTechnicianWorkbook(rows, { filtersLabel: label });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="technician-partner-registrations-${new Date().toISOString().slice(0, 10)}.xlsx"`);
        res.send(buffer);
    } catch (error) {
        fail(res, error, 'Could not export technician registrations.');
    }
});

// ── Field-staff roster + performance (before /:id) ────────────────────

const actor = (req) => ({ id: req.user?.authId, email: req.user?.email });

router.get('/staff', async (req, res) => {
    try {
        res.json({ staff: await staffService.listStaff() });
    } catch (error) {
        fail(res, error, 'Could not load the staff list.');
    }
});

// Employees (the roster) as Excel, with the screen's search + state filter. No PINs.
router.get('/staff/export/excel', async (req, res) => {
    try {
        const filters = { q: String(req.query.q || '').slice(0, 100), state: String(req.query.state || '').slice(0, 40) };
        const rows = filterEmployees(await staffService.listStaff(), filters);
        const label = [filters.state && `state=${filters.state}`, filters.q && `search="${filters.q}"`].filter(Boolean).join(', ');
        const buffer = await buildEmployeeWorkbook(rows, { filtersLabel: label });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="sepl-employees-${new Date().toISOString().slice(0, 10)}.xlsx"`);
        res.send(buffer);
    } catch (error) {
        fail(res, error, 'Could not export the employees.');
    }
});

router.get('/staff/performance', async (req, res) => {
    try {
        res.json(await staffService.performance(staffService.readRange(req.query)));
    } catch (error) {
        fail(res, error, 'Could not load the staff report.');
    }
});

router.post('/staff', async (req, res) => {
    try {
        const { staff, errors } = await staffService.createStaff(req.body || {}, actor(req));
        if (!staff) return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: errors });
        res.status(201).json({ staff, fields: errors });
    } catch (error) {
        fail(res, error, 'Could not add the staff member.');
    }
});

router.put('/staff/:id', async (req, res) => {
    try {
        const { staff, errors } = await staffService.updateStaff(req.params.id, req.body || {}, actor(req));
        if (!staff) return res.status(400).json({ error: 'Please correct the highlighted fields.', fields: errors });
        res.json({ staff, fields: errors });
    } catch (error) {
        fail(res, error, 'Could not save the staff member.');
    }
});

router.delete('/staff/:id', async (req, res) => {
    try {
        const staff = await staffService.deleteStaff(req.params.id, actor(req));
        res.json({ deleted: { id: staff.id, staff_code: staff.staff_code, full_name: staff.full_name } });
    } catch (error) {
        fail(res, error, 'Could not delete the staff member.');
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
