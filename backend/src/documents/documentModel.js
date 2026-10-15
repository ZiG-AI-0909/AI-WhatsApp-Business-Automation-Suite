const HEADER_ALIASES = {
    serialNumber: ['s no', 'sno', 'sr no', 'srno', 'sl no', 'slno', 'serial no', 'serial number', 'item no', 'sr number', 'sl number'],
    itemCode: ['item code', 'boq code', 'boq item code', 'code', 'item id', 'material code'],
    description: ['description', 'item description', 'description of item', 'material description', 'particulars', 'description of work', 'item name', 'name of item', 'scope of work'],
    product: ['product', 'material', 'product name', 'material name'],
    size: ['size', 'diameter', 'nominal size'],
    specification: ['specification', 'spec', 'grade', 'standard'],
    quantity: ['quantity', 'qty', 'required qty', 'required quantity', 'estimate quantity', 'estimated quantity', 'tender quantity', 'quantity required', 'reqd qty', 'reqd quantity'],
    unit: ['unit', 'uom', 'u o m', 'unit of measurement', 'unit of measure', 'measurement unit'],
    rate: ['rate', 'unit rate', 'quoted rate'],
    amount: ['amount', 'total amount', 'estimated amount'],
    application: ['application', 'use', 'end use'],
    remarks: ['remarks', 'remark', 'notes', 'note'],
};

