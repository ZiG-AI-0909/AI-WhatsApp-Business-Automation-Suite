// Shows the pages of a SCANNED PDF in the browser, without a PDF library.
//
// Scanned BOQs are pictures: each page draws one or two images (a colour
// JPEG and, on office scanners, a sharp black text layer in CCITT G4).
// This reads the PDF objects, follows each page's drawing commands for
// images only (q / Q / cm / g / rg / k / Do) and paints them onto a canvas.
// Text-based PDFs (no page images) and unusual encodings report the page as
// unavailable; the Check screen then shows the page number instead.
// Nothing is uploaded: the file never leaves the browser.

import { decodeG4 } from './ccittG4.js'

const latin1 = new TextDecoder('iso-8859-1')

function indexObjects(text) {
  const objects = new Map()
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g
  let match
  while ((match = pattern.exec(text))) {
    const start = match.index + match[0].length
    const end = text.indexOf('endobj', start)
    if (end < 0) break
    objects.set(Number(match[1]), { start, end }) // a later revision wins
    pattern.lastIndex = end
  }
  return objects
}

function bodyOf(doc, number) {
  const entry = doc.objects.get(number)
  return entry ? doc.text.slice(entry.start, entry.end) : ''
}

function dictOf(doc, number) {
  const body = bodyOf(doc, number)
  const stream = body.search(/\bstream\r?\n/)
  return stream >= 0 ? body.slice(0, stream) : body
}

// Value after a key: { ref } | { dict } | { array } | { plain }.
function valueOf(dict, key) {
  const at = dict.search(new RegExp(`/${key}(?![A-Za-z0-9])`))
  if (at < 0) return null
  const rest = dict.slice(at + key.length + 1).trimStart()
  const ref = rest.match(/^(\d+)\s+\d+\s+R/)
  if (ref) return { ref: Number(ref[1]) }
  if (rest.startsWith('<<')) {
    let depth = 0
    for (let i = 0; i < rest.length - 1; i++) {
      if (rest[i] === '<' && rest[i + 1] === '<') { depth++; i++ } else if (rest[i] === '>' && rest[i + 1] === '>') {
        depth--; i++
        if (depth === 0) return { dict: rest.slice(0, i + 1) }
      }
    }
    return null
  }
  const array = rest.match(/^\[([^\]]*)\]/)
  if (array) return { array: array[1] }
  const plain = rest.match(/^[^\s/>\]]+|^\/[^\s/>\]]+/)
  return plain ? { plain: plain[0] } : null
}

function resolveDict(doc, value) {
  if (!value) return ''
  if (value.dict) return value.dict
  if (value.ref) return dictOf(doc, value.ref)
  return ''
}

function resolveArray(doc, value) {
  if (!value) return null
  if (value.array !== undefined) return value.array
  if (value.ref) {
    const text = bodyOf(doc, value.ref).trim()
    const array = text.match(/^\[([^\]]*)\]/)
    return array ? array[1] : null
  }
  return null
}

function inherited(doc, pageNumber, key) {
  let number = pageNumber
  for (let depth = 0; depth < 12 && number; depth++) {
    const dict = dictOf(doc, number)
    const value = valueOf(dict, key)
    if (value) return value
    number = valueOf(dict, 'Parent')?.ref
  }
  return null
}

function pageOrder(doc) {
  const roots = []
  for (const number of doc.objects.keys()) {
    const dict = dictOf(doc, number)
    if (/\/Type\s*\/Pages\b/.test(dict) && !/\/Parent\s+\d+/.test(dict)) roots.push(number)
  }
  const pages = []
  const seen = new Set()
  const walk = (number) => {
    if (seen.has(number) || pages.length > 2000) return
    seen.add(number)
    const dict = dictOf(doc, number)
    if (/\/Type\s*\/Pages\b/.test(dict)) {
      for (const ref of (resolveArray(doc, valueOf(dict, 'Kids')) || '').matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(ref[1]))
    } else if (/\/Type\s*\/Page\b/.test(dict)) {
      pages.push(number)
    }
  }
  roots.forEach(walk)
  return pages
}

