import { useState } from 'react'
import { NumberField, Section, SelectField, TextField, money } from './fields.jsx'

// "ALFATTH Import and Export FZ-LLC" -> "Alfatth" (the reference numbering).
function prefixFrom(name) {
  const word = String(name || '').trim().split(/[\s,]+/)[0]?.replace(/[^A-Za-z0-9-]/g, '') || ''
  return word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : ''
}

export default function InvoiceDetailsForm({ form, invoice, currencies, incoterms, totals, numbering, onSuggestNumber, busy }) {
  const [prefix, setPrefix] = useState('')
  const effectivePrefix = prefix || numbering?.prefix || prefixFrom(invoice.buyer.name || invoice.consignee.name)
  const currency = invoice.invoice.currency

  return (
    <>
      <Section title="Invoice details" description="The number is free text. Use Suggest to take the next number in the pattern for this financial year (April to March).">
        <TextField form={form} path="invoice.number" label="Proforma invoice number" required placeholder="e.g. Alfatth_26-27/PI-04" />
        <TextField form={form} path="invoice.date" label="Proforma invoice date" type="date" required />
        <div className="pf-suggest pf-wide">
          <label className="form-label">Number prefix
            <input value={effectivePrefix} onChange={(event) => setPrefix(event.target.value)} placeholder="e.g. Alfatth" />
          </label>
          <button type="button" className="secondary-btn" disabled={busy || !invoice.invoice.date} onClick={() => onSuggestNumber(effectivePrefix)}>Suggest next number</button>
          <small className="muted-copy">Pattern: <code>{numbering?.pattern || '{prefix}_{fy}/PI-{seq}'}</code></small>
        </div>
        <TextField form={form} path="invoice.enquiry_ref" label="Buyer's enquiry reference" multiline wide />
        <TextField form={form} path="invoice.po_number" label="Purchase order number" hint="Optional" />
        <TextField form={form} path="invoice.po_date" label="Purchase order date" type="date" hint="Optional" />
        <SelectField form={form} path="invoice.currency" label="Currency" required options={currencies.map((entry) => [entry.code, `${entry.code} – ${entry.words}`])} />
      </Section>

      <Section title="Delivery terms (Incoterms)">
        <SelectField form={form} path="shipping.incoterm" label="Incoterm" required options={incoterms} />
        <TextField form={form} path="shipping.incoterm_place" label="Named port / place" required placeholder="e.g. Alexandria Port, Egypt" />
      </Section>

      <Section title="Payment terms" description="The payment text and term 4 quote the advance and the balance. In Excel they are formulas, so they follow any change to quantities or prices.">
        <NumberField form={form} path="payment.advance" label={`Advance amount (${currency})`} placeholder="e.g. 10000" />
        <div className="pf-figure">
          <span>Balance after advance</span>
          <strong>{currency} {money(totals?.balance)}</strong>
        </div>
        <TextField form={form} path="payment.summary" label="Payment text (shown under Terms of Delivery and Payment)" multiline rows={3} wide
          hint="**bold**, {advance}, {balance}, {grand_total} and {currency} are filled in automatically." />
      </Section>
    </>
  )
}
