import React from 'react';

/**
 * Button component with primary, secondary, and ghost variants.
 * Uses the shared Tailwind design tokens defined in `tailwind.config.js`.
 */
export default function Button({
  variant = 'primary',
  type = 'button',
  onClick,
  className = '',
  children,
  ...rest
}) {
  const base = 'px-4 py-2 rounded-lg font-medium transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed';
  const variants = {
    primary: 'bg-primary-500 hover:bg-primary-600 text-white',
    secondary: 'bg-slate-100 hover:bg-slate-200 text-slate-800',
    ghost: 'bg-transparent hover:bg-slate-100 text-primary-500',
    danger: 'bg-red-600 hover:bg-red-700 text-white',
  };
  const variantClasses = variants[variant] || variants['primary'];

  return (
    <button
      type={type}
      onClick={onClick}
      className={`${base} ${variantClasses} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  );
}
