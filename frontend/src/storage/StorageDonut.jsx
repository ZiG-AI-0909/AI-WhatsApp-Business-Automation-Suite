import { useState } from 'react'
import { formatBytes, formatPercent, severityMeta } from './storageFormat.js'

// Used vs available storage as a donut. Two parts of one whole, so a donut
// reads at a glance; the exact figures sit beside it (the legend doubles as
// the table view). "Used" takes the status colour of the current warning
// level; "Available" is a neutral track. Hover or focus a segment for its
// value. Without a capacity there is no "available", so no donut.

const SIZE = 168
const STROKE = 22
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const GAP = 2 // px of surface between the two segments

export default function StorageDonut({ usedBytes, capacityBytes, severity = 0, compact = false }) {
  const [hover, setHover] = useState(null)
  const percent = capacityBytes ? Math.min(100, (usedBytes / capacityBytes) * 100) : 0
  const availableBytes = Math.max(0, (capacityBytes || 0) - usedBytes)
  const meta = severityMeta(severity)
  const usedLength = (percent / 100) * CIRCUMFERENCE
  const gap = percent > 0 && percent < 100 ? GAP : 0
  const segments = [
    { key: 'used', label: 'Used storage', bytes: usedBytes, pct: percent, length: Math.max(0, usedLength - gap), offset: 0, className: `storage-donut-used is-${meta.key}` },
    { key: 'available', label: 'Available storage', bytes: availableBytes, pct: 100 - percent, length: Math.max(0, CIRCUMFERENCE - usedLength - gap), offset: usedLength, className: 'storage-donut-available' },
  ]
  const active = segments.find((segment) => segment.key === hover)

  return (
    <figure className={`storage-donut${compact ? ' is-compact' : ''}`} aria-label={`Storage: ${formatPercent(percent)} used, ${formatBytes(usedBytes)} of ${formatBytes(capacityBytes)}`}>
      <div className="storage-donut-chart">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-hidden="true">
          <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
            {segments.filter((segment) => segment.length > 0).map((segment) => (
              <circle
                key={segment.key}
                className={`${segment.className}${hover && hover !== segment.key ? ' is-dimmed' : ''}`}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                strokeWidth={STROKE}
                strokeDasharray={`${segment.length} ${CIRCUMFERENCE}`}
                strokeDashoffset={-segment.offset}
                tabIndex={0}
                onMouseEnter={() => setHover(segment.key)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(segment.key)}
                onBlur={() => setHover(null)}
              />
            ))}
          </g>
        </svg>
        <div className="storage-donut-center" aria-hidden="true">
          {active ? (
            <>
              <strong>{formatBytes(active.bytes)}</strong>
              <span>{active.key === 'used' ? 'used' : 'available'} · {formatPercent(active.pct)}</span>
            </>
          ) : (
            <>
              <strong>{formatPercent(percent)}</strong>
              <span>used</span>
            </>
          )}
        </div>
      </div>
      <figcaption className="storage-legend">
        <dl>
          <div><dt><span className="storage-swatch is-used" data-level={meta.key} aria-hidden="true" />Used</dt><dd>{formatBytes(usedBytes)} <small>{formatPercent(percent)}</small></dd></div>
          <div><dt><span className="storage-swatch is-available" aria-hidden="true" />Available</dt><dd>{formatBytes(availableBytes)} <small>{formatPercent(100 - percent)}</small></dd></div>
          <div className="storage-legend-total"><dt>Total capacity</dt><dd>{formatBytes(capacityBytes)}</dd></div>
        </dl>
      </figcaption>
    </figure>
  )
}
