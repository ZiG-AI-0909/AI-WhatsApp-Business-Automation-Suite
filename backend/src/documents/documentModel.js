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

function groupVisualLinesIntoSourceRows(lines, columnMap, pageNumber, tableNumber) {
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

function reconstructTablesFromLayoutPages(pages) {
    const pageTables = [];
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

            const anchors = headerCells.map((cell, index) => ({
                index,
                text: headers[index],
                bounds: detectionBounds(cell),
            })).filter((cell) => cell.text && cell.bounds);
            if (anchors.length < 2 || anchors.length !== headers.filter(Boolean).length) {
                cursor++;
                continue;
            }
            anchors.sort((a, b) => a.bounds.left - b.bounds.left);
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
                    const columnIndex = column < 0 ? anchors.length - 1 : column;
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
