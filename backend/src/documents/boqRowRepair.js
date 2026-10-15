'use strict';

// BOQ row repair and validation for OCR-extracted tables.
//
// Scanned tenders come out of OCR with page footers and stamps as rows,
// descriptions wrapped onto extra rows, decimal points read as spaces or
// commas ("45398 80", "78,00"), duplicated fragments ("22699.40 40") and
// superscripts lost from units (m3 read as m2). The BOQ itself carries the
// means to check every row: qty x rate = amount, and the rate is printed a
// second time in words. This module:
//   1. consolidates rows (drops footers/stamps/blank rows, merges
//      continuation rows, keeps the BOQ's own S.No and Item Code),
//   2. reads each number in its plausible interpretations and keeps the
//      combination that satisfies qty x rate = amount (Rs 1 tolerance),
//      recovering a missing quantity from amount / rate when consistent,
//   3. normalises and context-repairs units,
//   4. fills Size / Specification from the description,
//   5. keeps the raw OCR text next to a cleaned display text.
// Nothing is changed silently: every change is recorded in item.corrections
// with the original value, the corrected value and the reason, and rows that
// need a human look are marked needsReview (the BOQ cannot be confirmed
// until they are reviewed).

const detector = require('./pipeLineDetector');

const TOLERANCE = 1; // rupees

// ─── Numbers ──────────────────────────────────────────────────

function round2(value) {
    const abs = Math.abs(value);
    const text = String(abs);
    const shifted = text.includes('e') ? abs * 100 : Number(`${text}e2`);
    return (Math.sign(value) || 1) * Math.round(shifted) / 100;
}

