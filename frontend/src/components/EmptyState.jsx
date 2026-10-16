// ─────────────────────────────────────────────────────────────────────────────
// Shared empty-state presentation for lists/tables/views with no data yet.
//
// Usage:
//   <EmptyState
//     icon="👥"
//     title="No contacts yet"
//     description="Add your first contact or upload an Excel file to get started."
//     actions={[{ label: 'Add contact', onClick: () => … }, { label: 'Upload Excel', … }]}
//   />
//
// One consistent visual style everywhere: line icon + heading + one-line
// description + action buttons. Callers may pass an icon name from
// components/Icon.jsx; the older emoji values map to matching line icons.
// ─────────────────────────────────────────────────────────────────────────────
import Icon from './Icon.jsx'

const EMOJI_ICONS = {
  '📣': 'megaphone',
  '💬': 'chat',
  '👥': 'users',
  '🔍': 'search',
  '📝': 'file',
  '📚': 'book',
  '📊': 'chart',
  '✉️': 'mail',
  '🗓️': 'calendar',
  '📋': 'clipboard',
  '📭': 'inbox',
}

export default function EmptyState({ icon = '📭', title, description, actions = [] }) {
  const iconName = EMOJI_ICONS[icon] || icon
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true"><Icon name={iconName} size={26} /></span>
      <h3 className="empty-state-title">{title}</h3>
      {description && <p className="empty-state-description">{description}</p>}
      {actions.length > 0 && (
        <div className="empty-state-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={action.variant === 'secondary' ? 'secondary-btn' : 'primary-btn'}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
