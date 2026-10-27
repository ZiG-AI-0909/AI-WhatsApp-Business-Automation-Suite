import { NumberField, Section, TextField, money } from './fields.jsx'

function FreightBlock({ form, invoice, kind, title, amount, currency }) {
  const freight = invoice[kind]
  return (
    <Section
      title={title}
      actions={<label className="check-label"><input type="checkbox" checked={freight.include} onChange={(event) => form.set(`${kind}.include`, event.target.checked)} /> Include on the invoice</label>}
    >
      {freight.include ? <>
        <TextField form={form} path={`${kind}.description`} label="Description" required wide />
        <TextField form={form} path={`${kind}.unit`} label="Unit" placeholder="Container" />
        <NumberField form={form} path={`${kind}.qty`} label="Quantity" required />
        <NumberField form={form} path={`${kind}.rate`} label={`Rate (${currency} / unit)`} required />
        <div className="pf-figure"><span>Amount</span><strong>{currency} {money(amount)}</strong></div>
      </> : <p className="muted-copy pf-wide">Not on this invoice. The totals skip this line.</p>}
    </Section>
  )
}

// Inland and ocean freight (the reference's FOB and CFR steps) plus optional
// other charges such as insurance or handling. A charge is added to the
// Grand Total once, and only when "Add to Grand Total" is ticked.
export default function ChargesEditor({ form, invoice, totals, currency, onAddCharge, onRemoveCharge }) {
  const otherById = new Map((totals?.other_charges || []).map((entry) => [entry.id, entry.amount]))
  return (
    <>
      <FreightBlock form={form} invoice={invoice} kind="inland_freight" title="Inland freight (Ex-Works to port of loading)" amount={totals?.inland_freight} currency={currency} />
      <FreightBlock form={form} invoice={invoice} kind="ocean_freight" title="Ocean freight (printed under Freight Charges #)" amount={totals?.ocean_freight} currency={currency} />

      <section className="pf-section">
        <div className="pf-section-head">
          <div>
            <h3>Other charges and adjustments</h3>
            <p className="muted-copy">Insurance, handling and similar. Use a negative rate for a discount. Untick "Add to Grand Total" to show a charge for information only.</p>
          </div>
          <button type="button" className="secondary-btn" onClick={onAddCharge}>Add charge</button>
        </div>
        {!invoice.other_charges.length && <p className="muted-copy">No other charges.</p>}
        {invoice.other_charges.map((charge, index) => {
          const base = `other_charges.${charge.id}`
          const bound = {
            get: (path) => charge[path.split('.').pop()],
            set: (path, value) => form.setCharge(charge.id, path.split('.').pop(), value),
            touch: form.touch,
            error: form.error,
            flag: form.flag,
          }
          return (
            <div className="pf-grid pf-charge" key={charge.id}>
              <TextField form={bound} path={`${base}.description`} label={`Charge ${index + 1}`} required wide />
              <TextField form={bound} path={`${base}.unit`} label="Unit" />
              <NumberField form={bound} path={`${base}.qty`} label="Quantity" required />
              <NumberField form={bound} path={`${base}.rate`} label={`Rate (${currency})`} required />
              <div className="pf-figure"><span>Amount</span><strong>{currency} {money(otherById.get(charge.id))}</strong></div>
              <div className="button-row pf-wide">
                <label className="check-label"><input type="checkbox" checked={charge.include_in_total} onChange={(event) => form.setCharge(charge.id, 'include_in_total', event.target.checked)} /> Add to Grand Total</label>
                <button type="button" className="danger-btn" onClick={() => onRemoveCharge(charge.id)}>Remove</button>
              </div>
            </div>
          )
        })}
      </section>

      <section className="pf-section pf-totals" aria-label="Totals">
        <dl>
          <div><dt>Total – Ex-Works</dt><dd>{money(totals?.ex_works)}</dd></div>
          <div><dt>Total – FOB</dt><dd>{money(totals?.fob)}</dd></div>
          {invoice.other_charges.length > 0 && <div><dt>Other charges added</dt><dd>{money(totals?.other_included)}</dd></div>}
          <div className="pf-grand"><dt>Grand Total ({currency})</dt><dd>{money(totals?.grand_total)}</dd></div>
        </dl>
        <p className="muted-copy">{totals?.amount_in_words}</p>
      </section>
    </>
  )
}
