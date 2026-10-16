import Icon from './Icon.jsx'
import { useTheme } from '../theme.js'

// Sun/moon switch for the top bar (and the sign-in screen).
export default function ThemeToggle({ className = '' }) {
  const [theme, toggleTheme] = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className={`icon-btn theme-toggle ${className}`.trim()}
      onClick={toggleTheme}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  )
}
