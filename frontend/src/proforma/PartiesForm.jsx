import { Section, TextField } from './fields.jsx'

const BUYER_COPY = ['name', 'address', 'country', 'tax_id', 'email', 'phone']

// Consignee and buyer / notifying party. The buyer block can mirror the
// consignee ("same as consignee") or be copied once and then edited.
export default function PartiesForm({ form, invoice }) {
  const same = invoice.buyer.same_as_consignee
  const copyOnce = () => BUYER_COPY.forEach((field) => form.set(`buyer.${field}`, invoice.consignee[field]))

  return (
    <>
      <Section title="Consignee">
        <TextField form={form} path="consignee.name" label="Company name" required wide />
        <TextField form={form} path="consignee.address" label="Full address" required multiline rows={2} wide />
        <TextField form={form} path="consignee.country" label="Country" hint="Added after the address unless it already ends with it." />
        <TextField form={form} path="consignee.tax_id" label="Tax registration number" />
        <TextField form={form} path="consignee.acid" label="ACID number" hint="e.g. To be provided by Buyer prior to the shipment." wide />
        <TextField form={form} path="consignee.email" label="Email address" type="email" />
        <TextField form={form} path="consignee.phone" label="Contact number" />
      </Section>

      <Section
        title="Buyer / notifying party"
        description="Optional: fill in when the buyer is not the consignee."
        actions={<>
          <label className="check-label"><input type="checkbox" checked={same} onChange={(event) => form.set('buyer.same_as_consignee', event.target.checked)} /> Same as consignee</label>
          {!same && <button type="button" className="secondary-btn" onClick={copyOnce}>Copy consignee details</button>}
        </>}
      >
        {same
          ? <p className="muted-copy pf-wide">The buyer block repeats the consignee. Untick to enter a different buyer.</p>
          : <>
            <TextField form={form} path="buyer.name" label="Name" wide />
            <TextField form={form} path="buyer.address" label="Full address" multiline rows={2} wide />
            <TextField form={form} path="buyer.country" label="Country" />
            <TextField form={form} path="buyer.tax_id" label="Tax registration number" />
          </>}
        <TextField form={form} path="buyer.contact_person" label="Contact person" />
        <TextField form={form} path="buyer.email" label="Email address" type="email" disabled={same} />
        <TextField form={form} path="buyer.phone" label="Contact number" disabled={same} />
        <TextField form={form} path="buyer.signatory_name" label="Signature line name" wide
          hint='Printed as "For …" under Accepted By Buyer. Leave empty to use the name in capitals.' />
      </Section>
    </>
  )
}