function normalizeHeader(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

const NORMALIZED_ALIASES = Object.fromEntries(
    Object.entries(HEADER_ALIASES).map(([field, aliases]) => [field, new Set(aliases.map(normalizeHeader))])
);

function mapHeaders(headers) {
    const candidates = {};
    const unmapped = [];
    for (let index = 0; index < headers.length; index++) {
        const header = String(headers[index] ?? '').trim();
        const normalized = normalizeHeader(header);
        let field = Object.keys(NORMALIZED_ALIASES).find((candidate) => NORMALIZED_ALIASES[candidate].has(normalized));
        if (!field && /\b(quantity|qty)\b/.test(normalized) && !/\b(rate|amount|price)\b/.test(normalized)) field = 'quantity';
        if (!field && /\b(unit|uom)\b/.test(normalized) && !/\b(rate|price|amount)\b/.test(normalized)) field = 'unit';
        if (!field && /\b(description|particulars)\b/.test(normalized)) field = 'description';
        if (!field && /\b(item|boq|material)\b/.test(normalized) && /\b(code|id)\b/.test(normalized)) field = 'itemCode';
        if (field) (candidates[field] ||= []).push({ index, header });
        else if (header) unmapped.push({ index, header });
    }
    const columns = {};
    const ambiguous = {};
    for (const [field, matches] of Object.entries(candidates)) {
        if (matches.length === 1) columns[field] = matches[0];
        else ambiguous[field] = matches;
    }
    return { columns, ambiguous, unmapped };
}

function isHeaderRow(row) {
    const mapped = mapHeaders(row.map((value) => String(value ?? '')));
    const fields = Object.keys(mapped.columns);
    return fields.length >= 2 && fields.some((field) => ['description', 'product', 'itemCode', 'serialNumber', 'quantity', 'unit'].includes(field));
}

function extractTablesFromMatrix(matrix, location = {}) {
    const tables = [];
    let cursor = 0;
    while (cursor < matrix.length) {
        while (cursor < matrix.length && !isHeaderRow(matrix[cursor] || [])) cursor++;
        if (cursor >= matrix.length) break;

        const headerIndex = cursor;
        const headers = (matrix[headerIndex] || []).map((value) => String(value ?? '').trim());
        const headerMap = mapHeaders(headers);
        const tableNumber = location.table ? location.table + tables.length : tables.length + 1;
        const rows = [];
        let rowIndex = headerIndex + 1;
        while (rowIndex < matrix.length) {
            const values = (matrix[rowIndex] || []).map((value) => value ?? '');
            const isBlank = values.every((value) => String(value ?? '').trim() === '');
            if (isBlank) break;
            if (isHeaderRow(values)) {
                const nextHeaders = values.map((value) => String(value ?? '').trim());
                const nextMap = mapHeaders(nextHeaders);
                const sameHeader = Object.entries(headerMap.columns).every(([field, column]) =>
                    nextMap.columns[field]?.header === column.header
                );
                if (sameHeader) {
                    rowIndex++;
                    continue;
                }
                break;
            }
            rows.push({
                cells: values,
                source: {
                    ...location,
                    table: tableNumber,
                    row: (location.rowOffset || 0) + rowIndex + 1,
                },
            });
            rowIndex++;
        }
        if (rows.length) {
            const descriptionIndex = headerMap.columns.description?.index;
            const mergedRows = [];
            for (const row of rows) {
                const populated = row.cells
                    .map((value, index) => String(value ?? '').trim() ? index : -1)
                    .filter((index) => index >= 0);
                const prior = mergedRows[mergedRows.length - 1];
                if (prior && descriptionIndex != null && populated.length === 1 && populated[0] === descriptionIndex) {
                    prior.cells[descriptionIndex] = [prior.cells[descriptionIndex], row.cells[descriptionIndex]].filter(Boolean).join(' ');
                    prior.source.continuationSources = [
                        ...(prior.source.continuationSources || []),
                        { page: row.source.page ?? null, row: row.source.row },
                    ];
                } else {
                    mergedRows.push(row);
                }
            }
            tables.push({
                headers,
                headerRow: (location.rowOffset || 0) + headerIndex + 1,
                columnMap: headerMap.columns,
                ambiguousHeaders: headerMap.ambiguous,
                unmappedHeaders: headerMap.unmapped,
                source: { ...location, table: tableNumber },
                rows: mergedRows,
            });
        }
        cursor = Math.max(rowIndex + 1, headerIndex + 1);
    }
    return tables;
}

function mergeContinuedPageTables(tables) {
    const merged = [];
    for (const table of tables || []) {
        const prior = merged[merged.length - 1];
        const signature = (headers) => headers.map(normalizeHeader).join('|');
        const previousPage = prior?._lastPage ?? prior?.source?.page;
        const consecutive = previousPage != null && table.source?.page === previousPage + 1;
        if (consecutive && signature(prior.headers) === signature(table.headers)) {
            const descriptionIndex = prior.columnMap.description?.index;
            const identityIndexes = ['serialNumber', 'itemCode']
                .map((field) => prior.columnMap[field]?.index)
                .filter((index) => index != null);
            const measureIndexes = ['quantity', 'unit', 'rate', 'amount']
                .map((field) => prior.columnMap[field]?.index)
                .filter((index) => index != null);
            for (const row of table.rows) {
                const populated = row.cells
                    .map((value, index) => String(value ?? '').trim() ? index : -1)
                    .filter((index) => index >= 0);
                const priorRow = prior.rows[prior.rows.length - 1];
                const hasIdentity = identityIndexes.some((index) => String(row.cells[index] ?? '').trim());
                const hasDescription = descriptionIndex != null && String(row.cells[descriptionIndex] ?? '').trim();
                const descriptionContinuation = populated.length === 1 && populated[0] === descriptionIndex;
                const valuesContinuation = populated.length > 0 && populated.every((index) => measureIndexes.includes(index));
                if (priorRow && !hasIdentity && String(priorRow.cells[descriptionIndex] ?? '').trim()
                    && (descriptionContinuation || valuesContinuation)) {
                    const conflicts = populated.filter((index) => index !== descriptionIndex
                        && String(priorRow.cells[index] ?? '').trim()
                        && String(priorRow.cells[index]) !== String(row.cells[index]));
                    if (conflicts.length) {
                        const warning = 'Page continuation conflicts with populated source columns; row association requires review.';
                        priorRow.source.reviewWarnings = [...new Set([...(priorRow.source.reviewWarnings || []), warning])];
                        row.source.reviewWarnings = [...new Set([...(row.source.reviewWarnings || []), warning])];
                        prior.rows.push({ ...row, source: { ...row.source, table: prior.source.table } });
                        continue;
                    }
                    if (descriptionContinuation) {
                        priorRow.cells[descriptionIndex] = [priorRow.cells[descriptionIndex], row.cells[descriptionIndex]].filter(Boolean).join(' ');
                    } else {
                        for (const index of populated) priorRow.cells[index] = priorRow.cells[index] || row.cells[index];
                    }
                    priorRow.source.continuationSources = [
                        ...(priorRow.source.continuationSources || []),
                        {
                            page: row.source.page ?? table.source.page,
                            row: row.source.row,
                            cellBounds: row.source.cellBounds || [],
                            rawOcrDetections: row.source.rawOcrDetections || [],
                        },
                    ];
                    priorRow.source.cellBounds = [...(priorRow.source.cellBounds || []), ...(row.source.cellBounds || [])];
                    priorRow.source.rawOcrDetections = [...(priorRow.source.rawOcrDetections || []), ...(row.source.rawOcrDetections || [])];
                    priorRow.source.reviewWarnings = [...new Set([...(priorRow.source.reviewWarnings || []), ...(row.source.reviewWarnings || [])])];
                } else {
                    prior.rows.push({ ...row, source: { ...row.source, table: prior.source.table } });
                }
            }
            prior._lastPage = table.source.page;
            continue;
        }
        const tableNumber = merged.length + 1;
        table.source = { ...table.source, table: tableNumber };
        table.rows = table.rows.map((row) => ({
            ...row,
            source: { ...row.source, table: tableNumber },
        }));
        merged.push(table);
    }
    for (const table of merged) delete table._lastPage;
    return merged;
}

function extractTablesAcrossPages(pages) {
    const segments = [];
    for (const page of pages || []) {
        const pageTables = extractTablesFromMatrix(page.matrix || [], { page: page.page });
        if (pageTables.length) {
            segments.push(...pageTables);
            continue;
        }
        const prior = segments[segments.length - 1];
        const previousPage = prior?._lastPage ?? prior?.source?.page;
        if (!prior || previousPage == null || page.page !== previousPage + 1) continue;
        const descriptionColumn = prior.columnMap.description;
        const quantityColumn = prior.columnMap.quantity;
        const unitColumn = prior.columnMap.unit;
        const expectedCells = prior.headers.length;
        const continuationRows = (page.matrix || []).map((cells, index) => ({
            cells: (cells || []).map((value) => value ?? ''),
            row: index + 1,
        })).filter(({ cells }) => cells.some((value) => String(value ?? '').trim()));
        if (!continuationRows.length || continuationRows.some(({ cells }) => cells.length > expectedCells)) continue;
        const shapedRows = continuationRows.every(({ cells }) => {
            const quantity = quantityColumn ? String(cells[quantityColumn.index] ?? '').trim() : '';
            const unit = unitColumn ? String(cells[unitColumn.index] ?? '').trim() : '';
            return cells.length === expectedCells || quantity || unit;
        });
        if (!shapedRows) continue;
        for (const entry of continuationRows) {
            while (entry.cells.length < expectedCells) entry.cells.push('');
            const nonEmptyIndexes = entry.cells
                .map((value, index) => String(value ?? '').trim() ? index : -1)
                .filter((index) => index >= 0);
            const priorRow = prior.rows[prior.rows.length - 1];
            if (nonEmptyIndexes.length === 1 && descriptionColumn?.index === nonEmptyIndexes[0] && priorRow) {
                const index = descriptionColumn.index;
                priorRow.cells[index] = [priorRow.cells[index], entry.cells[index]].filter(Boolean).join(' ');
                priorRow.source.continuationSources = [
                    ...(priorRow.source.continuationSources || []),
                    { page: page.page, row: entry.row },
                ];
                continue;
            }
            prior.rows.push({
                cells: entry.cells,
                source: { page: page.page, table: prior.source.table, row: entry.row },
            });
        }
        prior._lastPage = page.page;
    }
    return mergeContinuedPageTables(segments);
}

function detectionBounds(cell) {
    const points = cell?.boundingBox?.points;
    if (!Array.isArray(points) || points.length < 2) return null;
    const xs = points.map((point) => Number(point?.x)).filter(Number.isFinite);
    const ys = points.map((point) => Number(point?.y)).filter(Number.isFinite);
    if (!xs.length || !ys.length) return null;
    return {
        left: Math.min(...xs),
        right: Math.max(...xs),
        top: Math.min(...ys),
        bottom: Math.max(...ys),
    };
}

function mergeVisualLineIntoRow(target, line, descriptionIndex) {
    const collisions = [];
    for (let index = 0; index < line.cells.length; index++) {
        const value = String(line.cells[index] ?? '').trim();
        if (!value || index === descriptionIndex) continue;
        const current = String(target.cells[index] ?? '').trim();
        if (current && current !== value) collisions.push(index);
    }
    if (collisions.length) return false;

    for (let index = 0; index < line.cells.length; index++) {
        const value = String(line.cells[index] ?? '').trim();
        if (!value) continue;
        const current = String(target.cells[index] ?? '').trim();
        target.cells[index] = index === descriptionIndex
            ? [current, value].filter(Boolean).join(' ')
            : current || value;
    }
    target.source.continuationSources.push({
        page: line.source.page,
        row: line.source.row,
        cellBounds: line.source.cellBounds,
        rawOcrDetections: line.source.rawOcrDetections,
    });
    target.source.cellBounds.push(...line.source.cellBounds);
    target.source.rawOcrDetections.push(...line.source.rawOcrDetections);
    target.source.reviewWarnings.push(...(line.source.reviewWarnings || []));
    target.lastCenterY = line.centerY;
    target.maxCellHeight = Math.max(target.maxCellHeight, line.maxCellHeight);
    return true;
}


// ── Fragment attachment for vertically-centred scanned rows ───────────────
// In a scanned table the numeric cells are vertically centred in tall rows
// while the description wraps over many lines, so OCR emits description-only
// lines ABOVE the line that carries the row's S.No/quantity (e.g. a
// "Mechanical Means -" heading). Taken in reading order those lines look
// like a trailing continuation of the previous row. Decide by geometry:
// a fragment joins the neighbouring row whose cells (values + description) are
// vertically closest.
// Page furniture (seal/signature/"Page x of y" footers) is not table data
// and is dropped, never merged into an item.
const PAGE_FURNITURE_PATTERN = /(seal|si?ng?nature|executive\s+en|civil\s+contractor|page\s*\d*\s*of\s*\d+)/i;
const STAMP_PATTERN = /(contractor|dharwad|class|civil)/i; // short rubber-stamp text only

function unionBounds(cellBounds, column) {
    const boxes = (cellBounds || []).filter((cell) => cell.bounds && (column == null || cell.column === column)).map((cell) => cell.bounds);
    if (!boxes.length) return null;
    return {
        top: Math.min(...boxes.map((box) => box.top)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
    };
}

function verticalGap(a, b) {
    if (!a || !b) return Number.POSITIVE_INFINITY;
    return Math.max(0, a.top - b.bottom, b.top - a.bottom);
}

function attachFragmentLines(lines, columnMap) {
    const descriptionIndex = columnMap.description?.index;
    if (descriptionIndex == null) return { lines, discarded: [] };
    const identityIndexes = ['serialNumber', 'itemCode'].map((field) => columnMap[field]?.index).filter((index) => index != null);
    const measureIndexes = ['quantity', 'unit', 'rate', 'amount'].map((field) => columnMap[field]?.index).filter((index) => index != null);
    const filled = (cells, indexes) => indexes.some((index) => String(cells[index] ?? '').trim());
    // A row anchor carries a real identifier (S.No./code always has a digit) or
    // measures; alphabetic scraps in those columns are stamps/furniture.
    const hasIdentifier = (cells) => identityIndexes.some((index) => /\d/.test(String(cells[index] ?? '')));
    const isAnchor = (line) => hasIdentifier(line.cells) || filled(line.cells, measureIndexes);

    const anchorPositions = lines.map((line, index) => (isAnchor(line) ? index : -1)).filter((index) => index >= 0);
    if (!anchorPositions.length) return { lines, discarded: [] };

    const discarded = [];
    const leading = new Map(); // anchor line index -> fragment lines that precede it
    const dropped = new Set();
    lines.forEach((line, index) => {
        if (isAnchor(line)) return;
        const text = line.cells.map((cell) => String(cell ?? '').trim()).filter(Boolean).join(' ');
        if (!text) return;
        if (PAGE_FURNITURE_PATTERN.test(text) || (text.length <= 60 && STAMP_PATTERN.test(text))) {
            discarded.push({ text, source: line.source });
            dropped.add(index);
            return;
        }
        const prevAnchor = [...anchorPositions].reverse().find((position) => position < index);
        const nextAnchor = anchorPositions.find((position) => position > index);
        if (nextAnchor == null) return;
        let toNext = prevAnchor == null;
        if (!toNext) {
            const fragmentBox = unionBounds(line.source.cellBounds);
            const prevBox = unionBounds(lines[prevAnchor].source.cellBounds);
            const nextBox = unionBounds(lines[nextAnchor].source.cellBounds);
            toNext = verticalGap(fragmentBox, nextBox) < verticalGap(fragmentBox, prevBox);
        }
        if (toNext) {
            if (!leading.has(nextAnchor)) leading.set(nextAnchor, []);
            leading.get(nextAnchor).push(line);
            dropped.add(index);
        }
    });
    if (!dropped.size) return { lines, discarded };

    const output = [];
    lines.forEach((line, index) => {
        if (dropped.has(index)) return;
        const fragments = leading.get(index);
        if (!fragments?.length) { output.push(line); return; }
        const cells = [...line.cells];
        const cellBounds = [...line.source.cellBounds];
        const rawOcrDetections = [...line.source.rawOcrDetections];
        const reviewWarnings = [...(line.source.reviewWarnings || [])];
        for (const fragment of [...fragments].reverse()) {
            fragment.cells.forEach((value, column) => {
                const text = String(value ?? '').trim();
                if (!text) return;
                cells[column] = [text, String(cells[column] ?? '').trim()].filter(Boolean).join(' ');
            });
            cellBounds.unshift(...fragment.source.cellBounds);
            rawOcrDetections.unshift(...fragment.source.rawOcrDetections);
        }
        reviewWarnings.push('Description lines above the row values were attached to this row by geometry; verify row association.');
        output.push({ ...line, cells, source: { ...line.source, cellBounds, rawOcrDetections, reviewWarnings } });
    });
    return { lines: output, discarded };
}

function groupVisualLinesIntoSourceRows(lines, columnMap, pageNumber, tableNumber) {
    lines = attachFragmentLines(lines, columnMap).lines;
    const descriptionIndex = columnMap.description?.index;
    const identityIndexes = ['serialNumber', 'itemCode']
        .map((field) => columnMap[field]?.index)
        .filter((index) => index != null);
    const measureIndexes = ['quantity', 'unit', 'rate', 'amount']
        .map((field) => columnMap[field]?.index)
        .filter((index) => index != null);
    const output = [];
    const populated = (cells) => cells
        .map((value, index) => String(value ?? '').trim() ? index : -1)
        .filter((index) => index >= 0);
    const hasValue = (cells, indexes) => indexes.some((index) => String(cells[index] ?? '').trim());

    for (const line of lines) {
        const indexes = populated(line.cells);
        if (!indexes.length && !(line.source.rawOcrDetections || []).length) continue;
        const hasIdentity = hasValue(line.cells, identityIndexes);
        const hasDescription = descriptionIndex != null && Boolean(String(line.cells[descriptionIndex] ?? '').trim());
        const hasMeasure = hasValue(line.cells, measureIndexes);
        const prior = output[output.length - 1];
        const verticalGap = prior ? line.centerY - prior.lastCenterY : Number.POSITIVE_INFINITY;
        const closeBaseline = prior && verticalGap <= Math.max(12, prior.maxCellHeight * 1.75);
        let continuation = false;

        if (prior && !hasIdentity && String(prior.cells[descriptionIndex] ?? '').trim()) {
            const priorHasMeasure = hasValue(prior.cells, measureIndexes);
            if (!hasDescription && hasMeasure) {
                continuation = !measureIndexes.some((index) =>
                    String(line.cells[index] ?? '').trim() && String(prior.cells[index] ?? '').trim()
                );
            } else if (hasDescription && !hasMeasure) {
                continuation = true;
                if (continuation && priorHasMeasure) {
                    prior.source.reviewWarnings.push('Description continuation has no row identifier after source values; verify visual row association.');
                }
            } else if (hasDescription && hasMeasure && closeBaseline) {
                continuation = true;
            } else if (hasDescription && hasMeasure && !closeBaseline && !priorHasMeasure) {
                const warning = 'Adjacent visual lines could be one wrapped source row or two items; verify row association.';
                prior.source.reviewWarnings.push(warning);
                line.source.reviewWarnings.push(warning);
            }
        }

        if (continuation) {
            if (mergeVisualLineIntoRow(prior, line, descriptionIndex)) continue;
            const warning = 'Visual continuation conflicts with populated source columns; row association requires review.';
            prior.source.reviewWarnings.push(warning);
            line.source.reviewWarnings.push(warning);
        }
        const reviewWarnings = [...(line.source.reviewWarnings || [])];
        if (!hasDescription) reviewWarnings.push('Visual source row has no detected description; verify OCR alignment.');
        if (!line.source.cellBounds.length) reviewWarnings.push('Visual source row has no positioned OCR detections.');
        const source = {
            ...line.source,
            page: pageNumber,
            table: tableNumber,
            continuationSources: [],
            reviewWarnings,
        };
        output.push({
            cells: line.cells,
            source,
            centerY: line.centerY,
            lastCenterY: line.centerY,
            maxCellHeight: line.maxCellHeight,
        });
    }
    return output.map(({ cells, source }) => ({ cells, source }));
}


// ── Header repair for scanned multi-page tables ───────────────────────────
// A scanned table repeats the same header (same column x-positions, within
// scan skew) on every page, but OCR reads each page's header differently:
// one page drops "Unit", another garbles "Item Name" or loses "S.No.". Column
// boundaries are derived ONLY from the header cells found, so a missing
// header shifts every column to its right by one (unit lands in quantity,
// quantity in rate, ...). We therefore pick the most complete header in the
// document as a reference and re-align incomplete page headers to it.
function headerAnchorsFromCells(headerCells) {
    const headers = (headerCells || []).map((cell) => String(cell?.text ?? '').trim());
    if (!isHeaderRow(headers)) return null;
    const anchors = (headerCells || []).map((cell, index) => ({
        index,
        text: headers[index],
        bounds: detectionBounds(cell),
    })).filter((cell) => cell.text && cell.bounds);
    if (anchors.length < 2 || anchors.length !== headers.filter(Boolean).length) return null;
    return anchors.sort((a, b) => a.bounds.left - b.bounds.left);
}

function findReferenceHeaderAnchors(pages) {
    let best = null;
    let bestScore = 0;
    for (const page of pages || []) {
        for (const row of page.rows || []) {
            const anchors = headerAnchorsFromCells(row);
            if (!anchors) continue;
            const mapped = Object.keys(mapHeaders(anchors.map((anchor) => anchor.text)).columns).length;
            const score = anchors.length * 10 + mapped;
            if (score > bestScore) { best = anchors; bestScore = score; }
        }
    }
    return best;
}

const HEADER_MATCH_MAX_DISTANCE = 0.04; // normalized page width

function repairHeaderAnchors(anchors, reference) {
    if (!reference || anchors.length >= reference.length) return anchors;
    const center = (anchor) => (anchor.bounds.left + anchor.bounds.right) / 2;
    const used = new Set();
    const matches = [];
    for (const anchor of anchors) {
        let bestIndex = -1;
        let bestDistance = Infinity;
        reference.forEach((ref, index) => {
            if (used.has(index)) return;
            const distance = Math.abs(center(ref) - center(anchor));
            if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
        });
        // Every page header must map to a distinct reference column, or this
        // is a different table and we leave it alone.
        if (bestIndex < 0 || bestDistance > HEADER_MATCH_MAX_DISTANCE) return anchors;
        // A header OCR recognised as one field must not be matched to a
        // reference column of another field (garbled/unrecognised ones may).
        const pageField = Object.keys(mapHeaders([anchor.text]).columns)[0];
        const refField = Object.keys(mapHeaders([reference[bestIndex].text]).columns)[0];
        if (pageField && refField && pageField !== refField) return anchors;
        used.add(bestIndex);
        matches.push({ anchor, ref: reference[bestIndex], refIndex: bestIndex });
    }
    for (let i = 1; i < matches.length; i++) {
        if (matches[i].refIndex <= matches[i - 1].refIndex) return anchors;
    }
    if (matches.length < 2) return anchors;
    // Fit page_x = scale * ref_x + offset (scan shift/zoom) to project the
    // reference columns that this page's OCR dropped.
    const xs = matches.map((m) => center(m.ref));
    const ys = matches.map((m) => center(m.anchor));
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
    const varX = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
    let scale = varX > 1e-9 ? xs.reduce((sum, x, i) => sum + (x - meanX) * (ys[i] - meanY), 0) / varX : 1;
    if (!(scale > 0.8 && scale < 1.25)) scale = 1;
    const offset = meanY - scale * meanX;
    const matchedByRef = new Map(matches.map((m) => [m.refIndex, m.anchor]));
    return reference.map((ref, index) => {
        const matched = matchedByRef.get(index);
        if (matched) return { ...matched, text: ref.text };
        const width = (ref.bounds.right - ref.bounds.left) * scale;
        const mid = scale * center(ref) + offset;
        return {
            index: -1,
            text: ref.text,
            inferred: true,
            bounds: { left: mid - width / 2, right: mid + width / 2, top: ref.bounds.top, bottom: ref.bounds.bottom },
        };
    });
}

// Digit-free text with two or more real words ("Mechanical Means-") is prose,
// not an S.No./Item Code ("16.28.1", "PWD SR V5 Page No.201 Item No 16.40").
// Four or more real words is a sentence regardless of digits.
function looksLikeProse(text) {
    const value = String(text ?? '');
    const words = (value.match(/[A-Za-z]{4,}/g) || []).length;
    if (words >= 4) return true; // a sentence, even one with measurements in it
    if (/\d/.test(value)) return false;
    return words >= 2;
}

function reconstructTablesFromLayoutPages(pages) {
    const pageTables = [];
    const referenceAnchors = findReferenceHeaderAnchors(pages);
    for (const page of pages || []) {
        const rows = page.rows || [];
        let cursor = 0;
        let pageTableNumber = 0;
        while (cursor < rows.length) {
            const headerCells = rows[cursor] || [];
            const headers = headerCells.map((cell) => String(cell.text ?? '').trim());
            if (!isHeaderRow(headers)) {
                cursor++;
                continue;
            }

            let anchors = headerCells.map((cell, index) => ({
                index,
                text: headers[index],
                bounds: detectionBounds(cell),
            })).filter((cell) => cell.text && cell.bounds);
            if (anchors.length < 2 || anchors.length !== headers.filter(Boolean).length) {
                cursor++;
                continue;
            }
            anchors.sort((a, b) => a.bounds.left - b.bounds.left);
            anchors = repairHeaderAnchors(anchors, referenceAnchors);
            const orderedHeaders = anchors.map((anchor) => anchor.text);
            const headerMap = mapHeaders(orderedHeaders);
            const boundaries = anchors.slice(1).map((anchor, index) => {
                const prior = anchors[index].bounds;
                const next = anchor.bounds;
                return prior.right <= next.left
                    ? (prior.right + next.left) / 2
                    : (prior.left + prior.right + next.left + next.right) / 4;
            });
            const visualLines = [];
            let end = cursor + 1;
            for (; end < rows.length; end++) {
                const visualRow = rows[end] || [];
                const rowHeaders = visualRow.map((cell) => String(cell.text ?? '').trim());
                if (isHeaderRow(rowHeaders)) break;
                const values = Array(orderedHeaders.length).fill('');
                const cellBounds = [];
                const rawOcrDetections = [];
                const reviewWarnings = [];
                let centerTotal = 0;
                let centerCount = 0;
                let maxCellHeight = 0;
                for (const cell of visualRow) {
                    const text = String(cell.text ?? '').trim();
                    if (!text) continue;
                    const bounds = detectionBounds(cell);
                    const rawEvidence = {
                        text,
                        boundingBox: cell.boundingBox || null,
                        confidence: cell.confidence ?? null,
                    };
                    if (!bounds) {
                        rawOcrDetections.push({ ...rawEvidence, column: null });
                        reviewWarnings.push('OCR detection has no usable bounding box; verify its source column.');
                        continue;
                    }
                    const column = boundaries.findIndex((boundary) => bounds.left < boundary);
                    let columnIndex = column < 0 ? anchors.length - 1 : column;
                    // Column boundaries sit midway between header TEXTS, but a
                    // left-aligned description starts left of that midpoint and
                    // would be read as an S.No./Item Code. Identifiers carry
                    // digits or are short tokens; digit-free multi-word prose is
                    // description text (or page furniture) wherever it landed.
                    const descriptionColumn = headerMap.columns.description?.index;
                    const identityColumns = ['serialNumber', 'itemCode'].map((field) => headerMap.columns[field]?.index);
                    if (descriptionColumn != null && identityColumns.includes(columnIndex) && looksLikeProse(text)) {
                        columnIndex = descriptionColumn;
                    }
                    values[columnIndex] = [values[columnIndex], text].filter(Boolean).join(' ');
                    const y = (bounds.top + bounds.bottom) / 2;
                    centerTotal += y;
                    centerCount++;
                    maxCellHeight = Math.max(maxCellHeight, bounds.bottom - bounds.top);
                    cellBounds.push({
                        column: columnIndex + 1,
                        ...rawEvidence,
                        bounds,
                    });
                    rawOcrDetections.push({ ...rawEvidence, column: columnIndex + 1 });
                }
                if (!cellBounds.length && !rawOcrDetections.length) continue;
                visualLines.push({
                    cells: values,
                    centerY: centerCount ? centerTotal / centerCount : end,
                    maxCellHeight,
                    source: {
                        page: page.page,
                        row: end + 1,
                        cellBounds,
                        rawOcrDetections,
                        reviewWarnings,
                    },
                });
            }

            pageTableNumber++;
            const tableNumber = pageTableNumber;
            const logicalRows = groupVisualLinesIntoSourceRows(visualLines, headerMap.columns, page.page, tableNumber);
            pageTables.push({
                headers: orderedHeaders,
                headerRow: cursor + 1,
                columnMap: headerMap.columns,
                ambiguousHeaders: headerMap.ambiguous,
                unmappedHeaders: headerMap.unmapped,
                source: { page: page.page, table: tableNumber },
                pageWidth: page.width || null,
                pageHeight: page.height || null,
                rows: logicalRows,
            });
            cursor = Math.max(end, cursor + 1);
        }
    }
    return mergeContinuedPageTables(pageTables);
}

function debugSourceRows(table) {
    const headers = table?.headers || [];
    return (table?.rows || []).map((row) => {
        const source = row.source || {};
        const serialColumn = table.columnMap?.serialNumber?.index;
        const itemCodeColumn = table.columnMap?.itemCode?.index;
        const sourceId = (serialColumn != null && row.cells[serialColumn])
            || (itemCodeColumn != null && row.cells[itemCodeColumn])
            || source.row
            || '?';
        const fields = headers.map((header, index) => `${header || `Column ${index + 1}`}: ${String(row.cells[index] ?? '').trim()}`);
        const boxes = (source.cellBounds || []).map((cell) => {
            const bounds = cell.bounds || detectionBounds({ boundingBox: cell.boundingBox });
            return bounds
                ? `col ${cell.column} "${cell.text}" x=${bounds.left}-${bounds.right} y=${bounds.top}-${bounds.bottom}`
                : `col ${cell.column} "${cell.text}" (no bounds)`;
        });
            const rawDetections = (source.rawOcrDetections || []).map((cell) => {
                const bounds = cell.bounds || detectionBounds({ boundingBox: cell.boundingBox });
                return bounds
                ? `col ${cell.column ?? 'unassigned'} "${cell.text}" x=${bounds.left}-${bounds.right} y=${bounds.top}-${bounds.bottom}`
                : `col unassigned "${cell.text}" (no bounds)`;
            });
        return [
            `SOURCE ROW ${sourceId}`,
            ...fields,
            `Source page: ${source.page ?? 'unknown'}; source row: ${source.row ?? 'unknown'}`,
            `Bounding boxes: ${boxes.join('; ') || 'none'}`,
            `Raw OCR detections: ${rawDetections.join('; ') || 'none'}`,
            ...(source.reviewWarnings?.length ? [`Review: ${source.reviewWarnings.join('; ')}`] : []),
        ].join('\n');
    });
}

function findVisualTablePages(pages) {
    const candidates = [];
    const headerPages = [];
    for (const page of pages || []) {
        const text = String(page.text || '');
        const normalized = normalizeHeader(text);
        const signalFields = Object.entries(NORMALIZED_ALIASES)
            .filter(([field]) => ['serialNumber', 'itemCode', 'description', 'quantity', 'unit'].includes(field))
            .filter(([, aliases]) => [...aliases].some((alias) =>
                new RegExp(`(?:^| )${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: |$)`).test(normalized)
            ));
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const separatedRows = lines.filter((line) => (line.match(/\t/g) || []).length >= 2).length;
        const numericRows = lines.filter((line) => (line.match(/\b\d+(?:[.,]\d+)?\b/g) || []).length >= 2).length;
        if (signalFields.length >= 2 || separatedRows >= 2 || numericRows >= 2) {
            candidates.push(page.page);
        }
        if (signalFields.length >= 2) headerPages.push(page.page);
    }
    if (!candidates.length) return (pages || []).map((page) => page.page);
    const selected = new Set(candidates);
    for (const headerPage of headerPages) {
        const nextPage = (pages || []).find((page) => page.page > headerPage);
        if (nextPage) selected.add(nextPage.page);
    }
    return (pages || []).map((page) => page.page).filter((page) => selected.has(page));
}

function createDocument({ filename = '', fileExt = '', rawText = '', metadata = {}, pages = [], sheets = [], tables = [] } = {}) {
    return {
        metadata: { filename, fileExt, ...metadata },
        pages,
        sheets,
        tables,
        rawText: String(rawText || ''),
    };
}

function cellValue(row, column) {
    if (!column) return undefined;
    if (Array.isArray(row)) return row[column.index];
    if (row && Object.prototype.hasOwnProperty.call(row, column.header)) return row[column.header];
    return undefined;
}

function nonEmptyString(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function parseSourceQuantity(value) {
    const raw = nonEmptyString(value);
    if (!raw) return null;
    const normalized = raw.replace(/,/g, '');
    if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
}

function lineItemFromRow({ headers = [], row = [], source = {}, filename = '', headerMap = mapHeaders(headers) } = {}) {
    const { columns } = headerMap;
    const sourceValues = {};
    const sourceCells = [];
    for (let index = 0; index < headers.length; index++) {
        const header = String(headers[index] ?? '').trim();
        const value = cellValue(row, { index, header }) ?? '';
        const cellEvidence = source.cellBounds?.find((cell) => cell.column === index + 1);
        sourceCells.push({
            column: index + 1,
            header,
            value,
            boundingBox: cellEvidence?.boundingBox || null,
            confidence: cellEvidence?.confidence ?? null,
        });
        if (header) sourceValues[header] = value;
    }

    const quantityRaw = cellValue(row, columns.quantity);
    const quantityColumnPresent = Boolean(columns.quantity);
    const unitColumnPresent = Boolean(columns.unit);
    const rawDescription = cellValue(row, columns.description);
    const description = nonEmptyString(rawDescription);
    const serialNumber = nonEmptyString(cellValue(row, columns.serialNumber));
    const itemCode = nonEmptyString(cellValue(row, columns.itemCode));
    const product = nonEmptyString(cellValue(row, columns.product));
    const unit = nonEmptyString(cellValue(row, columns.unit));
    const sourceRow = source.row ?? '';
    const sourcePage = source.page ?? null;
    const sourceTable = source.table ?? null;
    const lineItemId = [filename || 'document', source.sheet || '', sourcePage ?? '', sourceTable ?? '', sourceRow].join(':');
    const warnings = [];
    const quantity = quantityColumnPresent ? parseSourceQuantity(quantityRaw) : null;

    warnings.push(...(Array.isArray(source.reviewWarnings) ? source.reviewWarnings : []));

    if (quantity === null) warnings.push('Quantity could not be determined from source.');
    if (!unit) warnings.push('Unit could not be determined from source.');
    for (const [field, matches] of Object.entries(headerMap.ambiguous || {})) {
        warnings.push(`Multiple possible ${field} columns found: ${matches.map((match) => match.header).join(', ')}`);
    }

    return {
        lineItemId,
        serialNumber: serialNumber || null,
        itemCode: itemCode || null,
        product: product || null,
        description: description || null,
        size: nonEmptyString(cellValue(row, columns.size)) || null,
        specification: nonEmptyString(cellValue(row, columns.specification)) || null,
        quantity,
        unit: unit || null,
        application: nonEmptyString(cellValue(row, columns.application)) || null,
        remarks: nonEmptyString(cellValue(row, columns.remarks)) || null,
        notes: nonEmptyString(cellValue(row, columns.remarks)) || '',
        sourceValues,
        sourceCells,
        provenance: {
            document: filename || null,
            page: sourcePage,
            sheet: source.sheet || null,
            table: sourceTable,
            row: sourceRow || null,
            continuationSources: source.continuationSources || [],
            cellBounds: source.cellBounds || [],
            rawOcrDetections: source.rawOcrDetections || [],
            reviewWarnings: source.reviewWarnings || [],
            columns: Object.fromEntries(Object.entries(columns).map(([field, column]) => [field, column.header])),
            ambiguousColumns: headerMap.ambiguous || {},
        },
        confidence: {},
        warnings,
        _sourceColumns: { quantity: quantityColumnPresent, unit: unitColumnPresent },
    };
}

function mergeDerivedFields(sourceItem, derived = {}) {
    const item = { ...sourceItem };
    for (const field of ['product', 'size', 'specification', 'application', 'remarks']) {
        if (!item[field] && derived[field] !== undefined && derived[field] !== null) {
            item[field] = nonEmptyString(derived[field]) || null;
        }
    }
    item.confidence = { ...(item.confidence || {}), ...(derived.confidence || {}) };
    item.warnings = [...new Set([...(item.warnings || []), ...(Array.isArray(derived.warnings) ? derived.warnings : [])])];
    item.notes = item.notes || item.remarks || nonEmptyString(derived.notes);
    // A mapped source column is authoritative even when its cell is blank.
    // Never let an AI inference replace source-backed procurement values.
    if (!item._sourceColumns?.quantity && item.quantity == null) item.quantity = null;
    if (!item._sourceColumns?.unit && item.unit == null) item.unit = null;
    delete item._sourceColumns;
    return item;
}

module.exports = {
    HEADER_ALIASES,
    normalizeHeader,
    mapHeaders,
    isHeaderRow,
    extractTablesFromMatrix,
    mergeContinuedPageTables,
    extractTablesAcrossPages,
    reconstructTablesFromLayoutPages,
    debugSourceRows,
    findVisualTablePages,
    createDocument,
    lineItemFromRow,
    mergeDerivedFields,
    parseSourceQuantity,
};
