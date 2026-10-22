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

// Google Maps links people paste from the Maps app or browser, including
// the short share links (maps.app.goo.gl, goo.gl/maps).
function isGoogleMapsUrl(text) {
    let url;
    try { url = new URL(text); } catch { return false; }
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'maps.app.goo.gl') return true;
    if (host === 'goo.gl') return url.pathname.startsWith('/maps');
    if (/^maps\.google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)) return true;
    return /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host) && url.pathname.startsWith('/maps');
}

/** "…@11.0168,76.9558,15z" or "…?q=11.0168,76.9558" → { lat, lng } */
function coordinatesFromMapsUrl(text) {
    const match = /[@=](-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/.exec(decodeURIComponent(text));
    if (!match) return null;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

const mapsLink = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;

/**
 * Optional shop location: device coordinates (shop_latitude/longitude,
 * from the browser's location button) or a pasted Google Maps link
 * (shop_maps_url). Coordinates win when both are sent.
 */
function checkShopLocation(body) {
    const none = { shop_latitude: null, shop_longitude: null, shop_location_accuracy_m: null, shop_maps_url: null, shop_location_source: null };
    const latText = String(body.shop_latitude ?? '').trim();
    const lngText = String(body.shop_longitude ?? '').trim();
    if (latText || lngText) {
        const lat = Number(latText);
        const lng = Number(lngText);
        if (!latText || !lngText || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            return { value: none, error: 'invalid_location' };
        }
        const latitude = Math.round(lat * 1e6) / 1e6;
        const longitude = Math.round(lng * 1e6) / 1e6;
        const accuracy = Number(body.shop_location_accuracy);
        return {
            value: {
                shop_latitude: latitude,
                shop_longitude: longitude,
                shop_location_accuracy_m: Number.isFinite(accuracy) && accuracy >= 0 ? Math.min(Math.round(accuracy), 100000) : null,
                shop_maps_url: mapsLink(latitude, longitude),
                shop_location_source: 'device',
            },
        };
    }
    const link = oneLine(body.shop_maps_url);
    if (!link) return { value: none };
    const withScheme = /^https?:\/\//i.test(link) ? link : `https://${link}`;
    if (withScheme.length > 500 || !isGoogleMapsUrl(withScheme)) return { value: none, error: 'invalid_maps_url' };
    const coords = coordinatesFromMapsUrl(withScheme);
    return {
        value: {
            ...none,
            shop_latitude: coords?.lat ?? null,
            shop_longitude: coords?.lng ?? null,
            shop_maps_url: withScheme,
            shop_location_source: 'link',
        },
    };
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

    // Optional: shop name, both dates, shop location, Aadhaar.
    values.shop_name = oneLine(body.shop_name) || null;
    if (values.shop_name && values.shop_name.length > 120) errors.shop_name = 'too_long';

    const dob = checkPastDate(body.date_of_birth, today);
    values.date_of_birth = dob.value;
    if (dob.error) errors.date_of_birth = dob.error;

    const dom = checkPastDate(body.date_of_marriage, today);
    values.date_of_marriage = dom.value;
    if (dom.error) errors.date_of_marriage = dom.error;
    else if (dom.value && values.date_of_birth && dom.value < values.date_of_birth) errors.date_of_marriage = 'marriage_before_birth';

    const location = checkShopLocation(body);
    Object.assign(values, location.value);
    if (location.error) errors.shop_location = location.error;

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
    isGoogleMapsUrl,
    checkShopLocation,
    validateRegistration,
    validateReview,
};
