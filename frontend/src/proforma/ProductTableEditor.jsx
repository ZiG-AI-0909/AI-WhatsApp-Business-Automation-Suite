import { money } from './fields.jsx'

const COLUMNS = [
  ['description', 'Product group / description', 'pf-col-desc'],
  ['size', 'Pipe size', 'pf-col-xs'],
  ['specification', 'Specification / class', 'pf-col-md'],
  ['pressure', 'Pressure rating', 'pf-col-sm'],
  ['coupler', 'Coupler type', 'pf-col-sm'],
  ['length', 'Length (Mtr.)', 'pf-col-xs num'],
  ['hsn', 'HSN code', 'pf-col-sm'],
  ['qty', 'Quantity (pcs)', 'pf-col-sm num'],
  ['rate', 'Unit price', 'pf-col-sm num'],
]
const NUMERIC = new Set(['length', 'qty', 'rate'])

// Repeatable product rows. Rows with the same group text print under one
// bold heading, as "PVC Pipes - uPVC Column Pipes" in the reference.
export default function ProductTableEditor({ items, form, amounts, currency, totals, onAdd, onDuplicate, onRemove, onMove }) {
  return (
    <section className="pf-section">
      <div className="pf-section-head">
        <div>
          <h3>Products</h3>
          <p className="muted-copy">Amount = quantity × unit price (an Excel formula in the export). Rows sharing a product group print under one heading.</p>
        </div>
        <button type="button" className="primary-btn" onClick={onAdd}>Add product</button>
      </div>
      <div className="campaign-table-wrap">
        <table className="quote-table pf-items">
          <thead>
            <tr>
              <th className="pf-col-xs">#</th>
              {COLUMNS.map(([key, label, className]) => <th key={key} className={className}>{label}{key === 'rate' ? ` (${currency})` : ''}</th>)}
              <th className="num pf-col-sm">Amount ({currency})</th>
              <th className="pf-col-actions"><span className="sr-only">Row actions</span></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.id}>
                <td data-label="#">{index + 1}</td>
                {COLUMNS.map(([key, label]) => {
                  const path = `items.${item.id}.${key}`
                  const error = form.error(path)
                  const flag = !error && form.flag(path)
                  const props = {
                    value: item[key] ?? '',
                    onChange: (event) => form.setItem(item.id, key, event.target.value),
                    onBlur: () => form.touch(path),
                    'aria-label': `${label}, row ${index + 1}`,
                    'aria-invalid': error ? 'true' : undefined,
                    className: NUMERIC.has(key) ? 'quote-input-num' : undefined,
                    inputMode: NUMERIC.has(key) ? 'decimal' : undefined,
                  }
                  return (
                    <td key={key} data-label={label} className={error ? 'pf-cell-invalid' : flag ? 'pf-cell-flagged' : undefined}>
                      {key === 'description' ? <textarea rows={1} {...props} /> : <input type="text" {...props} />}
                      {error && <small className="pf-error" role="alert">{error}</small>}
                      {flag && <small className="pf-flag">{flag}</small>}
                    </td>
                  )
                })}
                <td className="num" data-label="Amount">{money(amounts.get(item.id))}</td>
                <td data-label="Actions">
                  <div className="pf-row-actions">
                    <button type="button" className="ghost-btn" onClick={() => onMove(item.id, -1)} disabled={index === 0} aria-label={`Move row ${index + 1} up`} title="Move up">↑</button>
                    <button type="button" className="ghost-btn" onClick={() => onMove(item.id, 1)} disabled={index === items.length - 1} aria-label={`Move row ${index + 1} down`} title="Move down">↓</button>
                    <button type="button" className="ghost-btn" onClick={() => onDuplicate(item.id)} title="Duplicate this row">Duplicate</button>
                    <button type="button" className="danger-btn" onClick={() => onRemove(item.id)} title="Remove this row">Remove</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={8} className="pf-total-label">Total – Ex-Works</td>
              <td className="num"><strong>{totals ? Number(totals.total_qty).toLocaleString('en-US') : '—'}</strong></td>
              <td />
              <td className="num"><strong>{money(totals?.ex_works)}</strong></td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {form.error('items') && <p className="pf-error" role="alert">{form.error('items')}</p>}
      <div className="button-row pf-table-actions"><button type="button" className="secondary-btn" onClick={onAdd}>Add product</button></div>
    </section>
  )
}
