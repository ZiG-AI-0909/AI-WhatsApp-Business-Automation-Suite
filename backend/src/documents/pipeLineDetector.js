'use strict';

// Pipe-line detection for confirmed BOQ rows.
//
// Tender BOQs are mostly civil works; only the pipe lines belong to the
// seller. Every row is classified as:
//   pipe_plastic  HDPE / PE / PVC / uPVC / OPVC / DWC / SWC pipes -> section A
//   pipe_other    stoneware, RCC/hume, DI/CI, GI, steel pipes     -> section B
//   not_pipe      everything else (stored, excluded by default)
//
// Deterministic and rule-based so it is testable and explainable: each
// result carries a confidence and the reasons that produced it. The user can
// override any line in the review step.

// A row is a pipe row only when a pipe noun is the primary subject. These
// keywords mark a different primary subject when they appear BEFORE the
// first pipe noun ("Machinehole chambers ... fixing of pipes in CC",
// "Traffic signs ... mounted on a pipe 65 NB", "earth electrode ... GI pipe").
const NON_PIPE_SUBJECTS = [
    [/\b(?:machine|man)\s*-?\s*holes?\b|\bmh\s+(?:cover|frame|chamber)/i, 'manhole'],
    [/\bchambers?\b/i, 'chamber'],
    [/\bweep\s*-?\s*holes?\b/i, 'weep holes'],
    [/\bcables?\b/i, 'cable'],
    [/\bwiring\b/i, 'wiring'],
    [/\bpoles?\b/i, 'pole'],
    [/\bsign(?:s|age|\s*boards?)?\b/i, 'sign'],
    [/\bboards?\b/i, 'board'],
    [/\bearth(?:ing)?\s+electrodes?\b|\bearthing\b/i, 'earth electrode'],
    [/\bluminaires?\b|\bstreet\s*-?\s*lights?\b/i, 'street light'],
    [/\bexcavat\w*/i, 'excavation'],
    [/\bearth\s*-?\s*work\b/i, 'earthwork'],
    [/\bre-?filling\b|\bfilling\b|\bembankment\b|\bbackfill\w*/i, 'filling'],
    [/\bpavements?\b|\bpavers?\b|\bkerbs?\b/i, 'pavement'],
    [/\bbitumen\w*|\bbituminous\b|\bmacadam\b|\btack\s+coat\b|\bprime\s+coat\b/i, 'bituminous work'],
    [/\bplaster\w*\b|\bpainting\b|\broad\s+marking\b/i, 'finishing'],
    [/\bspeed\s+breakers?\b|\bpedestrian\s+crossings?\b/i, 'road furniture'],
    [/\benergy\s+meters?\b|\bbus\s*-?\s*bars?\b|\btimers?\b|\bpanel\s+boards?\b/i, 'electrical'],
    [/\bshuttering\b|\bformwork\b|\breinforcement\b|\bsteel\s+bars?\b|\btmt\b/i, 'structural'],
    [/\bdismantl\w*|\bdemoli\w*/i, 'dismantling'],
];

// Material words that may sit right in front of the pipe noun as a modifier
// ("reinforced cement concrete pipes") without making the row a civil item.
const MODIFIER_SUBJECTS = [
    [/\bconcrete\b|\bcement\b|\bpcc\b/i, 'concrete'],
    [/\bmasonry\b|\bbrick\w*/i, 'masonry'],
];
const MODIFIER_REACH = 40;

const PIPE_NOUN = /\bpip(?:e|es|ing)\b|\bpipelines?\b(?!\s*trench)/i;
const FITTING_AFTER_PIPE = /^\s*(?:fittings?|specials?|clamps?|supports?|sleeves?|saddles?|hangers?)\b/i;