function formatNumber(value) {
    if (value === null || value === undefined) return '';
    return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Letters OCR commonly returns for digits. '$' and 'S' are ambiguous
// (5, 8 or 9 in practice), so they expand into variants.
// '/' is a common misread of 7 ("922586 9/" printed 922586.97).
const DIGIT_LOOKALIKE = { O: '0', o: '0', D: '0', Q: '0', U: '0', u: '0', n: '0', I: '1', l: '1', '|': '1', i: '1', '/': '7' };
const AMBIGUOUS_DIGIT = { $: ['5', '8', '9'], S: ['5', '8', '9'] };

function tokenVariants(token) {
    const cleaned = token.replace(/^[^\w$.,:|]+|[^\w.,:|/]+$/g, '');
    if (!cleaned) return null;
    if (/^[nOoDU]{1,2}$/.test(cleaned)) return ['00'.slice(0, cleaned.length)];
    if (!/\d/.test(cleaned)) return null;
    if (!/^[\d.,:OoDQUunIl|i$S/]+$/.test(cleaned)) return null;
    let variants = [''];
    for (const char of cleaned) {
        const options = AMBIGUOUS_DIGIT[char] || [DIGIT_LOOKALIKE[char] || (char === ':' ? '.' : char)];
        variants = variants.flatMap((prefix) => options.map((option) => prefix + option)).slice(0, 9);
    }
    return variants;
}

function parsePlainNumber(text) {
    if (/^\d+,\d{2}$/.test(text)) return { value: Number(text.replace(',', '.')), decimalComma: true };
    const grouped = text.replace(/,(?=\d)/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(grouped)) return null;
    return { value: Number(grouped), decimalComma: false };
}

// The value the old pipeline (plain parse, commas stripped) would read; used
// to detect lost decimal points ("78,00" -> 7800).
function naiveNumber(raw) {
    const text = String(raw ?? '').replace(/,/g, '').trim();
    return /^-?(?:\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : null;
}

/**
 * All plausible readings of an OCR number cell, most likely first.
 * "45398 80" -> 45398.80; "22699.40 40" -> 22699.40; "78,00" -> 78.00 then
 * 7800; "$4945 00" -> 54945.00, 84945.00, ...; "73500.00 Rupees ..." ->
 * 73500.00 (words handled separately).
 */
function numberCandidates(raw) {
    const text = String(raw ?? '').replace(/₹|\brs\.?|\binr\b/gi, ' ').trim();
    if (!text) return [];
    const tokens = [];
    for (const token of text.split(/\s+/)) {
        const variants = tokenVariants(token);
        if (!variants) break;
        tokens.push(variants);
        if (tokens.length === 3) break;
    }
    if (!tokens.length) return [];
    const readings = [];
    const combos = tokens.length === 1 ? tokens[0].map((t) => [t])
        : tokens[0].flatMap((first) => tokens[1].map((second) => [first, second, ...(tokens[2] ? [tokens[2][0]] : [])]));
    for (const parts of combos.slice(0, 9)) {
        const [first, second] = parts;
        const strings = [];
        if (parts.length === 1) strings.push(first);
        else {
            if (!first.includes('.') && /^\d{2}$/.test(second)) strings.push(`${first}.${second}`);
            if (first.endsWith('.') && /^\d+$/.test(second)) strings.push(`${first}${second.slice(0, 2)}`);
            if (!first.includes('.') && /^\d{3,}$/.test(second)) strings.push(`${first}.${second.slice(0, 2)}`);
            if (/^\d{1,2}$/.test(first) && second.includes('.')) strings.push(second);
            strings.push(first.replace(/\.$/, ''));
        }
        for (const candidate of strings) {
            const parsed = parsePlainNumber(candidate.replace(/\.$/, ''));
            if (!parsed) continue;
            readings.push({ value: parsed.value, text: candidate });
            if (parsed.decimalComma) readings.push({ value: Number(candidate.replace(',', '')), text: candidate.replace(',', '') });
        }
    }
    const seen = new Set();
    return readings.filter((reading) => Number.isFinite(reading.value) && !seen.has(reading.value) && seen.add(reading.value));
}

// ─── Amount in words (fuzzy, Indian system) ───────────────────

const WORD_VALUES = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const WORD_SCALES = { hundred: 100, thousand: 1000, lakh: 100000, lakhs: 100000, lac: 100000, crore: 10000000, crores: 10000000 };
const WORD_SKIP = new Set(['rupees', 'rupee', 'rs', 'and', 'only', 'paise', 's']);
const WORD_VOCAB = [...Object.keys(WORD_VALUES), ...Object.keys(WORD_SCALES), ...WORD_SKIP];

function levenshtein(a, b) {
    if (a === b) return 0;
    const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) rows[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    return rows[a.length][b.length];
}

function closestWord(word, vocabulary, maxDistance) {
    let best = null;
    let tie = false;
    for (const candidate of vocabulary) {
        const distance = levenshtein(word, candidate);
        if (distance > maxDistance) continue;
        if (!best || distance < best.distance) { best = { word: candidate, distance }; tie = false; }
        else if (distance === best.distance && candidate !== best.word) tie = true;
    }
    return best && !tie ? best.word : null;
}

/** "Rupees Seventy Eight Thousand Three Hundred Twenty Five Only" -> 78325 */
function wordsToNumber(text) {
    const words = String(text || '').toLowerCase().replace(/\(s\)/g, '').replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.some((word) => closestWord(word, ['rupees', 'only'], 2))) return null;
    let total = 0;
    let current = 0;
    let seen = false;
    for (const raw of words) {
        const word = WORD_VOCAB.includes(raw) ? raw : closestWord(raw, WORD_VOCAB, raw.length >= 6 ? 2 : 1);
        if (!word) return null; // an unreadable word: the value is not trustworthy
        if (WORD_SKIP.has(word)) {
            if (word === 'paise') return null;
            continue;
        }
        if (WORD_VALUES[word] !== undefined) { current += WORD_VALUES[word]; seen = true; continue; }
        const scale = WORD_SCALES[word];
        if (scale === 100) current = (current || 1) * 100;
        else { total += (current || 1) * scale; current = 0; }
        seen = true;
    }
    return seen ? total + current : null;
}

// Splits "73500.00 Rupees Seventy Three Thousand Five Hundred Only" into the
// figure and the words (OCR sometimes merges the two columns).
function splitFigureAndWords(text) {
    const value = String(text || '');
    const index = value.search(/\b[rk]u?p[eoa]?[eoc]?s\b/i);
    if (index <= 0) return { figure: value, words: '' };
    return { figure: value.slice(0, index).trim(), words: value.slice(index).trim() };
}

// ─── Units ────────────────────────────────────────────────────

const UNIT_ALIASES = [
    [/^100\s*(?:m2|m²|sqm|sq\.?\s*m)$/i, '100 m2'],
    [/^(?:m2|m²|sqm|sq\.?\s*mt?r?s?|5qm|sq\.?m\.?)$/i, 'm2'],
    [/^(?:m3|m³|cum|cu\.?\s*m\.?|curn|cu\.?mt?r?s?)$/i, 'm3'],
    [/^(?:m|mtr|mtrs|metre|metres|meter|meters|rm|rmt|r\.?m\.?)$/i, 'm'],
    [/^(?:each|cach|eacb|ea|e\.a\.)$/i, 'each'],
    [/^(?:no|no\.|nos|nos\.|number|numbers)$/i, 'No'],
    [/^(?:set|sets)$/i, 'Set'],
    [/^(?:t|mt|tonne|tonnes|ton|tons)$/i, 't'],
    [/^(?:km|kms|k\.m\.)$/i, 'km'],
    [/^(?:kg|kgs)$/i, 'kg'],
    [/^(?:l|ltr|ltrs|litre|litres)$/i, 'litre'],
];
// m followed by a misread superscript ("m=", "m:", "m'"): the dimension is lost.
const AMBIGUOUS_METRE = /^m\s*[=:;'^*"~-]$/i;
const SUPERSCRIPT_FAMILY = new Set(['m', 'm2', 'm3']);

// Primary-subject context, checked on the first part of the description so
// a pipe item that later mentions "excavated soil" stays linear.
// Area terms only repair an m/m2/m3 confusion; they never fill a blank
// unit (overhead "signs" are billed in tonnes of truss, for instance).
// Specific surface items win over a generic "concrete" earlier in the text
// ("Precast Cement Concrete Interlocking Blocks" are laid by area).
const SPECIFIC_AREA = /interlocking|paver block|road marking|tack coat|prime coat|primer coat|coating|painting|plastering|sheeting/i;
const UNIT_CONTEXT = [
    { unit: 'm2', inferBlank: false, pattern: /\bmarking\b|plaster|\bsigns?\b|clearing and grubbing/gi },
    { unit: 'each', inferBlank: true, pattern: /machine\s*hole|man\s*hole/gi },
    { unit: 'm', inferBlank: true, pattern: /\bkerb|\bpipes?\b|\bpiping\b|\bcables?\b|\bwiring\b|weep holes/gi },
    { unit: 'm3', inferBlank: true, pattern: /excavat|earth\s*work|\bfilling\b|refilling|embankment|concrete|sub[\s-]?grade|sub[\s-]?base|granular|macadam|unserviceable soil|broken metal|compacting original ground/gi },
];

function canonicalUnit(raw) {
    const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!text) return { unit: '', known: false, ambiguous: false };
    if (AMBIGUOUS_METRE.test(text)) return { unit: 'm', known: false, ambiguous: true };
    for (const [pattern, unit] of UNIT_ALIASES) if (pattern.test(text)) return { unit, known: true, ambiguous: false };
    return { unit: text, known: false, ambiguous: false };
}

// The earliest keyword in the lead of the description is the primary
// subject ("Refilling ... around trenches/pipelines, cables" is filling).
function unitFromContext(description, { blank = false } = {}) {
    const lead = String(description || '').slice(0, 160);
    if (SPECIFIC_AREA.test(lead)) return 'm2';
    let best = null;
    for (const rule of UNIT_CONTEXT) {
        rule.pattern.lastIndex = 0;
        const match = rule.pattern.exec(lead);
        if (match && (!best || match.index < best.index)) best = { ...rule, index: match.index };
    }
    if (!best || (blank && !best.inferBlank)) return null;
    return best.unit;
}

// ─── Description cleanup (display only; raw OCR text is kept) ─

const BOQ_VOCABULARY = `prime means manual mechanical earth work excavation excavated excavating trenches trench pipeline pipelines pipes pipe
providing laying lowering jointing testing commissioning conveying including including specified specifications specification
conforming latest amendments concrete cement reinforced plain grade graded metal foundation foundations surface surfaces filling
refilling available layers depth exceeding compacting consolidating ramming watering lead lift labour materials machinery
appurtenances complete required drawing drawings technical setting shoring strutting barricading caution lights removal stumps
deleterious matter dressing disposing levelling sorting stacking selected reuse radius embankment construction machinehole
manhole chambers chamber conical brick masonry plaster plastering thickness inside outside except central drain smooth fixing
frame cover approved quality plastic footsteps staggered apart directed curing complete bituminous macadam dense granular
sub-base wet mix interlocking blocks kerb stones precast markers thermoplastic compound reflectorising glass beads signs sign
retro-reflectorised aluminium sheeting mounted circular overhead erecting direction place identification board displaying
information electrofusion welding hydraulic encasing gravel corrugated double wall outer inner coupler rings destination
cutting wherever necessary screened soft soil excavated arrangements procuring water stone ware glazed caulking hemp dipped
amendments survey sewer house service connection weep holes abutment structure slope towards streetlight luminaire cable
cables armoured insulated wiring circuit breaker supplying supply fixing earth electrode grounding conduits galvanized bracket
pavement dismantling structures culverts bridges retaining walls clearing grubbing vegetation unserviceable disposal subgrade
shoulders original ground granular plant method spreading compacting primer coat emulsion tack crossings pedestrian breakers`
    .split(/\s+/).filter(Boolean);
const VOCAB_SET = new Set(BOQ_VOCABULARY);

// Only edits that OCR actually makes are corrected, so real words outside
// the vocabulary ("Class", "extending") are never turned into neighbours
// ("Glass", "exceeding"): one look-alike letter swap, or one doubled letter.
const OCR_CONFUSIONS = new Set(['c>e', 'e>c', 'f>e', 'm>n', 'n>m', 'u>n', 'n>u', 'h>b', 'b>h', 'l>i', 'i>l', 'o>e', 'e>o', 'a>o', 'o>a', 'r>n', 'n>r', 'c>o', 'o>c', 'v>y', 'y>v', 's>c', 'c>s']);

function ocrCorrection(lower) {
    for (const word of BOQ_VOCABULARY) {
        if (word.length === lower.length) {
            let diff = -1;
            for (let i = 0; i < word.length; i++) {
                if (word[i] !== lower[i]) {
                    if (diff >= 0) { diff = -2; break; }
                    diff = i;
                }
            }
            if (diff >= 0 && OCR_CONFUSIONS.has(`${lower[diff]}>${word[diff]}`)) return word;
        } else if (lower.length === word.length + 1) {
            for (let i = 1; i < lower.length; i++) {
                if (lower[i] === lower[i - 1] && lower.slice(0, i) + lower.slice(i + 1) === word) return word;
            }
        }
    }
    return null;
}

function cleanDescription(text) {
    const raw = String(text ?? '');
    const changes = [];
    const cleaned = raw.replace(/[A-Za-z][A-Za-z-]{3,}/g, (token) => {
        const lower = token.toLowerCase();
        if (VOCAB_SET.has(lower) || lower.length < 5) return token;
        const match = ocrCorrection(lower);
        if (!match) return token;
        const fixed = token[0] === token[0].toUpperCase() ? match[0].toUpperCase() + match.slice(1) : match;
        changes.push(`${token} -> ${fixed}`);
        return fixed;
    }).replace(/\s+/g, ' ').trim();
    return { text: cleaned, changes };
}

// Item codes: "9.16 10" -> "9.16.10", "16:46.1" -> "16.46.1". Codes that
// lost every separator ("914") cannot be repaired and are flagged instead.
function normalizeItemCode(code) {
    const raw = String(code ?? '').replace(/\s+/g, ' ').trim();
    if (!raw) return { code: '', changed: false, suspicious: false };
    let fixed = raw;
    if (/^[\d.:,\s]+$/.test(raw) && /\d/.test(raw)) fixed = raw.replace(/\s*[:,\s]\s*/g, '.').replace(/\.{2,}/g, '.').replace(/^\.|\.$/g, '');
    const suspicious = /^\d{3,}$/.test(fixed);
    return { code: fixed, changed: fixed !== raw, suspicious };
}

// ─── Size and specification from the description ──────────────

// Nominal sizes (mm) per pipe family, used to catch OCR-split digits
// ("PN6 0,1 10mm dia" is 110 mm, not 10 mm).
const STANDARD_SIZES = {
    pe: [16, 20, 25, 32, 40, 50, 63, 75, 90, 110, 125, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500, 560, 630, 710, 800, 900, 1000, 1200],
    dwc: [75, 90, 110, 160, 200, 250, 300, 315, 400, 450, 500, 600, 630, 700, 800, 900, 1000, 1200],
    pvc: [20, 25, 32, 40, 50, 63, 75, 90, 110, 125, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400],
    stoneware: [100, 150, 200, 225, 230, 250, 300, 350, 375, 400, 450, 500, 600],
};

function sizeFamily(material) {
    const text = String(material || '').toLowerCase();
    if (/dwc|swc/.test(text)) return 'dwc';
    if (/hdpe|mdpe|pe/.test(text)) return 'pe';
    if (/pvc/.test(text)) return 'pvc';
    if (/stoneware/.test(text)) return 'stoneware';
    return null;
}

function deriveSizeAndSpec(item, corrections = [], checks = []) {
    const detection = detector.classifyBoqItem({ description: item.description || item.rawDescription || '' });
    const text = String(item.description || '');
    if (detection.classification !== 'not_pipe' && detection.spec) {
        const spec = detection.spec;
        let sizeMm = spec.size_mm;
        const family = sizeFamily(spec.material);
        if (sizeMm !== null && family && !STANDARD_SIZES[family].includes(sizeMm)) {
            // "1 10mm" -> 110 when the joined value is a standard size.
            const split = text.match(new RegExp(`(\\d)\\s+${sizeMm}\\s*mm`, 'i'));
            const joined = split ? Number(`${split[1]}${sizeMm}`) : null;
            if (joined && STANDARD_SIZES[family].includes(joined)) {
                corrections.push({ field: 'size', original: `${sizeMm} mm`, corrected: `${joined} mm`, reason: `"${split[0]}" in the description: ${sizeMm} mm is not a standard ${spec.material} size, ${joined} mm is`, level: 'warning' });
                sizeMm = joined;
            } else {
                checks.push({ code: 'size_not_standard', level: 'warning', message: `${sizeMm} mm is not a standard ${spec.material} size: verify against the scan.` });
            }
        }
        return {
            size: sizeMm !== null ? `${sizeMm} mm${spec.outer_diameter ? ' OD' : ''}` : '',
            specification: [spec.material, spec.grade, spec.pressure_class, spec.stiffness_class, spec.np_class, ...spec.standards]
                .filter(Boolean).join(', '),
        };
    }
    const concreteGrade = text.match(/\bM\s?-?(10|15|20|25|30|35|40|45|50)\b/);
    const standards = detector.extractStandards(text).slice(0, 2);
    return {
        size: '',
        specification: [concreteGrade ? `M${concreteGrade[1]}` : '', ...standards].filter(Boolean).join(', '),
    };
}

// ─── Row consolidation ────────────────────────────────────────

const FOOTER_PATTERN = /seal\s+and\s+si\w*n\w*ture|executive\s+en\w*|^\s*page\s*\d*\s*(?:of\s*\d+)?\s*$|\bpage\s*\d*\s*of\s*\d+\b|signature\s+of\s+(?:the\s+)?contractor/i;
const TOTAL_PATTERN = /\btotal\s+(?:contract\s+)?amount\b|\bgrand\s+total\b/i;
const CODE_LIKE = /\bitem\s*no\b|\bpage\s*no\b|\bpwd\b|\bcsr\b|^\s*\d+(?:\.\d+)+\s*$/i;

function headerOf(item, field) {
    return item?.provenance?.columns?.[field] || null;
}

// Raw source cells by role, read through the mapped headers where present.
function rawCells(item) {
    const values = item.sourceValues || {};
    const find = (test) => Object.keys(values).find((header) => test(String(header).toLowerCase()));
    const quantityHeader = headerOf(item, 'quantity') || find((h) => /\b(qty|quantity)\b/.test(h));
    const unitHeader = headerOf(item, 'unit') || find((h) => /^\s*(unit|uom)\b/.test(h));
    const rateHeader = find((h) => /\brate\b/.test(h) && !/\bwords?\b/.test(h));
    const wordsHeader = find((h) => /\bwords?\b/.test(h));
    const amountHeader = find((h) => /\bamount\b/.test(h) && !/\bwords?\b/.test(h) && !/\brate\b/.test(h));
    const read = (header, fallback) => (header ? String(values[header] ?? '') : String(fallback ?? ''));
    return {
        quantity: read(quantityHeader, item.quantity),
        unit: read(unitHeader, item.unit),
        rate: read(rateHeader, item.rate),
        words: read(wordsHeader, item.rateInWords),
        amount: read(amountHeader, item.amount),
    };
}

function rowText(item, cells) {
    return [item.serialNumber, item.itemCode, item.description, cells.unit, cells.words, cells.rate].filter(Boolean).join(' ');
}

function hasMeasures(cells) {
    return Boolean(numberCandidates(cells.quantity).length || numberCandidates(splitFigureAndWords(cells.rate).figure).length
        || numberCandidates(cells.amount).length || wordsToNumber(cells.words) !== null);
}

function splitSerial(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { serial: '', code: '' };
    const lead = text.match(/^(\d{1,3}(?:[.,:]\d)?\.?)(?:\s+(.*))?$/);
    if (lead && (!lead[2] || /[a-z]/i.test(lead[2]))) return { serial: lead[1], code: lead[2] || '' };
    if (/^[\d.,:]{1,5}$/.test(text)) return { serial: text, code: '' };
    return { serial: '', code: text };
}

function appendText(target, field, text) {
    const addition = String(text || '').trim();
    if (!addition) return;
    target[field] = target[field] ? `${target[field]} ${addition}` : addition;
}

// mergeContinuations: OCR tables wrap one item over several rows; native
// Excel/Word tables do not, and a heading row there must stay a row.
function consolidateRows(sourceItems, { mergeContinuations = true } = {}) {
    const rows = sourceItems.map((item) => ({ item: { ...item }, cells: rawCells(item) }));
    const kept = [];
    const dropped = [];
    let printedTotal = null;
    const drop = (row, reason) => dropped.push({
        reason,
        page: row.item.provenance?.page ?? null,
        row: row.item.provenance?.row ?? null,
        text: rowText(row.item, row.cells).slice(0, 160),
    });

    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const { item, cells } = row;
        const text = rowText(item, cells);
        if (TOTAL_PATTERN.test(text)) {
            const total = numberCandidates(cells.amount)[0]?.value ?? numberCandidates(text.match(/[\d,. ]{6,}$/)?.[0])[0]?.value ?? null;
            if (total) printedTotal = total;
            drop(row, 'total row');
            continue;
        }
        const measures = hasMeasures(cells);
        if (!text.trim() && !measures) { drop(row, 'blank row'); continue; }
        if (!measures && FOOTER_PATTERN.test(text)) { drop(row, 'page footer / signature'); continue; }

        const serial = splitSerial(item.serialNumber);
        const description = String(item.description || '').trim();
        if (!mergeContinuations) {
            kept.push(row);
            continue;
        }
        if (!measures) {
            const previous = kept[kept.length - 1];
            const codeText = [serial.code, item.itemCode].filter(Boolean).join(' ').trim();
            const codeIsCode = CODE_LIKE.test(codeText);
            // Rubber stamps and signatures are capitals ("S.PATIL"); wrapped
            // description text has ordinary words ("0.30m depth").
            const codeIsText = !codeIsCode && /\b[a-z]{3,}\b/.test(codeText);
            if (!previous || (!description && !codeIsCode && !codeIsText)) {
                drop(row, description || codeText ? 'stamp / margin text' : 'blank row');
                continue;
            }
            if (codeIsCode) appendText(previous.item, 'itemCode', codeText);
            else if (codeIsText) appendText(previous.item, 'description', codeText);
            appendText(previous.item, 'description', description);
            appendText(previous.item, 'mergedRows', `p${item.provenance?.page ?? '?'} r${item.provenance?.row ?? '?'}`);
            continue;
        }

        // A fragment that carries only numbers (no S.No, code or description)
        // belongs to a neighbour that lacks those cells.
        if (!serial.serial && !serial.code && !item.itemCode && !description) {
            const next = rows[index + 1];
            const previous = kept[kept.length - 1];
            const fills = (target) => target && ['quantity', 'rate', 'amount', 'words'].some((key) => cells[key] && !target.cells[key]);
            const phrases = cells.words.split(/(?<=\bonly)\s+/i).filter(Boolean);
            if (phrases.length === 2 && previous && next && !previous.cells.words && !next.cells.words) {
                previous.cells.words = phrases[0];
                next.cells.words = phrases[1];
                continue;
            }
            const target = fills(next) ? next : (fills(previous) ? previous : null);
            if (target) {
                for (const key of ['quantity', 'rate', 'amount', 'words']) if (cells[key] && !target.cells[key]) target.cells[key] = cells[key];
                appendText(target.item, 'mergedRows', `p${item.provenance?.page ?? '?'} r${item.provenance?.row ?? '?'}`);
                continue;
            }
        }

        item.serialNumber = serial.serial || null;
        if (serial.code) item.itemCode = [serial.code, item.itemCode].filter(Boolean).join(' ');
        kept.push(row);
    }
    return { rows: kept, dropped, printedTotal };
}

