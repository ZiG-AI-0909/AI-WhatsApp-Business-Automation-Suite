const { extractSpec, normalizeStandard, normalizeGrade } = require('./specExtractor');
function familyFor(spec) {
    if (spec.material === 'DWC' && spec.standard === 'IS 16098 Part 2') return 'DWC';
    if (spec.material === 'HDPE' && spec.standard === 'IS 4984') return 'HDPE_PRESSURE';
    if (spec.material === 'UPVC') return 'UPVC_AGRI'; if (spec.material === 'O-PVC') return 'O_PVC'; return null;
}
function match(row, priceList) {
    const spec = extractSpec(row.description || row); const family = familyFor(spec); const active = (priceList || []).filter((p) => p.active !== false);
    if (/weep holes|masonry|abutment/i.test(String(row.description || row))) return { status: 'needs_review', confidence: 0, price_list_id: null, options: [], reasons: ['Civil item mentioning pipe'] };
    if (!family) return { status: 'not_in_scope', confidence: 0, price_list_id: null, options: [], reasons: ['Product family is not supplied'] };
    const familyRows = active.filter((p) => p.product_family === family); if (!familyRows.length) return { status: 'not_in_scope', confidence: 0, price_list_id: null, options: [], reasons: [`No active ${family} products`] };
    const candidates = familyRows.filter((p) => spec.diameters.includes(Number(p.size_mm)) && (!spec.standard || normalizeStandard(p.standard) === spec.standard) && (!spec.grade || normalizeGrade(p.grade) === spec.grade));
    if (!candidates.length) return { status: 'no_match', confidence: 0, price_list_id: null, options: [], reasons: ['No matching size/specification'] };
    if (candidates.length > 1) return { status: 'ambiguous', confidence: 0, price_list_id: null, options: candidates.slice(0, 3), reasons: ['Multiple equally suitable products'] };
    const exact = !!(spec.standard && spec.grade); return { status: exact ? 'exact' : 'probable', confidence: exact ? 0.95 : 0.7, price_list_id: candidates[0].id, options: [], reasons: [] };
}
module.exports = { familyFor, match };