const PLASTIC_SIGNALS = [
    [/double[\s-]*wall(?:ed)?[\s-]*corrugated|\bdwc\b/i, 'DWC'],
    [/single[\s-]*wall(?:ed)?[\s-]*corrugated|\bswc\b/i, 'SWC'],
    [/\bo-?pvc\b|\bpvc-?o\b/i, 'OPVC'],
    [/\bu-?pvc\b|\bpvc-?u\b|\brigid\s+pvc\b/i, 'uPVC'],
    [/\bc-?pvc\b/i, 'CPVC'],
    [/\bhdpe\b|\bhd\s*pe\b|\bhigh\s+density\s+poly\s*ethylene\b/i, 'HDPE'],
    [/\bmdpe\b/i, 'MDPE'],
    [/\bpe\s*-?\s*(?:63|80|100)\b/i, 'PE grade'],
    [/\bpvc\b|\bpoly\s*vinyl\s+chloride\b/i, 'PVC'],
    [/\bpolypropylene\b|\bpp-?r\b/i, 'PP'],
    [/\bsn\s*-?\s*(?:2|4|8|16)\b/i, 'SN class'],
    [/\bis[\s:.-]*4984\b/i, 'IS 4984'],
    [/\bis[\s:.-]*16098\b/i, 'IS 16098'],
    [/\bis[\s:.-]*15778\b/i, 'IS 15778'],
    [/\bis[\s:.-]*4985\b/i, 'IS 4985'],
    [/\bis[\s:.-]*14333\b/i, 'IS 14333'],
    [/\bis[\s:.-]*12818\b/i, 'IS 12818'],
    [/\bcoils?\b/i, 'coil'],
];

const OTHER_SIGNALS = [
    [/\bstone\s*-?\s*ware\b|\bglazed\b|\bs\.?w\.?\s+pipes?\b/i, 'Glazed stoneware'],
    [/\bhume\b|\bnp\s*-?\s*[1-4]\b|\brcc\s+pipes?\b|\breinforced\s+cement\s+concrete\s+pipes?\b|\bcement\s+concrete\s+pipes?\b/i, 'RCC'],
    [/\bductile\s+iron\b|\bd\.\s*i\.?\b|\bdi\s+(?:k[79]|pipes?)\b/i, 'DI'],
    [/\bcast\s+iron\b|\bc\.\s*i\.?\b|\bci\s+pipes?\b/i, 'CI'],
    [/\bgalvani[sz]ed\b|\bg\.\s*i\.?\b|\bgi\s+pipes?\b/i, 'GI'],
    [/\bmild\s+steel\b|\bm\.\s*s\.?\b|\bms\s+pipes?\b|\bsteel\s+pipes?\b|\berw\b|\bstainless\b/i, 'Steel'],
    [/\basbestos\b|\bac\s+pipes?\b/i, 'AC'],
    [/\bis[\s:.-]*651\b|\bis[\s:.-]*458\b|\bis[\s:.-]*8329\b|\bis[\s:.-]*1536\b|\bis[\s:.-]*1239\b|\bis[\s:.-]*3589\b/i, 'non-plastic IS standard'],
];

// "Providing, laying, jointing, testing" = installed rate. The seller only
// supplies, so the BOQ rate is a ceiling, never our rate.
const SCOPE_WORDS = ['providing', 'supplying', 'supply', 'conveying', 'lowering', 'laying', 'jointing', 'testing', 'commissioning', 'installation', 'installing'];
const INSTALLED_SCOPE = new Set(['lowering', 'laying', 'jointing', 'testing', 'commissioning', 'installation', 'installing']);

const COMPOSITE_REMARK = 'composite item: quote pipe supply only';

function itemText(item = {}) {
    const parts = [item.product, item.description, item.specification, item.size]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean);
    // Drop exact duplicates (AI often copies the description into product).
    return [...new Set(parts)].join('. ').replace(/\s+/g, ' ').trim();
}

function firstMatch(text, pattern) {
    const match = pattern.exec(text);
    return match ? { index: match.index, text: match[0] } : null;
}

function firstSignal(text, signals) {
    let best = null;
    for (const [pattern, label] of signals) {
        const match = firstMatch(text, pattern);
        if (match && (!best || match.index < best.index)) best = { ...match, label };
    }
    return best;
}

