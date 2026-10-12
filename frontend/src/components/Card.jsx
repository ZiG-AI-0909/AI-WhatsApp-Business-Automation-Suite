import React from 'react';

/**
 * Card component – applies the shared `.card` Tailwind utility.
 * Accepts optional `className` to extend/customise styling.
 */
export default function Card({ children, className = '' }) {
  return (
    <div className={`card ${className}`.trim()}>
      {children}
    </div>
  );
}
