// =============================================================
// Smoke test — pipe-line detection on a real tender BOQ.
//
// Fixture: 25 items of the DMA MGNVY-2.0 Package-02 (Belagavi) BOQ. The
// expected classes are the ones chosen by hand in the reference workbook
// BOQ_Quotation_Pipes_Belagavi_MGNVY2.xlsx: five HDPE/DWC lines and the
// PVC weep-hole line are plastic (A), four glazed stoneware lines are other
// pipes (B), and every civil/electrical line that merely mentions a pipe
// (manhole "fixing of pipes in CC", sign "pipe 65 NB", earth electrode GI
// pipe, trench excavation, refilling) is not a pipe.
//
// Run: node backend/src/documents/__tests__/pipe-line-detector-smoke.test.js
// =============================================================
'use strict';

const assert = require('node:assert/strict');
const fixture = require('./fixtures/belagavi-boq-items.json');
const detector = require('../pipeLineDetector');

const EXPECTED = {
    pipe_plastic: ['11', '72', '73', '74', '75', '76'],
    pipe_other: ['12', '13', '14', '15'],
};

function bySerial(results) {
    return Object.fromEntries(results.map((result) => [fixture.items[result.index].serialNumber, result]));
}

const results = detector.detectPipeLines(fixture.items);
const serials = bySerial(results);

for (const [classification, list] of Object.entries(EXPECTED)) {
    for (const serial of list) {
        assert.equal(serials[serial].classification, classification, `BOQ S.No ${serial} should be ${classification}: ${serials[serial].reasons.join('; ')}`);
    }
}
const pipeSerials = new Set([...EXPECTED.pipe_plastic, ...EXPECTED.pipe_other]);
for (const result of results) {
    const serial = fixture.items[result.index].serialNumber;
    if (pipeSerials.has(serial)) continue;
    assert.equal(result.classification, 'not_pipe', `BOQ S.No ${serial} (${fixture.items[result.index].itemCode}) must be not_pipe: ${result.reasons.join('; ')}`);
    assert.equal(result.include, false, 'non-pipe lines are stored but excluded by default');
}

// Sections and default selection
assert.equal(serials['72'].section, 'A');
assert.equal(serials['12'].section, 'B');
assert.equal(serials['72'].include, true);
assert.equal(serials['12'].include, true, 'other pipes are pre-selected for review in section B');

// False positives explained by the primary subject
assert.match(serials['19'].reasons.join(' '), /manhole/i, 'manhole chamber "fixing of pipes in CC" is a manhole item');
assert.match(serials['66'].reasons.join(' '), /sign/i, 'sign mounted on "pipe 65 NB" is a sign item');
assert.ok(serials['104'].classification === 'not_pipe' && /pipe is only mentioned/.test(serials['104'].reasons.join(' ')), 'earth electrode with GI pipe is not a pipe line');
assert.match(serials['90'].reasons.join(' '), /no pipe/i, 'PVC insulated cable mentions no pipe');

// Composite item
assert.equal(serials['11'].composite, true);
assert.equal(serials['11'].remark, 'composite item: quote pipe supply only');
assert.equal(serials['11'].spec.size_mm, 110);
assert.equal(serials['11'].spec.material, 'PVC');

// Spec extraction: HDPE PE80 PN 6.0 110 mm IS 4984:2016 in coil
const hdpe110 = serials['72'].spec;
assert.equal(hdpe110.material, 'HDPE');
assert.equal(hdpe110.grade, 'PE80');
assert.equal(hdpe110.pressure_class, 'PN 6.0');
assert.equal(hdpe110.size_mm, 110);
assert.equal(hdpe110.standard, 'IS 4984:2016');
assert.equal(hdpe110.supply_form, 'coil', 'up to 110 mm is supplied in coil');
assert.equal(hdpe110.scope, 'installed', 'providing, laying, jointing, testing = installed rate');
assert.ok(hdpe110.scope_words.includes('laying') && hdpe110.scope_words.includes('jointing'));

