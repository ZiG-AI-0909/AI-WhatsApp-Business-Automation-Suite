'use strict';

// Mechanic / technician partner registration — field rules for the public
// form (frontend/src/technician/technicianForm.js repeats them for instant
// feedback only; the server is the authority). Keep in step with
// supabase-technician-registration-migration.sql.
//
// Errors are returned as CODES ('required', 'invalid_mobile', …), not
// sentences: the form shows them in English or Tamil (technician/i18n.js).

const { checkDocument, oneLine, multiLine, validDate, todayInIndia } = require('../kyc/kycSchema');

// All 38 districts of Tamil Nadu. The district list stays Tamil Nadu only,
// whichever state is chosen.
const DISTRICTS = [
    'Ariyalur', 'Chengalpattu', 'Chennai', 'Coimbatore', 'Cuddalore', 'Dharmapuri', 'Dindigul', 'Erode',
    'Kallakurichi', 'Kancheepuram', 'Kanniyakumari', 'Karur', 'Krishnagiri', 'Madurai', 'Mayiladuthurai',
    'Nagapattinam', 'Namakkal', 'Nilgiris', 'Perambalur', 'Pudukkottai', 'Ramanathapuram', 'Ranipet', 'Salem',
    'Sivaganga', 'Tenkasi', 'Thanjavur', 'Theni', 'Thoothukudi', 'Tiruchirappalli', 'Tirunelveli', 'Tirupathur',
    'Tiruppur', 'Tiruvallur', 'Tiruvannamalai', 'Tiruvarur', 'Vellore', 'Viluppuram', 'Virudhunagar',
];
const STATES = ['Tamil Nadu', 'Karnataka', 'Andhra Pradesh'];
const STATUSES = ['pending', 'shortlisted', 'approved', 'rejected'];

// Aadhaar is optional. Its original file name is NOT kept (it often
// contains the Aadhaar number); it is stored as aadhaar.<ext>.
const DOCUMENTS = [
    { key: 'aadhaar', label: 'Aadhaar Card', mandatory: false },
];

const EARLIEST_DATE = '1900-01-01';

function normalizeMobile(value) {
    let digits = String(value ?? '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return digits;
}

/** A yyyy-mm-dd date between 1900 and today (India). */
function checkPastDate(raw, today) {
    const { value, error } = validDate(raw);
    if (error) return { value: null, error: 'invalid_date' };
    if (!value) return { value: null };
    if (value > today) return { value: null, error: 'future_date' };
    if (value < EARLIEST_DATE) return { value: null, error: 'invalid_date' };
    return { value };
}

/**
 * Validate a public registration.
 * @param {object} body  multipart text fields
 * @param {object} files { aadhaar?: multerFile }
 * @returns {{ values: object, documents: Array, errors: object }} errors: { field: code }
 */
function validateRegistration(body = {}, files = {}, { now = new Date() } = {}) {
    const values = {};
    const errors = {};
    const today = todayInIndia(now);

    values.full_name = oneLine(body.full_name);
    if (!values.full_name) errors.full_name = 'required';
    else if (values.full_name.length < 2 || values.full_name.length > 120 || !/\p{L}/u.test(values.full_name)) errors.full_name = 'invalid_name';

    values.district = oneLine(body.district);
    if (!values.district) errors.district = 'required';
    else if (!DISTRICTS.includes(values.district)) errors.district = 'invalid_option';

    values.place = oneLine(body.place);
    if (!values.place) errors.place = 'required';
    else if (values.place.length > 120) errors.place = 'too_long';

    values.mobile = normalizeMobile(body.mobile);
    if (!values.mobile) errors.mobile = 'required';
    else if (!/^[6-9][0-9]{9}$/.test(values.mobile)) errors.mobile = 'invalid_mobile';

    values.address = multiLine(body.address);
    if (!values.address) errors.address = 'required';
    else if (values.address.length > 500) errors.address = 'too_long';

    values.pincode = String(body.pincode ?? '').replace(/\s/g, '');
    if (!values.pincode) errors.pincode = 'required';
    else if (!/^[1-9][0-9]{5}$/.test(values.pincode)) errors.pincode = 'invalid_pincode';

    values.state = oneLine(body.state);
    if (!values.state) errors.state = 'required';
    else if (!STATES.includes(values.state)) errors.state = 'invalid_option';

    const dob = checkPastDate(body.date_of_birth, today);
    values.date_of_birth = dob.value;
    if (dob.error) errors.date_of_birth = dob.error;
    else if (!dob.value) errors.date_of_birth = 'required';

    const dom = checkPastDate(body.date_of_marriage, today);
    values.date_of_marriage = dom.value;
    if (dom.error) errors.date_of_marriage = dom.error;
    else if (dom.value && values.date_of_birth && dom.value < values.date_of_birth) errors.date_of_marriage = 'marriage_before_birth';

    const documents = [];
    for (const document of DOCUMENTS) {
        const file = files[document.key];
        if (!file) {
            if (document.mandatory) errors[document.key] = 'required';
            continue;
        }
        const check = checkDocument(file);
        if (!check.ok) {
            errors[document.key] = /5 MB/.test(check.error) ? 'file_too_large' : 'invalid_file';
            continue;
        }
        documents.push({
            type: document.key,
            ext: check.ext,
            mime: check.mime,
            size: file.buffer.length,
            buffer: file.buffer,
            fileName: `${document.key}${check.ext}`,
        });
    }
    return { values, documents, errors };
}

/** Staff review: status + remarks. Errors are plain English (staff UI). */
function validateReview(body = {}) {
    const errors = {};
    const status = oneLine(body.status);
    if (!STATUSES.includes(status)) errors.status = 'Choose a status from the list.';
    const remarks = multiLine(body.review_remarks);
    if (remarks.length > 2000) errors.review_remarks = 'Remarks must be 2000 characters or fewer.';
    return { values: { status: STATUSES.includes(status) ? status : 'pending', review_remarks: remarks || null }, errors };
}

module.exports = {
    DISTRICTS,
    STATES,
    STATUSES,
    DOCUMENTS,
    normalizeMobile,
    validateRegistration,
    validateReview,
};