function allSignals(text, signals) {
    return signals.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

function nearestSignal(text, signals, anchor) {
    let best = null;
    for (const [pattern, label] of signals) {
        const global = new RegExp(pattern.source, 'gi');
        let match;
        while ((match = global.exec(text))) {
            const distance = Math.abs(match.index - anchor);
            if (!best || distance < best.distance) best = { label, distance, index: match.index };
            if (match[0].length === 0) global.lastIndex++;
        }
    }
    return best;
}

function primarySubject(text, pipeIndex) {
    // Earliest non-pipe subject appearing before the pipe noun.
    let subject = null;
    for (const [pattern, label] of NON_PIPE_SUBJECTS) {
        const match = firstMatch(text, pattern);
        if (match && (pipeIndex < 0 || match.index < pipeIndex) && (!subject || match.index < subject.index)) {
            subject = { ...match, label };
        }
    }
    if (pipeIndex >= 0) {
        for (const [pattern, label] of MODIFIER_SUBJECTS) {
            const match = firstMatch(text, pattern);
            if (match && match.index < pipeIndex && pipeIndex - match.index > MODIFIER_REACH
                && (!subject || match.index < subject.index)) {
                subject = { ...match, label };
            }
        }
    }
    return subject;
}

function plasticPipePhrase(text) {
    return /(?:\b(?:hdpe|mdpe|pvc|u-?pvc|o-?pvc|c-?pvc|dwc|swc|pe\s*-?\s*(?:80|100))\s+(?:\w+\s+){0,2}pipes?\b)|(?:\bpipes?\s+(?:of|in)\s+(?:hdpe|pvc|u-?pvc|o-?pvc))/i.exec(text);
}

// ─── Spec extraction ──────────────────────────────────────────

function extractStandards(text) {
    const pattern = /\bIS\s*[:.-]?\s*(\d{3,5})(?:\s*\(?\s*part\s*[-:]?\s*(\d+|[ivx]+)\s*\)?)?(?:\s*[:-]\s*((?:19|20)\d{2})\b)?/gi;
    const found = [];
    let match;
    while ((match = pattern.exec(text))) {
        const [, number, part, year] = match;
        let label = `IS ${number}`;
        if (part) label += ` Part ${part.toUpperCase()}`;
        if (year) label += `:${year}`;
        if (!found.includes(label)) found.push(label);
    }
    return found;
}

function parseSizeField(size) {
    const raw = String(size ?? '').trim();
    if (!raw) return null;
    const match = raw.match(/(\d{2,4}(?:\.\d+)?)\s*(mm)?\b/i);
    if (!match) return null;
    if (/inch|"|''|\bin\b/i.test(raw) && !match[2]) return null;
    const value = Number(match[1]);
    return value >= 10 && value <= 3000 ? value : null;
}

// Nominal diameter in mm. "Upto 110mm dia Coil shall be used" is a supply
// note, not the size, so "up to N mm" phrases are removed first; among the
// remaining diameter mentions the LAST one wins because BOQ paragraphs end
// with the item's own size ("..., 200mm dia", "sizes of 600 mm dia").
function extractSizeMm(text) {
    const cleaned = text.replace(/\bup\s*-?\s*to\s*\d+(?:\.\d+)?\s*mm\b[^.,;]*/gi, (segment) => ' '.repeat(segment.length));
    const patterns = [
        /\bsizes?\s+(?:of\s+)?(\d{2,4}(?:\.\d+)?)\s*mm\b/gi,
        /(\d{2,4}(?:\.\d+)?)\s*mm\.?\s*(?:(?:outer|outside|nominal|internal|inner)\s+)?(?:dia(?:meter)?\b|o\.?\s?d\b|i\.?\s?d\b|nb\b|dn\b|bore\b)/gi,
        /\b(?:dn|nb|od|dia\.?)\s*(\d{2,4})\s*(?:mm)?\b/gi,
        /(\d{2,4})\s*mm\s+(?:[a-z]+\s+){0,3}pipes?\b/gi,
        /\bpipes?\s+(?:of\s+)?(\d{2,4})\s*mm\b/gi,
    ];
    let best = null;
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(cleaned))) {
            const value = Number(match[1]);
            if (value < 10 || value > 3000) continue;
            if (!best || match.index > best.index) best = { value, index: match.index, text: match[0] };
        }
    }
    return best;
}

function extractCoilLimit(text) {
    const match = text.match(/\bup\s*-?\s*to\s*(\d+(?:\.\d+)?)\s*mm\b[^.;]*\bcoils?\b/i)
        || text.match(/\bcoils?\b[^.;]*\bup\s*-?\s*to\s*(\d+(?:\.\d+)?)\s*mm\b/i);
    return match ? Number(match[1]) : null;
}

