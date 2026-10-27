// Form fields bound to the invoice by path ("consignee.name"). `form` comes
// from ProformaView: get(path), set(path, value), touch(path), error(path).
// Errors are the backend's validation messages, shown next to the field.
// Flags (form.flag) mark fields an uploaded invoice did not fill reliably;
// they clear when the field is edited.

export function Field({ label, error, flag, hint, required, wide, children }) {
  return (
    <label className={`form-label pf-field${wide ? ' pf-wide' : ''}${error ? ' pf-invalid' : flag ? ' pf-flagged' : ''}`}>
      <span>{label}{required && <b className="pf-required" aria-hidden="true"> *</b>}</span>
      {children}
      {error ? <small className="pf-error" role="alert">{error}</small>
        : flag ? <small className="pf-flag">{flag}</small>
          : hint ? <small>{hint}</small> : null}
    </label>
  )
}

export function TextField({ form, path, label, hint, required, wide, multiline, rows = 2, ...rest }) {
  const error = form.error(path)
  const flag = form.flag?.(path)
  const props = {
    value: form.get(path) ?? '',
    onChange: (event) => form.set(path, event.target.value),
    onBlur: () => form.touch(path),
    'aria-invalid': error ? 'true' : undefined,
    ...rest,
  }
  return (
    <Field label={label} error={error} flag={flag} hint={hint} required={required} wide={wide}>
      {multiline ? <textarea className="pf-textarea" rows={rows} {...props} /> : <input type="text" {...props} />}
    </Field>
  )
}

// Numbers are kept as typed; the backend parses and validates them.
export function NumberField(props) {
  return <TextField inputMode="decimal" autoComplete="off" {...props} />
}

export function SelectField({ form, path, label, options, hint, required }) {
  const error = form.error(path)
  return (
    <Field label={label} error={error} flag={form.flag?.(path)} hint={hint} required={required}>
      <select value={form.get(path) ?? ''} onChange={(event) => form.set(path, event.target.value)} onBlur={() => form.touch(path)} aria-invalid={error ? 'true' : undefined}>
        {options.map((option) => {
          const [value, text] = Array.isArray(option) ? option : [option, option]
          return <option key={value} value={value}>{text}</option>
        })}
      </select>
    </Field>
  )
}

export function Section({ title, description, actions, children }) {
  return (
    <section className="pf-section">
      <div className="pf-section-head">
        <div>
          <h3>{title}</h3>
          {description && <p className="muted-copy">{description}</p>}
        </div>
        {actions && <div className="button-row">{actions}</div>}
      </div>
      <div className="pf-grid">{children}</div>
    </section>
  )
}

export function money(value) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '—'
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// [{ text, bold } | { amount, value }] -> <strong> runs. Text that quotes an
// amount is a formula in Excel, which cannot carry bold, so it is shown plain.
export function Segments({ value }) {
  if (!value) return null
  return value.segments.map((segment, index) => {
    const text = segment.amount ? money(segment.value) : segment.text
    return segment.bold && !value.dynamic ? <strong key={index}>{text}</strong> : <span key={index}>{text}</span>
  })
}
