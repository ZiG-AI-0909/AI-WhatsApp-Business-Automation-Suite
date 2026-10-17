'use strict';

// Vendor KYC — field rules for the paper "KYC Registration Form"
// (Sudarshan Extrusions Pvt. Ltd., 2 pages, 7 sections).
//
// §1–§6 are filled by the vendor on the public form; §7 (and the
// "Verified by Company" column of §5) only by staff. The server is the
// authority: frontend/src/kyc/kycForm.js repeats these rules for instant
// feedback only. Keep both in step with supabase-vendor-kyc-migration.sql.

const path = require('path');
const { validateUploadBuffer } = require('../middleware/fileValidation');

const BUSINESS_TYPES = ['Proprietorship', 'Partnership', 'LLP', 'Private Limited', 'Public Limited', 'Trust / Society', 'Other'];
const ACCOUNT_TYPES = ['Current', 'Savings', 'Cash Credit', 'Overdraft', 'Other'];
const STATES = [
    'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
    'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
    'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep',
    'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry',
    'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
    'West Bengal',
];

// §3 category → items (the public form's cascading picker). Stored as
// kyc_submissions.category_selections, in this order:
//   [{ "category": "Raw Materials", "items": ["PVC Resin"], "other_text": "" }, …]
// Items must come from the category's list; anything else goes in
// other_text ("Other" in the dropdown). The "Other" category has no list.
const CATEGORY_OPTIONS = [
    { key: 'raw_materials', label: 'Raw Materials', items: ['PVC Resin', 'Titanium Dioxide', 'Iron Oxide', 'Calcium Carbonate (Omyacarb)', 'Flowaid / Processing Aids', 'Cooling Tower & Descaling Chemicals'] },
    { key: 'components_fittings', label: 'Components & Fittings', items: ['Pipe End Caps', 'Thread Adaptors', 'SS Hose Nipples', 'Aluminium Channel', 'Gear Box / Mechanical Components'] },
    { key: 'machinery_spares', label: 'Machinery & Spares', items: ['Granulator Blades', 'Cutting / Coupler Machines'] },
    { key: 'packaging', label: 'Packaging', items: ['Packing Bags / Sacks', 'Printing Ink & Make-up', 'Filter Kits / Consumables'] },
    { key: 'transport_logistics', label: 'Transport & Logistics', items: ['Freight / Transport Services', 'Warehousing'] },
    { key: 'contractor_services', label: 'Contractor & Services', items: ['Annual Maintenance Contracts (AMC)', 'Lab / Sample Testing Services', 'Installation & Commissioning Services'] },
    { key: 'other', label: 'Other', items: null },
];
const OTHER_TEXT_MAX = 200;

// §5. The signed & sealed declaration page replaces a digital signature:
// vendors print §6, sign and stamp it, and upload the scan here.
const DOCUMENTS = [
    { key: 'pan_proof', label: 'PAN proof applicable to the business', mandatory: true },
    { key: 'gst_certificate', label: 'GST Registration Certificate', mandatory: true },
    { key: 'bank_proof', label: 'Cancelled Cheque / Bank Proof', mandatory: true },
    { key: 'udyam_certificate', label: 'Udyam / MSME Certificate', mandatory: true },
    { key: 'signed_declaration', label: 'Signed & Sealed Declaration Page', mandatory: true },
    { key: 'business_registration', label: 'Business registration proof (as applicable)', mandatory: false },
    { key: 'signatory_proof', label: 'Authorized signatory proof / authorization, if applicable', mandatory: false },
];
const DOCUMENT_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png'];
const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
const MIME_BY_EXT = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

// §7
const INTERNAL_CHECKS = [
    { key: 'business_identity', label: 'Business identity and registration checked' },
    { key: 'pan_gst', label: 'PAN / GST details checked, as applicable' },
    { key: 'bank', label: 'Bank account name and proof checked independently' },
    { key: 'technical', label: 'Technical / quality documents reviewed, if applicable' },
    { key: 'risk', label: 'Vendor risk / references reviewed, if required' },
];
const CHECK_STATUSES = ['verified', 'pending', 'na'];
const FINAL_DECISIONS = ['approved', 'rejected', 'info_required'];
const STATUSES = ['pending', 'verified', 'approved', 'rejected', 'info_required'];

const DECLARATION_TEXT = 'I/We declare that the information provided in this form and the supporting documents are true, complete and current to the best of my/our knowledge. '
    + 'I/We agree to notify Sudarshan Extrusions Pvt. Ltd. of any material change in business, tax, address, ownership or bank details. '
    + 'Submission of this form does not by itself guarantee vendor approval or placement of an order.';
