import React from 'react';

/**
 * Badge component with a soft‑tint style.
 * `tone` selects the color palette (hot, warm, cold, success, danger, warning, neutral, etc.).
 * If `dot` is true a small colored dot is rendered before the label.
 */
export default function Badge({ tone = 'neutral', dot = false, children, className = '' }) {
  const toneMap = {
    hot: 'bg-red-50 text-red-700',
    warm: 'bg-orange-50 text-orange-700',
    cold: 'bg-blue-50 text-blue-700',
    success: 'bg-green-50 text-green-700',
    danger: 'bg-red-50 text-red-700',
    warning: 'bg-yellow-50 text-yellow-700',
    neutral: 'bg-teal-50 text-teal-700', // default soft teal
  };

  const baseClasses = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full';
  const toneClasses = toneMap[tone] || toneMap['neutral'];
  const dotElement = dot ? (
    <span className={`h-2 w-2 rounded-full ${toneClasses.split(' ')[0].replace('bg-', 'bg-')}`}></span>
  ) : null;

  return (
    <span className={`${baseClasses} ${toneClasses} ${className}`.trim()}>
      {dotElement}
      {children}
    </span>
  );
}