// ─── S.No sequence ────────────────────────────────────────────

function repairSerials(rows) {
    const parsed = rows.map((row) => {
        const raw = String(row.item.serialNumber ?? '').trim();
        const digits = raw.replace(/[^\d]/g, '');
        return { raw, value: digits && digits.length <= 3 ? Number(digits) : null, clean: /^\d{1,3}\.?$/.test(raw) };
    });
    const anchor = parsed.map((entry, index) => {
        if (entry.value === null || !entry.clean) return false;
        const prev = parsed.slice(0, index).reverse().find((other) => other.value !== null);
        const prevIndex = prev ? index - 1 - parsed.slice(0, index).reverse().indexOf(prev) : -1;
        const nextOffset = parsed.slice(index + 1).findIndex((other) => other.value !== null);
        const next = nextOffset >= 0 ? parsed[index + 1 + nextOffset] : null;
        return (prev && entry.value - prev.value === index - prevIndex)
            || (next && next.value - entry.value === nextOffset + 1);
    });
    rows.forEach((row, index) => {
        const entry = parsed[index];
        let before = -1;
        for (let j = index - 1; j >= 0; j--) if (anchor[j]) { before = j; break; }
        let after = -1;
        for (let j = index + 1; j < rows.length; j++) if (anchor[j]) { after = j; break; }
        let expected = before >= 0 && after >= 0 && parsed[after].value - parsed[before].value === after - before
            ? parsed[before].value + (index - before) : null;
        // Rows before the first anchor (S.No 1 lost at the top of page 1).
        if (expected === null && before < 0 && after >= 0 && parsed[after].value - (after - index) >= 1) {
            expected = parsed[after].value - (after - index);
        }
        if (anchor[index]) {
            row.item.serialNumber = String(entry.value);
            return;
        }
        if (expected !== null && (entry.raw || entry.value !== null)) {
            if (entry.value !== expected || entry.raw !== String(expected)) {
                row.corrections.push({ field: 'serialNumber', original: entry.raw || '(blank)', corrected: String(expected), reason: `S.No read as "${entry.raw || 'blank'}"; the S.No sequence (${parsed[before].value} … ${parsed[after].value}) gives ${expected}`, level: 'warning' });
            }
            row.item.serialNumber = String(expected);
        } else if (expected !== null && !entry.raw) {
            row.corrections.push({ field: 'serialNumber', original: '(blank)', corrected: String(expected), reason: `S.No missing in OCR; the sequence gives ${expected}`, level: 'warning' });
            row.item.serialNumber = String(expected);
        } else {
            row.item.serialNumber = entry.clean && entry.value !== null ? String(entry.value) : (entry.raw || null);
        }
    });
}

