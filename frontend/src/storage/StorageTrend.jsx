import { useMemo, useRef, useState } from 'react'
import { formatBytes, formatDateTime } from './storageFormat.js'

// Used storage over time (one series, so no legend box — the title names
// it). The capacity, when set, is a dashed reference line on the same
// axis. Hover / touch shows a crosshair and the value at that time.

const W = 640
const H = 200
const PAD = { top: 14, right: 12, bottom: 26, left: 64 }

export default function StorageTrend({ points = [] }) {
  const [hoverIndex, setHoverIndex] = useState(null)
  const svgRef = useRef(null)
  const chart = useMemo(() => {
    if (points.length < 2) return null
    const times = points.map((point) => new Date(point.at).getTime())
    const capacity = points.at(-1).capacityBytes
    const maxY = Math.max(...points.map((point) => point.usedBytes), capacity || 0) * 1.08 || 1
    const minT = Math.min(...times)
    const maxT = Math.max(...times)
    const x = (time) => PAD.left + ((time - minT) / Math.max(1, maxT - minT)) * (W - PAD.left - PAD.right)
    const y = (bytes) => H - PAD.bottom - (bytes / maxY) * (H - PAD.top - PAD.bottom)
    const coords = points.map((point, index) => [x(times[index]), y(point.usedBytes)])
    const ticks = [0, 0.5, 1].map((fraction) => ({ y: y(maxY * fraction), label: formatBytes(maxY * fraction) }))
    return {
      coords,
      ticks,
      capacityY: capacity ? y(capacity) : null,
      path: coords.map(([px, py], index) => `${index ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(''),
      area: `M${coords[0][0]},${H - PAD.bottom}${coords.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join('')}L${coords.at(-1)[0]},${H - PAD.bottom}Z`,
      firstLabel: formatDateTime(points[0].at).split(',')[0],
      lastLabel: formatDateTime(points.at(-1).at).split(',')[0],
    }
  }, [points])

  if (!chart) {
    return <p className="muted-copy storage-empty">The usage trend appears once there are measurements over time (one every 30 minutes while usage changes).</p>
  }

  const onMove = (event) => {
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * W
    let best = 0
    chart.coords.forEach(([cx], index) => { if (Math.abs(cx - px) < Math.abs(chart.coords[best][0] - px)) best = index })
    setHoverIndex(best)
  }
  const hovered = hoverIndex == null ? null : { point: points[hoverIndex], xy: chart.coords[hoverIndex] }

  return (
    <div className="storage-trend">
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Used storage from ${chart.firstLabel} to ${chart.lastLabel}: now ${formatBytes(points.at(-1).usedBytes)}`}
        onPointerMove={onMove} onPointerLeave={() => setHoverIndex(null)}>
        {chart.ticks.map((tick) => (
          <g key={tick.y}>
            <line className="storage-grid" x1={PAD.left} x2={W - PAD.right} y1={tick.y} y2={tick.y} />
            <text className="storage-axis" x={PAD.left - 8} y={tick.y + 4} textAnchor="end">{tick.label}</text>
          </g>
        ))}
        {chart.capacityY != null && (
          <g>
            <line className="storage-capacity-line" x1={PAD.left} x2={W - PAD.right} y1={chart.capacityY} y2={chart.capacityY} />
            <text className="storage-axis" x={W - PAD.right} y={chart.capacityY - 5} textAnchor="end">Capacity</text>
          </g>
        )}
        <path className="storage-trend-area" d={chart.area} />
        <path className="storage-trend-line" d={chart.path} />
        <text className="storage-axis" x={PAD.left} y={H - 6}>{chart.firstLabel}</text>
        <text className="storage-axis" x={W - PAD.right} y={H - 6} textAnchor="end">{chart.lastLabel}</text>
        {hovered && (
          <g>
            <line className="storage-crosshair" x1={hovered.xy[0]} x2={hovered.xy[0]} y1={PAD.top} y2={H - PAD.bottom} />
            <circle className="storage-trend-dot" cx={hovered.xy[0]} cy={hovered.xy[1]} r={5} />
          </g>
        )}
      </svg>
      {hovered && (
        <div className="storage-tooltip" role="status" style={{ left: `${(hovered.xy[0] / W) * 100}%` }}>
          <strong>{formatBytes(hovered.point.usedBytes)}</strong>
          <span>{formatDateTime(hovered.point.at)}</span>
        </div>
      )}
    </div>
  )
}
