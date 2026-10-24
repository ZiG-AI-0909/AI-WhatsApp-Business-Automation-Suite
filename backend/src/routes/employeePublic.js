// =============================================================
// Public employee self-registration — POST /api/public/employee-registration
//
// No authentication: the link is shared with prospective employees. IP rate
// limit before the body is read, full server-side validation, and the
// Employee ID is allocated in the database (technician/employeeRegistration.js).
//
// The response to a successful registration is the only place the initial
// PIN ever appears; there is no lookup endpoint. Nothing here logs the PIN
// or the full mobile number.
// =============================================================
const express = require('express');
const { employeeRegisterLimiter } = require('../middleware/rateLimiterMiddleware');
const { registerEmployee } = require('../technician/employeeRegistration');

const router = express.Router();

router.post('/', employeeRegisterLimiter, express.json({ limit: '4kb' }), async (req, res) => {
    try {
        const body = req.body || {};
        const result = await registerEmployee(body, { clientId: body.client_submission_id });
        if (result.errors) {
            return res.status(400).json({ error: 'Please correct the highlighted fields and submit again.', fields: result.errors });
        }
        console.log(`[employee] ${result.employee.employee_id} ${result.duplicate ? 'repeated (already saved)' : 'registered'}`);
        res.set('Cache-Control', 'no-store');
        return res.status(result.duplicate ? 200 : 201).json({ ok: true, duplicate: result.duplicate, employee: result.employee, pin: result.pin });
    } catch (error) {
        return res.status(error.statusCode || 500).json({
            error: error.statusCode ? error.message : 'Your registration could not be submitted. Please try again.',
            code: error.code,
        });
    }
});

module.exports = router;
