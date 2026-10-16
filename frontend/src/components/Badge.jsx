import React from 'react';

/**
 * Badge component with a soft-tint style.
 * `tone` selects the colour palette (hot, warm, cold, success, danger, warning, neutral).
 * If `dot` is true a small coloured dot is rendered before the label.
 * Colours come from the theme tokens (see styles/tokens.css), so the badge
 * works in both the dark and light themes; the label text always carries
 * the meaning, never the colour alone.
 */
export default function Badge({ tone = 'neutral', dot = false, children, className = '' }) {
  const tones = ['hot', 'warm', 'cold', 'success', 'danger', 'warning', 'neutral'];
  const toneClass = tones.includes(tone) ? tone : 'neutral';

  return (
    <span className={`ui-badge ui-badge-${toneClass} ${className}`.trim()}>
      {dot && <span className="ui-badge-dot" aria-hidden="true"></span>}
      {children}
    </span>
  );
}
