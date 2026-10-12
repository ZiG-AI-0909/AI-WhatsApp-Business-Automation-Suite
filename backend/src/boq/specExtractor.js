function normalizeStandard(value) {
    const s = String(value || '').toUpperCase().replace(/[:(),-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/IS\s*16098.*PART\s*2/.test(s)) return 'IS 16098 Part 2';
    if (/IS\s*4984/.test(s)) return 'IS 4984';
    const match = s.match(/IS\s*(651|12592)/); return match ? `IS ${match[1]}` : (s || null);
}
function normalizeGrade(value) {
    const compact = String(value || '').toUpperCase().replace(/[\s-]+/g, '');
    const match = compact.match(/^(PE\d+)PN(\d+(?:\.\d+)?)$/);
    if (match) return `${match[1]} PN${match[2].replace(/\.0+$/, '')}`;
    const sn = compact.match(/^SN(\d+)$/);
    return sn ? `SN${sn[1]}` : (compact || null);
}
function extractSpec(description) {
    const text = String(description || ''); const upper = text.toUpperCase(); const flags = [];
    const materials = [['HDPE', /HDPE/], ['DWC', /DOUBLE\s+WALL\s+CORRUGATED|\bDWC\b|CORRUGATED/], ['UPVC', /U\s*PVC|UPVC/], ['O-PVC', /O\s*-?\s*PVC/], ['STONEWARE', /STONE\s*WARE/], ['GI', /\bGI\b/], ['DI', /\bDI\b/], ['RCC', /\bRCC\b/]];
    const material = (materials.find(([, re]) => re.test(upper)) || [null])[0];
    const standards = [...text.matchAll(/IS\s*[: ]?\s*(?:16098(?:\s*[:\-]?\s*\d+)?\s*(?:\(?\s*PART\s*[- ]?2\s*\)?)?|4984(?:\s*[-:]?\s*\d+)?|651|12592)|IRC\s*[\w-]+/gi)].map((m) => normalizeStandard(m[0]));
    const gradeMatch = [...text.matchAll(/\b(SN\s*\d+|PE\s*\d+\s*[- ]?\s*PN\s*\d+(?:\.\d+)?|PN\s*\d+(?:\.\d+)?)\b/gi)].pop();
    const grade = gradeMatch ? normalizeGrade(gradeMatch[1]) : null;
    const lastSentence = text.split(/[.!?](?=\s|$)/).filter(Boolean).pop() || text;
    const matches = [...lastSentence.matchAll(/(\d{2,4})\s*[,;]?\s*mm\s*(?:dia(?:meter)?\b)?/gi)];
    const diameters = [...new Set(matches.map((m) => Number(m[1])))]; if (diameters.length > 1) flags.push('MULTIPLE_DIAMETERS');
    return { material, standard: standards.pop() || null, grade, diameters, flags };
}
module.exports = { normalizeStandard, normalizeGrade, extractSpec };