// ─── qty x rate = amount reconciliation ───────────────────────

// Lists without rate/amount columns cannot be cross-checked: keep the most
// likely reading and flag only readings that differ from a plain parse.
function quantityOnly(row) {
    const { cells, corrections, checks } = row;
    const original = cells.quantity.trim();
    const reading = numberCandidates(cells.quantity)[0];
    const naive = naiveNumber(cells.quantity);
    if (!reading) {
        if (original) checks.push({ code: 'quantity_unreadable', level: 'error', message: `Quantity "${original}" is not readable.` });
        return { quantity: null, rate: null, amount: null, rateInWords: null, verified: null };
    }
    if (naive !== reading.value) {
        corrections.push({ field: 'quantity', original, corrected: reading.value, reason: naive === null ? 'OCR number format normalised (no rate/amount columns to cross-check), verify' : `"${original}" would read as ${naive}; ${reading.value} is the more likely reading (no rate/amount columns to cross-check), verify`, level: 'warning' });
    }
    return { quantity: reading.value, rate: null, amount: null, rateInWords: null, verified: null };
}

function reconcileNumbers(row) {
    const { cells, corrections, checks } = row;
    const rateSplit = splitFigureAndWords(cells.rate);
    let wordsText = cells.words;
    let amountText = cells.amount;
    // Amount in the words column, words in the rate column: column shift.
    if (!numberCandidates(amountText).length && numberCandidates(wordsText).length && wordsToNumber(wordsText) === null) {
        corrections.push({ field: 'amount', original: `(Amount column: "${amountText}")`, corrected: wordsText, reason: 'amount was read into the "Amount in Words" column', level: 'info' });
        amountText = wordsText;
        wordsText = '';
    }
    if (!wordsText && rateSplit.words) wordsText = rateSplit.words;
    const wordsRate = wordsToNumber(wordsText);

    const make = (list, cost) => list.map((reading, index) => ({ value: reading.value, text: reading.text, cost: cost + (index ? 1 : 0), index }));
    const Q = make(numberCandidates(cells.quantity), 0);
    const R = make(numberCandidates(rateSplit.figure), 0);
    if (wordsRate !== null && !R.some((candidate) => candidate.value === wordsRate)) R.push({ value: wordsRate, text: wordsText, cost: 3, words: true });
    const A = make(numberCandidates(amountText), 0);

    let best = null;
    const consider = (q, r, a, extra = 0) => {
        if (!(q.value > 0) || !(r.value > 0) || !(a.value > 0)) return;
        if (Math.abs(q.value * r.value - a.value) > TOLERANCE) return;
        let cost = q.cost + r.cost + a.cost + extra;
        // A figure the rate-in-words contradicts is less trustworthy.
        if (wordsRate !== null && r.value === wordsRate) cost -= 0.5;
        else if (wordsRate !== null && !r.words) cost += 3;
        if (!best || cost < best.cost) best = { q, r, a, cost };
    };
    for (const q of Q) for (const r of R) for (const a of A) consider(q, r, a);
    // Quantity recovered from amount / rate.
    for (const r of R) for (const a of A) {
        const value = round2(a.value / r.value);
        if (value > 0) consider({ value, cost: 4, derived: 'amount / rate' }, r, a);
    }
    // Rate recovered from amount / quantity, only when the figure is unreadable.
    if (!R.some((candidate) => !candidate.words)) for (const q of Q) for (const a of A) {
        const value = round2(a.value / q.value);
        if (value > 0 && (wordsRate === null || wordsRate === value)) consider(q, { value, cost: 4, derived: 'amount / quantity' }, a);
    }

    const originalQty = cells.quantity.trim();
    const naiveQty = naiveNumber(cells.quantity);
    if (best) {
        const { q, r, a } = best;
        // Quantity
        if (q.derived) {
            const factor = naiveQty ? naiveQty / q.value : null;
            const decimalLost = factor && Math.abs(Math.log10(factor) - Math.round(Math.log10(factor))) < 1e-9 && Math.round(Math.log10(factor)) !== 0;
            corrections.push({
                field: 'quantity',
                original: originalQty || '(blank)',
                corrected: q.value,
                reason: decimalLost
                    ? `decimal point lost in OCR ("${originalQty}" = ${naiveQty}); amount ÷ rate = ${q.value}`
                    : `quantity ${originalQty ? `"${originalQty}" fails qty × rate = amount` : 'missing'}; recovered from amount ÷ rate = ${q.value}, verify`,
                level: 'warning',
            });
        } else if (naiveQty !== null && naiveQty !== q.value) {
            corrections.push({ field: 'quantity', original: originalQty, corrected: q.value, reason: `decimal point lost in OCR ("${originalQty}" would read as ${naiveQty}); amount ÷ rate = ${q.value} confirms`, level: 'warning' });
        } else if (q.index > 0) {
            corrections.push({ field: 'quantity', original: originalQty, corrected: q.value, reason: 'alternative reading of the OCR text confirmed by qty × rate = amount', level: 'warning' });
        } else if (String(q.value) !== originalQty) {
            corrections.push({ field: 'quantity', original: originalQty, corrected: q.value, reason: 'OCR number format normalised; confirmed by qty × rate = amount', level: 'info' });
        }
        // Rate
        const originalRate = rateSplit.figure.trim();
        if (r.derived || r.words) {
            corrections.push({ field: 'rate', original: originalRate || '(blank)', corrected: r.value, reason: r.words ? `rate figure unreadable; taken from the rate in words ("${wordsText}")` : `rate figure unreadable; amount ÷ quantity = ${r.value}`, level: 'warning' });
        } else if (r.index > 0) {
            corrections.push({ field: 'rate', original: originalRate, corrected: r.value, reason: 'alternative reading of the OCR text confirmed by qty × rate = amount', level: 'warning' });
        } else if (naiveNumber(originalRate) !== r.value) {
            corrections.push({ field: 'rate', original: originalRate, corrected: r.value, reason: 'OCR number format normalised; confirmed by qty × rate = amount', level: 'info' });
        }
        // Amount
        let amount = a.value;
        const computed = round2(q.value * r.value);
        if (a.index > 0) {
            corrections.push({ field: 'amount', original: amountText.trim(), corrected: a.value, reason: 'alternative reading of the OCR text confirmed by qty × rate = amount', level: 'warning' });
        } else if (naiveNumber(amountText) !== a.value) {
            corrections.push({ field: 'amount', original: amountText.trim(), corrected: a.value, reason: 'OCR number format normalised; confirmed by qty × rate = amount', level: 'info' });
        }
        if (computed !== a.value) {
            corrections.push({ field: 'amount', original: a.value, corrected: computed, reason: `OCR amount differs from qty × rate by ${formatNumber(Math.abs(computed - a.value))} (within Rs ${TOLERANCE}); using qty × rate`, level: 'info' });
            amount = computed;
        }
        if (wordsRate !== null && wordsRate !== r.value) {
            checks.push({ code: 'rate_words_mismatch', level: 'warning', message: `Rate ${formatNumber(r.value)} differs from the rate in words (${formatNumber(wordsRate)}).` });
        }
        return { quantity: q.value, rate: r.value, amount, rateInWords: wordsText || null, verified: true };
    }

    // No consistent combination: keep the most likely readings, flag.
    const quantity = Q[0]?.value ?? null;
    const rate = R.find((candidate) => !candidate.words)?.value ?? wordsRate ?? null;
    let amount = A[0]?.value ?? null;
    if (quantity === null) checks.push({ code: 'quantity_missing', level: 'error', message: `Quantity missing or unreadable${originalQty ? ` ("${originalQty}")` : ''} and cannot be recovered from amount ÷ rate.` });
    if (rate === null) checks.push({ code: 'rate_missing', level: 'warning', message: `Rate unreadable ("${cells.rate.trim()}").` });
    if (amount === null && amountText.trim()) checks.push({ code: 'amount_unreadable', level: 'warning', message: `Amount unreadable ("${amountText.trim()}").` });
    if (amount === null && quantity !== null && rate !== null && (wordsRate === null || wordsRate === rate)) {
        amount = round2(quantity * rate);
        corrections.push({ field: 'amount', original: amountText.trim() || '(blank)', corrected: amount, reason: `amount unreadable; computed qty × rate = ${formatNumber(amount)}${wordsRate === rate ? ' (rate confirmed by the rate in words)' : ''}, verify`, level: 'warning' });
    } else if (quantity !== null && rate !== null && amount !== null) {
        checks.push({ code: 'amount_mismatch', level: 'error', message: `qty × rate = ${formatNumber(quantity * rate)} but the amount reads ${formatNumber(amount)}: verify against the scan.` });
    }
    if (quantity !== null && naiveQty !== null && naiveQty !== quantity) {
        corrections.push({ field: 'quantity', original: originalQty, corrected: quantity, reason: `OCR "${originalQty}" would read as ${naiveQty}; ${quantity} is the more likely reading but could not be cross-checked`, level: 'warning' });
    }
    return { quantity, rate, amount, rateInWords: wordsText || null, verified: false };
}

