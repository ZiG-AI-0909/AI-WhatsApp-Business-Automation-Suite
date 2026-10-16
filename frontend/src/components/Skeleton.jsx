// Shimmering placeholders shown while a screen loads, instead of a blank
// panel. Purely visual; screen readers hear the label once.

export function SkeletonBlock({ width = '100%', height = 14, className = '' }) {
  return <span className={`skeleton ${className}`.trim()} style={{ width, height }} aria-hidden="true" />
}

export default function SkeletonPanel({ label = 'Loading…', variant = 'list' }) {
  return (
    <div className={`skeleton-panel skeleton-${variant}`} role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {variant === 'dashboard' && (
        <div className="skeleton-tiles" aria-hidden="true">
          {[0, 1, 2, 3].map((index) => (
            <div className="skeleton-tile" key={index}>
              <SkeletonBlock width="45%" height={12} />
              <SkeletonBlock width="60%" height={28} />
              <SkeletonBlock width="80%" height={10} />
            </div>
          ))}
        </div>
      )}
      <div className="skeleton-card" aria-hidden="true">
        <SkeletonBlock width="32%" height={18} />
        {[92, 78, 85, 64, 88].map((width, index) => <SkeletonBlock key={index} width={`${width}%`} height={12} />)}
      </div>
    </div>
  )
}
