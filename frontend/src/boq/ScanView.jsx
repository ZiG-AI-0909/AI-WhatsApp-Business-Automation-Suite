import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { pageOf, rowBounds } from './boqReview.js'

const MIN_CROP_PX = 120 // the scan strip is never shorter than this

function cropFor(bounds, image, containerWidth, mode) {
  if (!bounds) return { left: 0, top: 0, width: 1, height: Math.min(1, (image.width / image.height) * 0.6) }
  const padX = mode === 'row' ? 0 : 0.02
  let left = mode === 'row' ? 0.01 : Math.max(0, bounds.left - padX)
  let right = mode === 'row' ? 0.99 : Math.min(1, bounds.right + padX)
  let top = Math.max(0, bounds.top - 0.012)
  let bottom = Math.min(1, bounds.bottom + 0.012)
  const width = right - left
  // Keep the strip readable: at least MIN_CROP_PX tall on screen.
  const scale = containerWidth / (width * image.width)
  const minHeight = MIN_CROP_PX / (scale * image.height)
  if (bottom - top < minHeight) {
    const centre = (top + bottom) / 2
    top = Math.max(0, centre - minHeight / 2)
    bottom = Math.min(1, top + minHeight)
    top = Math.max(0, bottom - minHeight)
  }
  left = Math.max(0, left)
  right = Math.min(1, right)
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * The scanned page next to a row: a crop around the row's numbers (or the
 * whole row / whole page), with the row outlined. Falls back to the page
 * number and a plain note when the scan is not available.
 */
export default function ScanView({ item, scan, isPdf, onAttach, tone = 'neutral' }) {
  const [rendered, setRendered] = useState({ scan: null, page: null, image: null })
  const [mode, setMode] = useState('numbers')
  const [width, setWidth] = useState(480)
  const boxRef = useRef(null)
  const pageScrollRef = useRef(null)
  const page = pageOf(item)

  useEffect(() => {
    if (!scan || !page) return undefined
    let cancelled = false
    scan.render(page).then((result) => {
      if (!cancelled) setRendered({ scan, page, image: result })
    })
    return () => { cancelled = true }
  }, [scan, page])
  const ready = rendered.scan === scan && rendered.page === page
  const image = ready ? rendered.image : null
  const loading = Boolean(scan && page) && !ready

  useLayoutEffect(() => {
    const node = boxRef.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(200, Math.round(entry.contentRect.width))))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const numberBounds = rowBounds(item, { numbersOnly: true })
  const fullBounds = rowBounds(item)
  const activeMode = mode === 'numbers' && !numberBounds ? 'row' : mode
  const bounds = activeMode === 'numbers' ? numberBounds : fullBounds

  const rowTop = fullBounds ? fullBounds.top : null
  useEffect(() => {
    if (activeMode !== 'page' || !pageScrollRef.current || rowTop === null || !image) return
    const node = pageScrollRef.current
    node.scrollTop = Math.max(0, rowTop * node.scrollHeight - node.clientHeight / 3)
  }, [activeMode, image, rowTop])

  const pageLabel = page ? `page ${page}` : 'the page'

  let body
  if (!page) {
    body = <p className="scan-note"><Icon name="info" size={16} /> We do not know which page this row came from. Compare it with your BOQ by its S.No.</p>
  } else if (!scan) {
    body = isPdf ? (
      <div className="scan-note">
        <p><Icon name="file" size={16} /> This row is on <strong>{pageLabel}</strong> of the scan. The scan is not open here.</p>
        <label className="secondary-btn upload-btn scan-attach">
          <Icon name="eye" size={16} /> Show the scan here
          <input type="file" accept=".pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) onAttach?.(file); event.target.value = '' }} />
        </label>
        <small>Choose the same PDF from your computer. It stays on your computer and is not uploaded again.</small>
      </div>
    ) : (
      <p className="scan-note"><Icon name="file" size={16} /> This BOQ came from a {item?.provenance?.sheet ? `spreadsheet (sheet "${item.provenance.sheet}", row ${item.provenance.row ?? '?'})` : 'text file'}. Compare the numbers with your file.</p>
    )
  } else if (loading) {
    body = <div className="scan-loading skeleton" role="status"><span className="visually-hidden">Loading {pageLabel} of the scan</span></div>
  } else if (!image) {
    body = <p className="scan-note"><Icon name="info" size={16} /> We could not show {pageLabel} of this PDF here. Open the PDF on your computer and go to {pageLabel}.</p>
  } else if (activeMode === 'page') {
    body = (
      <div className="scan-page" ref={pageScrollRef} tabIndex={0} aria-label={`Scan, ${pageLabel}`}>
        <div className="scan-page-inner">
          <img src={image.url} alt={`Scanned ${pageLabel}`} />
          {fullBounds && <span className={`scan-mark tone-${tone}`} style={{ left: `${fullBounds.left * 100}%`, top: `${fullBounds.top * 100}%`, width: `${(fullBounds.right - fullBounds.left) * 100}%`, height: `${(fullBounds.bottom - fullBounds.top) * 100}%` }} aria-hidden="true" />}
        </div>
      </div>
    )
  } else {
    const crop = cropFor(bounds, image, width, activeMode)
    const ratio = (crop.width * image.width) / (crop.height * image.height)
    body = (
      <div className="scan-crop" style={{ aspectRatio: String(ratio) }} role="img" aria-label={`Scan of this row, ${pageLabel}`}>
        <img
          src={image.url}
          alt=""
          style={{ width: `${100 / crop.width}%`, left: `${(-crop.left / crop.width) * 100}%`, top: `${(-crop.top / crop.height) * 100}%` }}
        />
        {bounds && (
          <span
            className={`scan-mark tone-${tone}`}
            aria-hidden="true"
            style={{
              left: `${((bounds.left - crop.left) / crop.width) * 100}%`,
              top: `${((bounds.top - crop.top) / crop.height) * 100}%`,
              width: `${((bounds.right - bounds.left) / crop.width) * 100}%`,
              height: `${((bounds.bottom - bounds.top) / crop.height) * 100}%`,
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="scan-view" ref={boxRef}>
      <div className="scan-head">
        <span className="scan-title"><Icon name="image" size={16} /> Scan · {page ? `Page ${page}` : 'page unknown'}</span>
        {scan && image && (
          <div className="segmented" role="group" aria-label="How much of the scan to show">
            {numberBounds && <button type="button" className={activeMode === 'numbers' ? 'active' : ''} aria-pressed={activeMode === 'numbers'} onClick={() => setMode('numbers')}>Numbers</button>}
            <button type="button" className={activeMode === 'row' ? 'active' : ''} aria-pressed={activeMode === 'row'} onClick={() => setMode('row')}>Whole row</button>
            <button type="button" className={activeMode === 'page' ? 'active' : ''} aria-pressed={activeMode === 'page'} onClick={() => setMode('page')}>Page</button>
          </div>
        )}
      </div>
      {body}
    </div>
  )
}