// ─── Units ────────────────────────────────────────────────────

function repairUnit(row) {
    const raw = row.cells.unit.trim();
    const { unit, known, ambiguous } = canonicalUnit(raw);
    // The cleaned text reads past typos ("consrete" -> "concrete").
    let context = unitFromContext(row.item.description || row.item.rawDescription, { blank: !raw });
    if (!raw && !context && detector.classifyBoqItem({ description: row.item.description || '' }).classification !== 'not_pipe') context = 'm';
    if (!raw) {
        if (context) {
            row.corrections.push({ field: 'unit', original: '(blank)', corrected: context, reason: `unit missing in OCR; inferred "${context}" from the description, verify`, level: 'warning' });
            return context;
        }
        row.checks.push({ code: 'unit_missing', level: 'warning', message: 'Unit missing in OCR.' });
        return '';
    }
    if ((ambiguous || SUPERSCRIPT_FAMILY.has(unit)) && context && SUPERSCRIPT_FAMILY.has(context) && context !== unit) {
        row.corrections.push({ field: 'unit', original: raw, corrected: context, reason: `unit "${raw}" does not fit the item (description indicates ${context}); superscript probably misread, verify`, level: 'warning' });
        return context;
    }
    if (ambiguous) {
        row.checks.push({ code: 'unit_ambiguous', level: 'warning', message: `Unit "${raw}" is ambiguous (m, m2 or m3).` });
        return unit;
    }
    if (known && unit !== raw) row.corrections.push({ field: 'unit', original: raw, corrected: unit, reason: 'unit spelling normalised', level: 'info' });
    if (!known) row.checks.push({ code: 'unit_unknown', level: 'warning', message: `Unit "${raw}" is not a standard unit.` });
    return unit;
}