const CONSENT_TEXT = 'I confirm the above information is true and complete, and I am authorized to submit this on behalf of the business.';

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const UDYAM_RE = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// kind: text (one line) | multiline | code (no spaces, upper case) |
//       digits | mobile | phone | email | url | int
const FIELDS = [
    // §1
    { key: 'legal_name', section: 1, label: 'Legal Business / Vendor Name', required: true, max: 200 },
    { key: 'business_type', section: 1, label: 'Business Type', required: true, oneOf: BUSINESS_TYPES },
    { key: 'trade_name', section: 1, label: 'Trade Name (if different)', max: 200 },
    { key: 'pan', section: 1, label: 'PAN', required: true, kind: 'code', pattern: PAN_RE, hint: 'Enter the 10-character PAN, e.g. ABCDE1234F.' },
    { key: 'gstin', section: 1, label: 'GSTIN', required: true, kind: 'code', pattern: GSTIN_RE, hint: 'Enter the 15-character GSTIN, e.g. 29ABCDE1234F1Z5.' },
    { key: 'udyam_number', section: 1, label: 'Udyam / MSME No.', required: true, kind: 'code', pattern: UDYAM_RE, hint: 'Enter the Udyam number as UDYAM-XX-00-0000000.' },
    { key: 'registered_address', section: 1, label: 'Registered Address', required: true, kind: 'multiline', max: 500 },
    { key: 'registered_pin', section: 1, label: 'PIN Code', required: true, kind: 'digits', pattern: /^[1-9][0-9]{5}$/, hint: 'Enter the 6-digit PIN code.' },
    { key: 'factory_address', section: 1, label: 'Factory / Warehouse Address', kind: 'multiline', max: 500 },
    { key: 'state', section: 1, label: 'State', required: true, oneOf: STATES },
    { key: 'website', section: 1, label: 'Website', kind: 'url', max: 200 },
    { key: 'years_in_business', section: 1, label: 'Years in Business', required: true, kind: 'int', min: 0, maxValue: 200 },
    // §2
    { key: 'contact_name', section: 2, label: 'Primary Contact Person', required: true, max: 120 },
    { key: 'contact_designation', section: 2, label: 'Designation', required: true, max: 120 },
    { key: 'contact_mobile', section: 2, label: 'Mobile Number', required: true, kind: 'mobile' },
    { key: 'contact_email', section: 2, label: 'Official Email', required: true, kind: 'email', max: 254 },
    { key: 'alternate_contact', section: 2, label: 'Alternate Contact', max: 200 },
    { key: 'landline', section: 2, label: 'Landline (if any)', kind: 'phone' },
    // §3 (category_selections is validated separately). Products / Services
    // Offered is optional now that the picker captures what vendors supply.
    { key: 'products_offered', section: 3, label: 'Products / Services Offered', kind: 'multiline', max: 2000 },
    { key: 'brands_specs', section: 3, label: 'Brands / Make / Specifications', kind: 'multiline', max: 2000 },
    { key: 'supply_capacity', section: 3, label: 'Manufacturing / Supply Capacity', kind: 'multiline', max: 1000 },
    { key: 'delivery_lead_time', section: 3, label: 'Delivery Locations / Lead Time', kind: 'multiline', max: 1000 },
    // §4
    { key: 'bank_account_holder', section: 4, label: 'Account Holder Name', required: true, max: 200 },
    { key: 'bank_name', section: 4, label: 'Bank Name', required: true, max: 200 },
    { key: 'bank_account_number', section: 4, label: 'Account Number', required: true, kind: 'digits', pattern: /^[0-9]{9,18}$/, hint: 'Enter the account number (9 to 18 digits).' },
    { key: 'bank_ifsc', section: 4, label: 'IFSC', required: true, kind: 'code', pattern: IFSC_RE, hint: 'Enter the 11-character IFSC, e.g. SBIN0001234.' },
    { key: 'bank_branch', section: 4, label: 'Branch', required: true, max: 200 },
    { key: 'bank_account_type', section: 4, label: 'Account Type', required: true, oneOf: ACCOUNT_TYPES },
    { key: 'payment_terms', section: 4, label: 'Payment Terms Requested', max: 500 },
    { key: 'currency', section: 4, label: 'Currency', kind: 'code', pattern: /^[A-Z]{3}$/, defaultValue: 'INR', hint: 'Enter a 3-letter currency code, e.g. INR.' },
    // §6
    { key: 'authorized_person_name', section: 6, label: 'Authorized Person Name', required: true, max: 200 },
    { key: 'authorized_person_designation', section: 6, label: 'Designation', required: true, max: 120 },
];

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTIN check character (15th): base-36 weighted sum, weights 1,2,1,2… */
function gstinChecksumValid(gstin) {
    let sum = 0;
    for (let index = 0; index < 14; index++) {
        const product = GST_CHARS.indexOf(gstin[index]) * (index % 2 ? 2 : 1);
        sum += Math.floor(product / 36) + (product % 36);
    }
    return GST_CHARS[(36 - (sum % 36)) % 36] === gstin[14];
}

