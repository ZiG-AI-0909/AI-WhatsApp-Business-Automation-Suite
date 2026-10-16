// The Sudarshan Pipes & Fittings logo, from "SEPL Main Logo (1).png"
// (transparent background). Files in public/, made from it with only the
// empty margin trimmed:
//   sudarshan-logo.png       light theme — exactly as supplied
//   sudarshan-logo-dark.png  dark theme — the blue lettering is white so it
//                            reads on navy; the orange mark is unchanged
//   sudarshan-mark.png       the circle-and-pipe mark alone
// Both full versions are in the page; CSS shows the one for the active theme
// (see .brand-logo in index.css), so switching themes never flashes.

const ALT = 'Sudarshan Pipes & Fittings'
const FULL_RATIO = 485 / 91 // width / height of the trimmed logo
const MARK_RATIO = 92 / 87

export default function BrandLogo({ variant = 'full', height = 30, className = '', decorative = false }) {
  const alt = decorative ? '' : ALT
  if (variant === 'mark') {
    return (
      <span className={`brand-logo brand-logo-mark ${className}`.trim()}>
        <img src="/sudarshan-mark.png" alt={alt} width={Math.round(height * MARK_RATIO)} height={height} draggable="false" />
      </span>
    )
  }
  const width = Math.round(height * FULL_RATIO)
  return (
    <span className={`brand-logo brand-logo-full ${className}`.trim()}>
      <img className="brand-logo-for-light" src="/sudarshan-logo.png" alt={alt} width={width} height={height} draggable="false" />
      <img className="brand-logo-for-dark" src="/sudarshan-logo-dark.png" alt={alt} width={width} height={height} draggable="false" />
    </span>
  )
}