function materialLabel(classification, text) {
    if (classification === 'pipe_plastic') {
        const signals = allSignals(text, PLASTIC_SIGNALS);
        const hdpe = signals.includes('HDPE') || signals.includes('PE grade');
        if (signals.includes('DWC')) return hdpe || !signals.includes('PP') ? 'DWC HDPE' : 'DWC PP';
        if (signals.includes('SWC')) return hdpe ? 'SWC HDPE' : 'SWC';
        for (const label of ['OPVC', 'uPVC', 'CPVC', 'HDPE', 'MDPE', 'PVC', 'PP']) {
            if (signals.includes(label)) return label;
        }
        if (signals.includes('PE grade')) return 'HDPE';
        return 'Plastic';
    }
    if (classification === 'pipe_other') {
        const signals = allSignals(text, OTHER_SIGNALS).filter((label) => label !== 'non-plastic IS standard');
        if (signals.length) return signals[0];
        if (/\bis[\s:.-]*651\b/i.test(text)) return 'Glazed stoneware';
        if (/\bis[\s:.-]*458\b/i.test(text)) return 'RCC';
        if (/\bis[\s:.-]*8329\b/i.test(text)) return 'DI';
        if (/\bis[\s:.-]*(?:1239|3589)\b/i.test(text)) return 'Steel';
        return '';
    }
    return '';
}

function extractPipeSpec(item, classification = 'pipe_plastic') {
    const text = itemText(item);
    const lower = text.toLowerCase();
    const notes = [];
    const grade = text.match(/\bPE\s*-?\s*(63|80|100)\b/i);
    const pressure = text.match(/\bPN\s*-?\s*(\d{1,2}(?:\.\d+)?)\b/i);
    const stiffness = text.match(/\bSN\s*-?\s*(2|4|8|16)\b/i);
    const npClass = text.match(/\bNP\s*-?\s*([1-4])\b/i);
    const standards = extractStandards(text);
    const sizeFromText = extractSizeMm(text);
    const sizeFromField = parseSizeField(item.size);
    let sizeMm = sizeFromText?.value ?? sizeFromField ?? null;
    if (sizeFromText && sizeFromField && sizeFromText.value !== sizeFromField) {
        notes.push(`size field says ${sizeFromField} mm but the description ends with ${sizeFromText.value} mm; using ${sizeFromText.value} mm`);
    }
    if (sizeMm === null) notes.push('nominal diameter not found: enter the size');
    const outerDia = sizeFromText && /outer|outside|o\.?\s?d\b/i.test(sizeFromText.text);

    let supplyForm = null;
    const coilLimit = extractCoilLimit(text);
    if (coilLimit !== null && sizeMm !== null) supplyForm = sizeMm <= coilLimit ? 'coil' : 'straight';
    else if (/\bcoils?\b/i.test(text)) supplyForm = 'coil';
    else if (/\bstraight\s+lengths?\b/i.test(text)) supplyForm = 'straight';

    const scopeWords = SCOPE_WORDS.filter((word) => new RegExp(`\\b${word}\\b`, 'i').test(lower));
    const installed = scopeWords.some((word) => INSTALLED_SCOPE.has(word));

    const material = materialLabel(classification, text);
    return {
        material: material || null,
        grade: grade ? `PE${grade[1]}` : null,
        pressure_class: pressure ? `PN ${pressure[1]}` : null,
        stiffness_class: stiffness ? `SN${stiffness[1]}` : null,
        np_class: npClass ? `NP${npClass[1]}` : null,
        size_mm: sizeMm,
        outer_diameter: Boolean(outerDia),
        standard: standards[0] || null,
        standards,
        supply_form: supplyForm,
        coil_limit_mm: coilLimit,
        scope: installed ? 'installed' : (scopeWords.length ? 'supply' : null),
        scope_words: scopeWords,
        notes,
    };
}