// ─── Description boundaries between rows ──────────────────────

// Positional OCR sometimes attaches the first line of an item to the row
// above (the numbers sit lower in the cell). When the next row starts
// mid-sentence and this row contains a fresh item opening, the opening
// and everything after it move down.
const ITEM_OPENING = /\b(?:Providing|Supplying|Supply of|Construction of|Earth work)\b/g;

// Category prefixes that open the next item when they end a description
// ("... complete per specifications Mechanical Means-").
const TRAILING_PREFIX = /\s(?:Manual|Mechanical)\s+Means\s*-?\s*$/;
// Footer text OCR'd onto the same line as a description's last line.
const INLINE_FOOTER = /seal\s+and\s+si\w*n\w*ture(?:\s+(?:of\s+)?\S*contra\S*)?|\bpage\s*\d*\s*of\s*\d+\b|\bthe\s+execut\w*\s+en\w*[.,]?\s*(?:dma)?/gi;

function stripInlineFooters(row) {
    const text = String(row.item.description || '');
    const stripped = text.replace(INLINE_FOOTER, ' ').replace(/\s+/g, ' ').trim();
    if (stripped !== text.replace(/\s+/g, ' ').trim()) {
        row.corrections.push({ field: 'description', original: (text.match(INLINE_FOOTER) || []).join(' | '), corrected: '(removed)', reason: 'page footer / signature text was read into the description', level: 'info' });
        row.item.description = stripped;
    }
}