// "NOTE: Upto 110mm dia Coil shall be used" must not become the size of the 200 mm line
const hdpe200 = serials['73'].spec;
assert.equal(hdpe200.size_mm, 200);
assert.equal(hdpe200.supply_form, 'straight');
assert.equal(hdpe200.grade, 'PE80');
assert.equal(hdpe200.pressure_class, 'PN 6.0');

// DWC SN8 600 mm IS 16098 Part 2 ("sizes of 600 mm dia")
const dwc600 = serials['74'].spec;
assert.equal(dwc600.material, 'DWC HDPE');
assert.equal(dwc600.stiffness_class, 'SN8');
assert.equal(dwc600.size_mm, 600);
assert.equal(dwc600.standard, 'IS 16098 Part 2');
assert.equal(serials['75'].spec.size_mm, 250);
assert.equal(serials['76'].spec.size_mm, 300);

// Stoneware sizes and standard
assert.deepEqual(['12', '13', '14', '15'].map((serial) => serials[serial].spec.size_mm), [100, 100, 150, 230]);
assert.equal(serials['14'].spec.material, 'Glazed stoneware');
assert.equal(serials['14'].spec.standard, 'IS 651:1992');

// Short description instead of the 10-line BOQ paragraph; full text kept.
assert.equal(serials['72'].short_description, 'HDPE pipe, grade PE80, PN 6.0, conforming to IS 4984:2016, 110 mm, in coil.');
assert.equal(serials['74'].short_description, 'DWC HDPE pipe, class SN8, conforming to IS 16098 Part 2, 600 mm.');
assert.ok(serials['72'].full_text.length > 600 && serials['72'].full_text.includes('electrofusion'), 'full BOQ text is preserved');

// Confidence and reasons are always returned
for (const result of results) {
    assert.ok(result.confidence > 0 && result.confidence < 1, 'confidence is a probability');
    assert.ok(result.reasons.length > 0, 'every line explains its class');
}
assert.ok(serials['72'].confidence >= 0.9 && serials['11'].confidence < serials['72'].confidence, 'composite lines are less certain than clean pipe lines');

// Generic BOQ phrasing beyond the fixture
const classify = (description, extra = {}) => detector.classifyBoqItem({ description, ...extra });
assert.equal(classify('Supply of uPVC pipes 110 mm OD, 6 kgf/cm2, conforming to IS 4985').classification, 'pipe_plastic');
assert.equal(classify('Supply of uPVC pipes 110 mm OD, 6 kgf/cm2, conforming to IS 4985').spec.material, 'uPVC');
assert.equal(classify('Providing and laying PE100 PN10 pipe 160 mm dia in coils').spec.grade, 'PE100');
assert.equal(classify('Providing and laying PE100 PN10 pipe 160 mm dia in coils').spec.pressure_class, 'PN 10');
assert.equal(classify('Providing and laying reinforced cement concrete NP2 pipes 300 mm dia, IS 458').classification, 'pipe_other', 'a concrete modifier right before "pipes" is the pipe material, not the subject');
assert.equal(classify('Supplying DI K9 pipes 200 mm dia conforming to IS 8329').classification, 'pipe_other');
assert.equal(classify('Earth work excavation for pipeline trenches in all kinds of soil').classification, 'not_pipe');
assert.equal(classify('HDPE pipe fittings: bends, tees and reducers').classification, 'pipe_other', 'fittings go to review, not to section A');
assert.equal(classify('Laying of pipes as directed').classification, 'pipe_other', 'material not stated -> review');
assert.equal(classify('').classification, 'not_pipe');
assert.equal(detector.classifyBoqItem({ product: 'HDPE Pipe', size: '90 mm', specification: 'PE100 PN 8 IS 4984' }).spec.size_mm, 90, 'size column is used when the text has no diameter');

console.log(`pipe-line-detector-smoke.test.js passed (${results.length} fixture items)`);
