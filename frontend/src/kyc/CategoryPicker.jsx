// Section 3 cascading picker: category → items.
//
// Vendors tick a category; a dropdown of real items for that category
// opens directly below it and each pick becomes a removable chip.
// Typing is only the fallback: choosing "Other" in a dropdown (or the
// "Other" category itself) reveals one small text box.
//
// Value (controlled): { [categoryKey]: { items: string[], other: boolean, other_text: string } }
// toCategorySelections(value) gives the shape sent to the server and
// stored in kyc_submissions.category_selections:
//   [{ category: 'Raw Materials', items: ['PVC Resin'], other_text: '' }, …]

import Icon from '../components/Icon.jsx'
import { CATEGORY_OPTIONS, OTHER_ITEM } from './kycForm.js'

const EMPTY = { items: [], other: false, other_text: '' }

export default function CategoryPicker({ value, onChange, errors = {}, idPrefix = 'kyc-cat' }) {
  const update = (key, patch) => onChange({ ...value, [key]: { ...(value[key] || EMPTY), ...patch } })
  const toggle = (key) => {
    if (value[key]) {
      const next = { ...value }
      delete next[key]
      onChange(next)
    } else {
      // The "Other" category has no list, so its text box opens at once.
      onChange({ ...value, [key]: { ...EMPTY, other: key === 'other' } })
    }
  }

  return (
    <div className="kyc-cats" role="group" aria-labelledby={`${idPrefix}-legend`} aria-describedby={errors.categories ? `${idPrefix}-error` : undefined}>
      <p id={`${idPrefix}-legend`} className="kyc-label">
        Category (tick all applicable)<span className="kyc-required" aria-hidden="true"> *</span>
      </p>
      {CATEGORY_OPTIONS.map((category) => {
        const selected = value[category.key]
        const panelId = `${idPrefix}-${category.key}`
        const error = errors[`category_${category.key}`]
        const remaining = (category.items || []).filter((item) => !selected?.items.includes(item))
        return (
          <div key={category.key} className={`kyc-cat${selected ? ' is-open' : ''}${error ? ' has-error' : ''}`}>
            <label className="kyc-cat-toggle">
              <input
                type="checkbox"
                checked={Boolean(selected)}
                onChange={() => toggle(category.key)}
                aria-controls={selected ? panelId : undefined}
                data-kyc-focus={category.key === CATEGORY_OPTIONS[0].key ? 'categories' : undefined}
              />
              <span className="kyc-cat-name">{category.label}</span>
              {selected && category.items && (
                <span className="kyc-cat-count">{selected.items.length + (selected.other ? 1 : 0)} selected</span>
              )}
            </label>

            {selected && (
              <div className="kyc-cat-panel" id={panelId}>
                {category.items && (
                  <>
                    {(selected.items.length > 0 || selected.other) && (
                      <ul className="kyc-chip-list" aria-label={`${category.label}: selected items`}>
                        {selected.items.map((item) => (
                          <li key={item} className="kyc-chip">
                            {item}
                            <button type="button" aria-label={`Remove ${item}`} onClick={() => update(category.key, { items: selected.items.filter((x) => x !== item) })}>
                              <Icon name="close" size={13} />
                            </button>
                          </li>
                        ))}
                        {selected.other && (
                          <li className="kyc-chip is-other">
                            {OTHER_ITEM}{selected.other_text.trim() ? `: ${selected.other_text.trim()}` : ''}
                            <button type="button" aria-label={`Remove ${OTHER_ITEM}`} onClick={() => update(category.key, { other: false, other_text: '' })}>
                              <Icon name="close" size={13} />
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                    <select
                      className="kyc-cat-select"
                      data-kyc-focus={selected.other ? undefined : `category_${category.key}`}
                      value=""
                      aria-label={`Add a ${category.label.toLowerCase()} item`}
                      aria-invalid={error ? 'true' : undefined}
                      aria-describedby={error ? `${panelId}-error` : undefined}
                      onChange={(event) => {
                        const picked = event.target.value
                        if (picked === OTHER_ITEM) update(category.key, { other: true })
                        else if (picked) update(category.key, { items: [...selected.items, picked] })
                      }}
                    >
                      <option value="">{remaining.length || !selected.other ? 'Select an item to add…' : 'All items selected'}</option>
                      {remaining.map((item) => <option key={item} value={item}>{item}</option>)}
                      {!selected.other && <option value={OTHER_ITEM}>{OTHER_ITEM} (type it in)</option>}
                    </select>
                  </>
                )}
                {selected.other && (
                  <input
                    type="text"
                    className="kyc-cat-other"
                    data-kyc-focus={`category_${category.key}`}
                    value={selected.other_text}
                    maxLength={200}
                    placeholder={category.items ? `Describe the other ${category.label.toLowerCase()} item` : 'Describe what you supply'}
                    aria-label={category.items ? `${category.label}: other item` : 'Other category: describe what you supply'}
                    aria-invalid={error ? 'true' : undefined}
                    aria-describedby={error ? `${panelId}-error` : undefined}
                    onChange={(event) => update(category.key, { other_text: event.target.value })}
                  />
                )}
                {error && <p id={`${panelId}-error`} className="kyc-error" role="alert">{error}</p>}
              </div>
            )}
          </div>
        )
      })}
      {errors.categories && <p id={`${idPrefix}-error`} className="kyc-error" role="alert">{errors.categories}</p>}
    </div>
  )
}