function rawStream(doc, number) {
  const entry = doc.objects.get(number)
  const body = doc.text.slice(entry.start, entry.end)
  const marker = body.match(/\bstream\r?\n/)
  if (!marker) return null
  const start = entry.start + marker.index + marker[0].length
  const dict = body.slice(0, marker.index)
  const lengthValue = valueOf(dict, 'Length')
  let length = Number(lengthValue?.plain)
  if (lengthValue?.ref) length = Number(bodyOf(doc, lengthValue.ref).trim())
  if (!Number.isFinite(length) || length <= 0) length = doc.text.indexOf('endstream', start) - start
  return { dict, bytes: doc.bytes.subarray(start, start + length) }
}

function filtersOf(dict) {
  const value = valueOf(dict, 'Filter')
  if (!value) return []
  const text = value.array ?? value.plain ?? ''
  return [...text.matchAll(/\/([A-Za-z0-9]+)/g)].map((match) => match[1])
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// ── Content stream: only what scanned pages use ─────────────────
function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ]
}

function imageCalls(content) {
  const calls = []
  const stack = []
  let state = { ctm: [1, 0, 0, 1, 0, 0], fill: [0, 0, 0] }
  let operands = []
  const tokens = content.match(/\/[^\s/[\]<>()]+|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'"*]+/g) || []
  for (const token of tokens) {
    if (/^[-+]?(?:\d|\.)/.test(token) || token.startsWith('/')) { operands.push(token); continue }
    const nums = operands.map(Number)
    switch (token) {
      case 'q': stack.push({ ctm: [...state.ctm], fill: [...state.fill] }); break
      case 'Q': state = stack.pop() || state; break
      case 'cm': if (nums.length >= 6) state.ctm = multiply(nums.slice(-6), state.ctm); break
      case 'g': state.fill = [nums.at(-1), nums.at(-1), nums.at(-1)]; break
      case 'rg': state.fill = nums.slice(-3); break
      case 'k': { const [c, m, y, k] = nums.slice(-4); state.fill = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]; break }
      case 'Do': calls.push({ name: operands.at(-1)?.slice(1), ctm: [...state.ctm], fill: [...state.fill] }); break
      default: break
    }
    operands = []
  }
  return calls
}

async function decodeImage(doc, number) {
  const stream = rawStream(doc, number)
  if (!stream) return null
  const { dict } = stream
  const width = Number(valueOf(dict, 'Width')?.plain) || 0
  const height = Number(valueOf(dict, 'Height')?.plain) || 0
  const isMask = /\/ImageMask\s+true/.test(dict)
  let bytes = stream.bytes
  for (const filter of filtersOf(dict)) {
    if (filter === 'FlateDecode' || filter === 'Fl') {
      bytes = await inflate(bytes)
    } else if (filter === 'DCTDecode' || filter === 'DCT') {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
      return { kind: 'bitmap', bitmap, width, height }
    } else if (filter === 'CCITTFaxDecode' || filter === 'CCF') {
      const parms = resolveDict(doc, valueOf(dict, 'DecodeParms'))
      const k = Number(valueOf(parms, 'K')?.plain ?? 0)
      if (k >= 0) return null // Group 3 is rare in scans; not supported here
      const columns = Number(valueOf(parms, 'Columns')?.plain) || width || 1728
      const rows = Number(valueOf(parms, 'Rows')?.plain) || height
      const blackIs1 = /\/BlackIs1\s+true/.test(parms)
      const decodeInverted = /\/Decode\s*\[\s*1\s+0\s*\]/.test(dict)
      const black = decodeG4(bytes, columns, rows)
      return { kind: 'bits', black, width: columns, height: rows, isMask, paintBlack: !(blackIs1 !== decodeInverted) }
    } else {
      return null
    }
  }
  return null // raw pixel images are not used by scanners for whole pages
}

