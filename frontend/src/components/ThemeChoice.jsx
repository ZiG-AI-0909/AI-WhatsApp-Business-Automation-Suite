import Icon from './Icon.jsx'
import { useTheme, useThemePreference } from '../theme.js'

const OPTIONS = [
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' },
  { id: 'system', label: 'Match my device', icon: 'sliders' },
]

/**
 * Labelled Light / Dark choice (radio buttons styled as a segmented
 * control). withSystem adds "Match my device", which follows the
 * operating system's setting.
 */
export default function ThemeChoice({ withSystem = false, className = '', label = 'Colour theme' }) {
  useTheme() // keeps the follow-the-device behaviour active while shown
  const [preference, setPreference] = useThemePreference()
  const options = withSystem ? OPTIONS : OPTIONS.slice(0, 2)
  const selected = !withSystem && preference === 'system'
    ? (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark')
    : preference
  return (
    <div className={`theme-choice ${className}`.trim()} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.id} className={`theme-choice-option${selected === option.id ? ' active' : ''}`}>
          <input
            type="radio"
            name={`theme-choice-${withSystem ? 'full' : 'short'}`}
            value={option.id}
            checked={selected === option.id}
            onChange={() => setPreference(option.id)}
          />
          <Icon name={option.icon} size={16} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
}
