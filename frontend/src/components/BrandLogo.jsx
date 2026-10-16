// The Sudarshan Pipes & Fittings logo, used exactly as supplied
// (public/sudarshan-logo.jpg, 1660×422). It is never recoloured, redrawn or
// stretched: both variants show the original image through a window that
// keeps its aspect ratio — `full` trims only the empty white margin around
// the wordmark, `mark` shows just the circle-and-pipe symbol. The image has
// a white background, so it always sits on a white rounded chip; that keeps
// it visible on the dark theme without editing the logo.

const LOGO_SRC = '/sudarshan-logo.jpg'
const LOGO_W = 1660
const LOGO_H = 422
// Measured from the image pixels (see README "Branding").
const FULL_CROP = { x: 92, y: 88, w: 1528, h: 298 }
const MARK_CROP = { x: 103, y: 96.5, w: 276, h: 276 }
const ALT = 'Sudarshan Pipes & Fittings'

function LogoWindow({ crop, height, decorative }) {
  const scale = height / crop.h
  return (
    <span className="brand-window" style={{ width: Math.round(crop.w * scale), height }}>
      <img
        src={LOGO_SRC}
        alt={decorative ? '' : ALT}
        width={Math.round(LOGO_W * scale)}
        height={Math.round(LOGO_H * scale)}
        style={{ left: Math.round(-crop.x * scale), top: Math.round(-crop.y * scale) }}
        draggable="false"
      />
    </span>
  )
}

export default function BrandLogo({ variant = 'full', height = 30, className = '', decorative = false }) {
  const crop = variant === 'mark' ? MARK_CROP : FULL_CROP
  return (
    <span className={`brand-chip brand-chip-${variant} ${className}`.trim()}>
      <LogoWindow crop={crop} height={height} decorative={decorative} />
    </span>
  )
}