function oneLine(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function multiLine(value) {
    return String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeMobile(value) {
    let digits = String(value ?? '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
    return digits;
}

function normalizeUrl(value) {
    const text = oneLine(value);
    if (!text) return { value: '' };
    const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
    try {
        const url = new URL(candidate);
        if (!url.hostname.includes('.') || /\s/.test(text)) throw new Error('no domain');
        return { value: candidate };
    } catch {
        return { value: text, error: 'Enter a website address like www.example.com.' };
    }
}

/** Normalize + validate one field. Returns { value, error? }. */
function checkField(field, raw) {
    const kind = field.kind || 'text';
    let value;
    let error;
    switch (kind) {
        case 'multiline': value = multiLine(raw); break;
        case 'code': value = String(raw ?? '').replace(/\s+/g, '').toUpperCase(); break;
        case 'digits': value = String(raw ?? '').replace(/[\s-]/g, ''); break;
        case 'mobile': value = normalizeMobile(raw); break;
        case 'email': value = oneLine(raw).toLowerCase(); break;
        case 'url': ({ value, error } = normalizeUrl(raw)); break;
        default: value = oneLine(raw);
    }
    if (!value && field.defaultValue) value = field.defaultValue;
    if (!value) {
        return { value: kind === 'int' ? null : '', error: field.required ? `${field.label} is required.` : undefined };
    }
    if (error) return { value, error };
    if (field.max && value.length > field.max) return { value, error: `${field.label} must be ${field.max} characters or fewer.` };
    if (field.oneOf && !field.oneOf.includes(value)) return { value, error: `Choose a ${field.label.toLowerCase()} from the list.` };
    if (field.pattern && !field.pattern.test(value)) return { value, error: field.hint || `${field.label} is not valid.` };
    if (kind === 'mobile' && !/^[6-9][0-9]{9}$/.test(value)) return { value, error: 'Enter a 10-digit Indian mobile number, e.g. 9876543210.' };
    if (kind === 'email' && !EMAIL_RE.test(value)) return { value, error: 'Enter a valid email address.' };
    if (kind === 'phone') {
        const digits = value.replace(/\D/g, '').length;
        if (!/^[0-9+\-() ]+$/.test(value) || digits < 6 || digits > 15) return { value, error: 'Enter a landline number with STD code, e.g. 0831-2400000.' };
    }
    if (kind === 'int') {
        if (!/^\d+$/.test(value)) return { value: null, error: `${field.label} must be a whole number.` };
        const number = Number(value);
        if (number < field.min || number > field.maxValue) return { value: null, error: `${field.label} must be between ${field.min} and ${field.maxValue}.` };
        return { value: number };
    }
    return { value };
}

/**
 * Validate §3 category_selections (a JSON string from the multipart form,
 * or an array). Errors use the keys the form shows them under:
 * `categories` for the whole picker, `category_<key>` per category.
 * @returns {{ value: Array, errors: object }} value in CATEGORY_OPTIONS order
 */
function checkCategorySelections(raw) {
    const errors = {};
    const malformed = 'The category selection could not be read. Please reload the form and try again.';
    let list = raw;
    if (typeof raw === 'string') {
        try { list = JSON.parse(raw); } catch { return { value: [], errors: { categories: malformed } }; }
    }
    if (list === undefined || list === null || (Array.isArray(list) && !list.length)) {
        return { value: [], errors: { categories: 'Tick at least one category.' } };
    }
    if (!Array.isArray(list) || list.length > CATEGORY_OPTIONS.length) return { value: [], errors: { categories: malformed } };

    const byKey = new Map();
    for (const entry of list) {
        const option = CATEGORY_OPTIONS.find((candidate) => candidate.label === entry?.category);
        const items = Array.isArray(entry?.items) ? [...new Set(entry.items.map((item) => String(item)))] : null;
        if (!option || byKey.has(option.key) || !items || (entry.other_text !== undefined && typeof entry.other_text !== 'string')) {
            errors.categories = malformed;
            continue;
        }
        // Only items from the category's own list; free text goes in other_text.
        if (items.some((item) => !option.items?.includes(item))) {
            errors.categories = malformed;
            continue;
        }
        const otherText = oneLine(entry.other_text);
        if (otherText.length > OTHER_TEXT_MAX) {
            errors[`category_${option.key}`] = `Keep the other item to ${OTHER_TEXT_MAX} characters or fewer.`;
        } else if (!option.items && !otherText) {
            errors[`category_${option.key}`] = 'Describe what you supply.';
        } else if (option.items && !items.length && !otherText) {
            errors[`category_${option.key}`] = `Pick at least one ${option.label.toLowerCase()} item, or untick the category.`;
        }
        byKey.set(option.key, {
            category: option.label,
            items: (option.items || []).filter((item) => items.includes(item)),
            other_text: otherText,
        });
    }
    const value = CATEGORY_OPTIONS.filter((option) => byKey.has(option.key)).map((option) => byKey.get(option.key));
    return { value, errors };
}

/** "Raw Materials: PVC Resin, Other: masterbatch" — for exports. */
function describeSelection(selection) {
    const parts = [...(selection.items || [])];
    if (selection.other_text) parts.push(selection.category === 'Other' ? selection.other_text : `Other: ${selection.other_text}`);
    return parts.join(', ');
}

function isTrue(raw) {
    return raw === true || ['true', 'on', '1', 'yes'].includes(String(raw ?? '').toLowerCase());
}

/** Today's date in India (yyyy-mm-dd) — the declaration date. */
function todayInIndia(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Validate one uploaded document. `file` is a multer file (memory storage).
 * @returns {{ ok: true, ext, mime } | { ok: false, error }}
 */
function checkDocument(file) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!DOCUMENT_EXTENSIONS.includes(ext)) return { ok: false, error: 'Upload a PDF, JPG or PNG file.' };
    if (file.size > DOCUMENT_MAX_BYTES || file.buffer?.length > DOCUMENT_MAX_BYTES) return { ok: false, error: 'Each file must be 5 MB or smaller.' };
    const check = validateUploadBuffer(file.buffer, file.originalname);
    if (!check.ok) return { ok: false, error: check.error };
    return { ok: true, ext: ext === '.jpeg' ? '.jpg' : ext, mime: MIME_BY_EXT[ext] };
}

/**
 * Validate a public submission.
 * @param {object} body  multipart text fields
 * @param {object} files { [documentKey]: multerFile }
 * @returns {{ values: object, documents: Array, errors: object }}
 *   errors maps field/document keys to a message; empty when valid.
 */
function validateSubmission(body = {}, files = {}, { now = new Date() } = {}) {
    const values = {};
    const errors = {};
    for (const field of FIELDS) {
        const result = checkField(field, body[field.key]);
        values[field.key] = result.value;
        if (result.error) errors[field.key] = result.error;
    }

    // Cross-field identity checks: a GSTIN embeds the PAN (characters 3–12)
    // and ends in a check character, which catches most typos.
    if (!errors.gstin && values.gstin) {
        if (!gstinChecksumValid(values.gstin)) errors.gstin = 'This GSTIN is not valid. Please check it against your GST certificate.';
        else if (!errors.pan && values.pan && values.gstin.slice(2, 12) !== values.pan) {
            errors.gstin = 'Characters 3 to 12 of the GSTIN must match the PAN. Please check both.';
        }
    }

    const selections = checkCategorySelections(body.category_selections);
    values.category_selections = selections.value;
    Object.assign(errors, selections.errors);

    const accountConfirm = String(body.bank_account_number_confirm ?? '').replace(/[\s-]/g, '');
    if (!errors.bank_account_number && accountConfirm !== values.bank_account_number) {
        errors.bank_account_number_confirm = 'Account numbers do not match.';
    }

    values.declaration_accepted = isTrue(body.declaration_accepted);
    if (!values.declaration_accepted) errors.declaration_accepted = 'Tick the confirmation to submit the form.';
    values.declaration_date = todayInIndia(now);

    const documents = [];
    for (const document of DOCUMENTS) {
        const file = files[document.key];
        if (!file) {
            if (document.mandatory) errors[document.key] = `${document.label} is mandatory.`;
            continue;
        }
        const check = checkDocument(file);
        if (!check.ok) {
            errors[document.key] = check.error;
            continue;
        }
        documents.push({
            type: document.key,
            ext: check.ext,
            mime: check.mime,
            size: file.buffer.length,
            buffer: file.buffer,
            fileName: oneLine(file.originalname).replace(/[^\w.\- ()]/g, '_').slice(-120),
        });
    }

    // Empty optional text → null so the row stores NULL, not ''.
    for (const field of FIELDS) {
        if (!field.required && values[field.key] === '') values[field.key] = null;
    }
    return { values, documents, errors };
}

function validDate(raw) {
    const value = oneLine(raw);
    if (!value) return { value: null };
    if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return { value: null, error: 'Enter a valid date.' };
    return { value };
}

/**
 * Status follows the review: a final decision wins; otherwise "verified"
 * once every §7 check is done (verified or N/A) and every mandatory
 * document is verified; otherwise "pending".
 */
function deriveStatus(review) {
    if (review.final_decision) return review.final_decision;
    const checksDone = INTERNAL_CHECKS.every((check) => review[`check_${check.key}`] !== 'pending');
    const docsDone = DOCUMENTS.filter((document) => document.mandatory)
        .every((document) => review.documents_verified?.[document.key] === 'yes');
    return checksDone && docsDone ? 'verified' : 'pending';
}

/**
 * Validate a staff §7 update (full replace of the review fields).
 * @returns {{ values: object, errors: object }} values includes `status`.
 */
function validateReview(body = {}) {
    const values = {};
    const errors = {};
    const text = (key, max, label) => {
        const value = key.endsWith('_remarks') || key === 'decision_remarks' ? multiLine(body[key]) : oneLine(body[key]);
        if (value.length > max) errors[key] = `${label} must be ${max} characters or fewer.`;
        values[key] = value || null;
    };

    for (const check of INTERNAL_CHECKS) {
        const status = String(body[`check_${check.key}`] ?? 'pending');
        if (!CHECK_STATUSES.includes(status)) errors[`check_${check.key}`] = 'Choose Verified, Pending or N/A.';
        values[`check_${check.key}`] = CHECK_STATUSES.includes(status) ? status : 'pending';
        text(`check_${check.key}_remarks`, 500, 'Remarks');
    }

    const verified = body.documents_verified && typeof body.documents_verified === 'object' ? body.documents_verified : {};
    values.documents_verified = {};
    for (const document of DOCUMENTS) {
        values.documents_verified[document.key] = verified[document.key] === 'yes' ? 'yes' : 'pending';
    }

    for (const [name, date, label] of [
        ['procurement_reviewer', 'procurement_reviewed_on', 'Procurement reviewer'],
        ['finance_reviewer', 'finance_reviewed_on', 'Accounts / finance reviewer'],
        ['final_approver', 'final_approved_on', 'Final approver'],
    ]) {
        text(name, 120, label);
        const result = validDate(body[date]);
        values[date] = result.value;
        if (result.error) errors[date] = result.error;
    }

    const decision = oneLine(body.final_decision);
    if (decision && !FINAL_DECISIONS.includes(decision)) errors.final_decision = 'Choose Approved, Rejected or Further information required.';
    values.final_decision = FINAL_DECISIONS.includes(decision) ? decision : null;
    text('decision_remarks', 2000, 'Decision remarks');

    const vendorCode = String(body.vendor_code ?? '').replace(/\s+/g, '').toUpperCase();
    if (vendorCode && !/^[A-Z0-9][A-Z0-9\-/]{0,39}$/.test(vendorCode)) errors.vendor_code = 'Use letters, digits, "-" or "/" (up to 40 characters).';
    values.vendor_code = vendorCode || null;

    if (values.final_decision === 'approved') {
        if (!values.vendor_code) errors.vendor_code = 'Assign a vendor code before approving.';
        if (!values.final_approver) errors.final_approver = 'Enter the final approver before approving.';
        if (!values.final_approved_on) errors.final_approved_on = 'Enter the approval date.';
    }
    if (values.final_decision === 'info_required' && !values.decision_remarks) {
        errors.decision_remarks = 'Say which information is required.';
    }

    values.status = deriveStatus(values);
    return { values, errors };
}

module.exports = {
    BUSINESS_TYPES,
    ACCOUNT_TYPES,
    STATES,
    CATEGORY_OPTIONS,
    DOCUMENTS,
    DOCUMENT_EXTENSIONS,
    DOCUMENT_MAX_BYTES,
    INTERNAL_CHECKS,
    CHECK_STATUSES,
    FINAL_DECISIONS,
    STATUSES,
    DECLARATION_TEXT,
    CONSENT_TEXT,
    FIELDS,
    gstinChecksumValid,
    checkCategorySelections,
    describeSelection,
    normalizeMobile,
    todayInIndia,
    validateSubmission,
    validateReview,
    deriveStatus,
};