function shortDescription(spec) {
    const parts = [`${spec.material ? `${spec.material} pipe` : 'Pipe'}`];
    if (spec.grade) parts.push(`grade ${spec.grade}`);
    if (spec.pressure_class) parts.push(spec.pressure_class);
    if (spec.stiffness_class) parts.push(`class ${spec.stiffness_class}`);
    if (spec.np_class) parts.push(`class ${spec.np_class}`);
    if (spec.standard) parts.push(`conforming to ${spec.standards.join(' / ')}`);
    if (spec.size_mm !== null) parts.push(`${spec.size_mm} mm${spec.outer_diameter ? ' OD' : ''}`);
    if (spec.supply_form === 'coil') parts.push('in coil');
    return `${parts.join(', ')}.`;
}

// ─── Classification ───────────────────────────────────────────

function classifyBoqItem(item = {}) {
    const text = itemText(item);
    const reasons = [];
    const pipe = firstMatch(text, PIPE_NOUN);
    const result = (classification, confidence, extra = {}) => {
        const isPipe = classification !== 'not_pipe';
        const spec = isPipe ? extractPipeSpec(item, classification) : null;
        if (spec) {
            if (spec.scope === 'installed') reasons.push(`BOQ scope "${spec.scope_words.join(', ')}" is an installed rate; we quote supply only`);
            reasons.push(...spec.notes);
            if (spec.size_mm === null) confidence -= 0.1;
        }
        return {
            classification,
            confidence: Math.max(0.05, Math.min(0.99, Number(confidence.toFixed(2)))),
            reasons,
            composite: Boolean(extra.composite),
            remark: extra.remark || '',
            section: classification === 'pipe_plastic' ? 'A' : 'B',
            include: isPipe,
            spec,
            short_description: spec ? shortDescription(spec) : '',
            full_text: text,
        };
    };

    if (!text) {
        reasons.push('row has no description');
        return result('not_pipe', 0.6);
    }
    if (!pipe) {
        reasons.push('no pipe mentioned');
        return result('not_pipe', 0.97);
    }

    const subject = primarySubject(text, pipe.index);
    if (subject) {
        const plasticPhrase = plasticPipePhrase(text);
        if (plasticPhrase) {
            reasons.push(`primary item is ${subject.label}; it includes "${plasticPhrase[0].trim()}"`);
            return result('pipe_plastic', 0.7, { composite: true, remark: COMPOSITE_REMARK });
        }
        reasons.push(`primary item is ${subject.label} ("${subject.text}"); pipe is only mentioned as part of it`);
        return result('not_pipe', 0.85);
    }

    const afterPipe = text.slice(pipe.index + pipe.text.length);
    if (FITTING_AFTER_PIPE.test(afterPipe)) {
        reasons.push('pipe fittings / specials item, not pipe: review');
        return result('pipe_other', 0.5);
    }

    const plasticNear = nearestSignal(text, PLASTIC_SIGNALS.filter(([, label]) => label !== 'coil'), pipe.index);
    const otherNear = nearestSignal(text, OTHER_SIGNALS, pipe.index);
    const plasticAll = allSignals(text, PLASTIC_SIGNALS);
    const otherAll = allSignals(text, OTHER_SIGNALS);

    if (plasticNear && (!otherNear || plasticNear.distance <= otherNear.distance)) {
        reasons.push(`pipe supply/laying item; plastic markers: ${plasticAll.join(', ')}`);
        let confidence = 0.95;
        if (otherAll.length) {
            reasons.push(`also mentions ${otherAll.join(', ')}: check material`);
            confidence -= 0.15;
        }
        return result('pipe_plastic', confidence);
    }
    if (otherNear) {
        reasons.push(`pipe supply/laying item; material: ${otherAll.join(', ')} (not in the plastic range)`);
        let confidence = 0.9;
        if (plasticAll.filter((label) => label !== 'coil').length) {
            reasons.push(`also mentions ${plasticAll.join(', ')}: check material`);
            confidence -= 0.2;
        }
        return result('pipe_other', confidence);
    }
    reasons.push('pipe item but the material is not stated: review');
    return result('pipe_other', 0.55);
}

function detectPipeLines(items = []) {
    return (Array.isArray(items) ? items : []).map((item, index) => ({ index, ...classifyBoqItem(item) }));
}

module.exports = {
    COMPOSITE_REMARK,
    classifyBoqItem,
    detectPipeLines,
    extractPipeSpec,
    extractSizeMm,
    extractStandards,
    shortDescription,
    itemText,
};
