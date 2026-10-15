// =============================================================
// Recipient local time.
//
// Campaign business hours were only ever evaluated in the sender's
// timezone. A business in India messaging a contact in the UK at
// 09:30 IST would reach them at 05:00. This module maps a phone
// number's country dial code to the recipient's timezone(s) so the
// queue only sends when it is also business hours for the recipient.
//
// Countries spanning several zones list their extremes; a send is
// allowed only when the window is open in ALL of them, so nobody in
// that country gets a message outside the configured hours.
// Unknown dial codes fall back to the sender's timezone (old behaviour).
// =============================================================
const { zonedWithinBusinessHours } = require('./rateLimiter');

const DIAL_CODE_TIMEZONES = {
    1: ['America/New_York', 'America/Los_Angeles'],
    7: ['Europe/Moscow'],
    20: ['Africa/Cairo'],
    27: ['Africa/Johannesburg'],
    30: ['Europe/Athens'],
    31: ['Europe/Amsterdam'],
    32: ['Europe/Brussels'],
    33: ['Europe/Paris'],
    34: ['Europe/Madrid'],
    39: ['Europe/Rome'],
    41: ['Europe/Zurich'],
    44: ['Europe/London'],
    46: ['Europe/Stockholm'],
    47: ['Europe/Oslo'],
    49: ['Europe/Berlin'],
    52: ['America/Mexico_City', 'America/Tijuana'],
    55: ['America/Sao_Paulo', 'America/Manaus'],
    60: ['Asia/Kuala_Lumpur'],
    61: ['Australia/Sydney', 'Australia/Perth'],
    62: ['Asia/Jakarta', 'Asia/Jayapura'],
    63: ['Asia/Manila'],
    64: ['Pacific/Auckland'],
    65: ['Asia/Singapore'],
    66: ['Asia/Bangkok'],
    81: ['Asia/Tokyo'],
    82: ['Asia/Seoul'],
    84: ['Asia/Ho_Chi_Minh'],
    86: ['Asia/Shanghai'],
    90: ['Europe/Istanbul'],
    91: ['Asia/Kolkata'],
    92: ['Asia/Karachi'],
    93: ['Asia/Kabul'],
    94: ['Asia/Colombo'],
    95: ['Asia/Yangon'],
    98: ['Asia/Tehran'],
    212: ['Africa/Casablanca'],
    234: ['Africa/Lagos'],
    233: ['Africa/Accra'],
    254: ['Africa/Nairobi'],
    255: ['Africa/Dar_es_Salaam'],
    256: ['Africa/Kampala'],
    251: ['Africa/Addis_Ababa'],
    351: ['Europe/Lisbon'],
    353: ['Europe/Dublin'],
    852: ['Asia/Hong_Kong'],
    880: ['Asia/Dhaka'],
    960: ['Indian/Maldives'],
    961: ['Asia/Beirut'],
    962: ['Asia/Amman'],
    964: ['Asia/Baghdad'],
    965: ['Asia/Kuwait'],
    966: ['Asia/Riyadh'],
    968: ['Asia/Muscat'],
    971: ['Asia/Dubai'],
    972: ['Asia/Jerusalem'],
    973: ['Asia/Bahrain'],
    974: ['Asia/Qatar'],
    975: ['Asia/Thimphu'],
    977: ['Asia/Kathmandu'],
};

function timezonesForPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return [];
    for (const length of [3, 2, 1]) {
        const zones = DIAL_CODE_TIMEZONES[digits.slice(0, length)];
        if (zones) return zones;
    }
    return [];
}

const STEP_MS = 5 * 60_000;
const MAX_STEPS = 7 * 24 * 12; // one week of 5-minute steps

function openForAll(settings, date, zones) {
    return zones.every(zone => zonedWithinBusinessHours(settings, date, zone));
}

/**
 * Earliest instant >= from when it is business hours both for the sender
 * (settings.timezone) and for the recipient. Returns:
 *   { at: Date }           send now (at <= from) or defer until `at`
 *   { at: null }           no overlap within a week: cannot be sent
 * Business hours disabled → always { at: from }.
 */
function nextSendWindow(settings, phone, from = new Date()) {
    if (!settings?.businessHoursEnabled) return { at: from, zones: [] };
    const recipientZones = timezonesForPhone(phone);
    const zones = [...new Set([settings.timezone, ...recipientZones].filter(Boolean))];
    if (openForAll(settings, from, zones)) return { at: from, zones: recipientZones };
    for (let step = 1; step <= MAX_STEPS; step++) {
        const candidate = new Date(from.getTime() + step * STEP_MS);
        if (!openForAll(settings, candidate, zones)) continue;
        // Walk back minute by minute to the start of this window.
        let openAt = candidate.getTime();
        while (openAt - 60_000 > from.getTime() && openForAll(settings, new Date(openAt - 60_000), zones)) {
            openAt -= 60_000;
        }
        return { at: new Date(openAt), zones: recipientZones };
    }
    return { at: null, zones: recipientZones };
}

module.exports = { DIAL_CODE_TIMEZONES, timezonesForPhone, nextSendWindow };