function bitsToCanvas(image, fill) {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  const pixels = context.createImageData(image.width, image.height)
  const data = pixels.data
  const [r, g, b] = fill.map((value) => Math.round(Math.max(0, Math.min(1, value)) * 255))
  for (let i = 0; i < image.black.length; i++) {
    const painted = image.black[i] === (image.paintBlack ? 1 : 0)
    const o = i * 4
    if (image.isMask) {
      if (painted) { data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255 }
    } else {
      const value = painted ? 0 : 255
      data[o] = value; data[o + 1] = value; data[o + 2] = value; data[o + 3] = 255
    }
  }
  context.putImageData(pixels, 0, 0)
  return canvas
}

async function renderPage(doc, pageNumber, targetWidth) {
  const box = (resolveArray(doc, inherited(doc, pageNumber, 'MediaBox')) || '0 0 612 792').trim().split(/\s+/).map(Number)
  const [x0, y0, x1, y1] = box
  const pageWidth = x1 - x0
  const pageHeight = y1 - y0
  const rotate = Number(inherited(doc, pageNumber, 'Rotate')?.plain) || 0
  if (!(pageWidth > 0 && pageHeight > 0) || rotate % 360 !== 0) return null

  const resources = resolveDict(doc, inherited(doc, pageNumber, 'Resources'))
  const xobjects = resolveDict(doc, valueOf(resources, 'XObject'))
  const names = new Map([...xobjects.matchAll(/\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g)].map((match) => [match[1], Number(match[2])]))
  const contentValue = valueOf(dictOf(doc, pageNumber), 'Contents')
  const contentRefs = contentValue?.ref ? [contentValue.ref] : [...(contentValue?.array || '').matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]))
  let content = ''
  for (const ref of contentRefs) {
    const stream = rawStream(doc, ref)
    if (!stream) continue
    let bytes = stream.bytes
    if (filtersOf(stream.dict).some((filter) => filter === 'FlateDecode' || filter === 'Fl')) bytes = await inflate(bytes)
    content += `\n${latin1.decode(bytes)}`
  }
  const calls = imageCalls(content).filter((call) => names.has(call.name))
  if (!calls.length) return null

  const scale = targetWidth / pageWidth
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(pageWidth * scale)
  canvas.height = Math.round(pageHeight * scale)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  let drawn = 0
  for (const call of calls) {
    const number = names.get(call.name)
    if (!/\/Subtype\s*\/Image/.test(dictOf(doc, number))) continue
    const image = await decodeImage(doc, number)
    if (!image) continue
    const source = image.kind === 'bitmap' ? image.bitmap : bitsToCanvas(image, call.fill)
    // PDF space (y up, origin bottom-left) -> canvas; image row 0 is the top.
    context.setTransform(scale, 0, 0, -scale, -x0 * scale, y1 * scale)
    context.transform(...call.ctm)
    context.transform(1, 0, 0, -1, 0, 1)
    context.drawImage(source, 0, 0, 1, 1)
    context.setTransform(1, 0, 0, 1, 0, 0)
    if (image.kind === 'bitmap') image.bitmap.close?.()
    drawn++
  }
  if (!drawn) return null
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) return null
  return { url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height }
}

/**
 * Open a PDF File/Blob. Returns { pageCount, render(page) → Promise<{ url,
 * width, height } | null>, close() }. Pages render lazily and are cached.
 */
export async function openScan(file, { targetWidth = 2000 } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const text = latin1.decode(bytes)
  if (!text.startsWith('%PDF')) return null
  const doc = { bytes, text, objects: indexObjects(text) }
  const order = pageOrder(doc)
  const cache = new Map()
  return {
    pageCount: order.length,
    render(page) {
      if (!cache.has(page)) {
        const number = order[page - 1]
        cache.set(page, number ? renderPage(doc, number, targetWidth).catch(() => null) : Promise.resolve(null))
      }
      return cache.get(page)
    },
    close() {
      for (const pending of cache.values()) pending.then((result) => result && URL.revokeObjectURL(result.url))
      cache.clear()
    },
  }
}