function repairDescriptionBoundaries(rows) {
    for (let index = 0; index < rows.length - 1; index++) {
        const current = rows[index];
        const next = rows[index + 1];
        const prefix = String(current.item.description || '').match(TRAILING_PREFIX);
        if (prefix && next.item.description && !String(next.item.description).startsWith(prefix[0].trim())) {
            current.item.description = String(current.item.description).slice(0, prefix.index).trim();
            next.item.description = `${prefix[0].trim()} ${next.item.description}`;
            next.corrections.push({ field: 'description', original: '', corrected: prefix[0].trim(), reason: 'heading prefix was read at the end of the previous item', level: 'info' });
        }
        const nextText = String(next.item.description || '').trim();
        const text = String(current.item.description || '');
        if (!nextText || !/^[a-z]/.test(nextText)) continue;
        let opening = null;
        ITEM_OPENING.lastIndex = 0;
        let match;
        while ((match = ITEM_OPENING.exec(text))) if (match.index > 40) opening = match.index;
        if (opening === null) continue;
        const moved = text.slice(opening).trim();
        current.item.description = text.slice(0, opening).trim();
        next.item.description = `${moved} ${nextText}`;
        next.corrections.push({ field: 'description', original: nextText.slice(0, 80), corrected: `${moved.slice(0, 80)} …`, reason: 'the first line(s) of this item were attached to the previous row in OCR and were moved back', level: 'info' });
        current.corrections.push({ field: 'description', original: `… ${moved.slice(0, 80)}`, corrected: '(moved to the next item)', reason: 'trailing text belonged to the next item', level: 'info' });
    }
}

// ─── Public entry points ──────────────────────────────────────

function needsReviewFrom(corrections, checks) {
    return corrections.some((entry) => entry.level !== 'info') || checks.some((entry) => entry.level !== 'info');
}

/**
 * Repair and validate freshly extracted BOQ rows. Returns
 * { items, summary } where summary records dropped rows, the printed total
 * and the sum of validated amounts.
 */
