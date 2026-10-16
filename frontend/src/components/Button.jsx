import React from 'react';

/**
 * Button component with primary, secondary, ghost and danger variants.
 * Maps onto the app-wide button classes in index.css, so it matches every
 * other button in both themes (focus ring, disabled and hover states).
 */
export default function Button({
  variant = 'primary',
  type = 'button',
  onClick,
  className = '',
  children,
  ...rest
}) {
  const variants = {
    primary: 'primary-btn',
    secondary: 'secondary-btn',
    ghost: 'ghost-btn',
    danger: 'danger-btn',
  };
  const variantClass = variants[variant] || variants.primary;

  return (
    <button
      type={type}
      onClick={onClick}
      className={`${variantClass} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
}