function repairExtractedItems(sourceItems = [], { documentText = '', mergeContinuations = true } = {}) {
    const { rows, dropped, printedTotal: totalRow } = consolidateRows(sourceItems, { mergeContinuations });
    const hasPriceColumns = rows.some((row) => row.cells.rate.trim() || row.cells.amount.trim());
    for (const row of rows) {
        row.corrections = [];
        row.checks = [];
    }
    repairSerials(rows);
    rows.forEach(stripInlineFooters);
    repairDescriptionBoundaries(rows);
    const items = rows.map((row) => {
        const { item } = row;
        const code = normalizeItemCode(item.itemCode);
        if (code.changed) row.corrections.push({ field: 'itemCode', original: String(item.itemCode).trim(), corrected: code.code, reason: 'separators in the item code normalised', level: 'info' });
        if (code.suspicious) row.checks.push({ code: 'item_code_suspicious', level: 'warning', message: `Item code "${code.code}" has no separators; it may be misread (e.g. 9.1.4): verify.` });
        item.itemCode = code.code || null;
        const rawDescription = String(item.description || '').replace(/\s+/g, ' ').trim();
        const cleaned = cleanDescription(rawDescription);
        if (cleaned.changes.length) row.corrections.push({ field: 'description', original: rawDescription, corrected: cleaned.text, reason: `OCR typos corrected for display: ${cleaned.changes.join(', ')}`, level: 'info' });
        item.description = cleaned.text || null;
        item.rawDescription = rawDescription || null;
        const numbers = hasPriceColumns ? reconcileNumbers(row) : quantityOnly(row);
        const unit = repairUnit(row);
        const derived = deriveSizeAndSpec(item, row.corrections, row.checks);
        const result = {
            ...item,
            serialNumber: item.serialNumber || null,
            itemCode: item.itemCode ? String(item.itemCode).replace(/\s+/g, ' ').trim() : null,
            rawDescription: rawDescription || null,
            description: cleaned.text || null,
            quantity: numbers.quantity,
            unit: unit || null,
            rate: numbers.rate,
            amount: numbers.amount,
            rateInWords: numbers.rateInWords,
            size: item.size || derived.size || null,
            specification: item.specification || derived.specification || null,
            ocr: { quantity: row.cells.quantity, unit: row.cells.unit, rate: row.cells.rate, words: row.cells.words, amount: row.cells.amount },
            corrections: row.corrections,
            checks: row.checks,
            verified: numbers.verified,
            reviewConfirmed: false,
        };
        result.needsReview = needsReviewFrom(result.corrections, result.checks);
        // Row-geometry warnings from table reconstruction are superseded by
        // consolidation and the qty x rate = amount check above.
        result.warnings = (Array.isArray(item.warnings) ? item.warnings : [])
            .filter((warning) => !/^Quantity could not be determined from source\.|^Unit could not be determined from source\./.test(warning))
            .filter((warning) => !mergeContinuations || !/row association|attached to this row by geometry|continuation/i.test(warning));
        delete result.mergedRows;
        return result;
    });
    const printedTotal = totalRow ?? printedTotalFromText(documentText);
    return { items, summary: summarize(items, { dropped, printedTotal, rowsIn: sourceItems.length }) };
}

function printedTotalFromText(text) {
    const pattern = /\b(?:grand\s+total|total\s+(?:contract\s+)?amount)(?:\s+in\s+(?:rs|inr)\.?)?\s*[:.\-–]?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/gi;
    let last = null;
    let match;
    while ((match = pattern.exec(String(text || '')))) {
        const value = Number(match[1].replace(/,/g, ''));
        if (value > 0) last = value;
    }
    return last;
}

function summarize(items, { dropped = [], printedTotal = null, rowsIn = items.length } = {}) {
    const amounts = items.map((item) => item.amount).filter((value) => typeof value === 'number' && Number.isFinite(value));
    const sum = Math.round(amounts.reduce((total, value) => total + Math.round(value * 100), 0)) / 100;
    const difference = printedTotal !== null && amounts.length ? round2(printedTotal - sum) : null;
    return {
        rowsIn,
        items: items.length,
        dropped,
        verifiedRows: items.filter((item) => item.verified).length,
        unverifiedRows: items.filter((item) => !item.verified).length,
        needsReview: items.filter((item) => item.needsReview && !item.reviewConfirmed).length,
        amountSum: amounts.length ? sum : null,
        printedTotal,
        difference,
        totalOk: difference === null ? null : Math.abs(difference) <= TOLERANCE,
    };
}

/**
 * Re-check rows after a human edit (PUT /api/boq/:id). Values typed by the
 * user are kept as they are; only the consistency checks are recomputed.
 * A row's confirmation survives unless its numbers changed.
 */
function revalidateItems(items = [], previousItems = []) {
    const previousById = new Map(previousItems.map((item) => [item.lineItemId, item]));
    return items.map((input) => {
        const item = { ...input };
        const quantity = naiveNumber(item.quantity);
        const rate = naiveNumber(item.rate);
        const amount = naiveNumber(item.amount);
        item.quantity = quantity;
        item.rate = rate;
        item.amount = amount;
        // Checks that only extraction can make (code, size, words) are kept.
        const RECOMPUTED = new Set(['amount_mismatch', 'quantity_missing', 'quantity_unreadable', 'unit_missing', 'amount_unreadable', 'rate_missing']);
        const checks = (Array.isArray(item.checks) ? item.checks : []).filter((check) => !RECOMPUTED.has(check.code));
        if (quantity !== null && rate !== null && amount !== null) {
            if (Math.abs(quantity * rate - amount) > TOLERANCE) {
                checks.push({ code: 'amount_mismatch', level: 'error', message: `qty × rate = ${formatNumber(quantity * rate)} but the amount is ${formatNumber(amount)}: verify against the scan.` });
            }
        } else if (quantity === null) {
            checks.push({ code: 'quantity_missing', level: 'error', message: 'Quantity missing.' });
        }
        if (!String(item.unit || '').trim()) checks.push({ code: 'unit_missing', level: 'warning', message: 'Unit missing.' });
        item.checks = checks;
        item.corrections = Array.isArray(item.corrections) ? item.corrections : [];
        item.verified = quantity !== null && rate !== null && amount !== null && checks.every((check) => check.code !== 'amount_mismatch');
        const previous = previousById.get(item.lineItemId);
        const numbersChanged = previous && ['quantity', 'rate', 'amount', 'unit'].some((field) => String(previous[field] ?? '') !== String(item[field] ?? ''));
        item.reviewConfirmed = Boolean(item.reviewConfirmed) && !numbersChanged;
        item.needsReview = needsReviewFrom(item.corrections, checks);
        return item;
    });
}

function unreviewedRows(items = []) {
    return items.map((item, index) => ({ item, index })).filter(({ item }) => item.needsReview && !item.reviewConfirmed);
}

module.exports = {
    TOLERANCE,
    numberCandidates,
    naiveNumber,
    wordsToNumber,
    splitFigureAndWords,
    canonicalUnit,
    unitFromContext,
    cleanDescription,
    deriveSizeAndSpec,
    consolidateRows,
    repairExtractedItems,
    revalidateItems,
    unreviewedRows,
    summarize,
};
