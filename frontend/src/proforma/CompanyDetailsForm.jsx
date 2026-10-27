import { Section, TextField } from './fields.jsx'

// Manufacturer & exporter plus the bank account. Prefilled from the saved
// company profile; "Save as my defaults" stores them (with the current terms
// and shipping defaults) for every new invoice.
export default function CompanyDetailsForm({ form, onSaveDefaults, profileSaved, persistence, busy }) {
  return (
    <>
      <Section
        title="Manufacturer & exporter"
        description={persistence
          ? (profileSaved ? 'New invoices start with your saved company details.' : 'Using the built-in Sudarshan details. Save them as your defaults to change what new invoices start with.')
          : 'Company defaults cannot be saved until the database update has been run.'}
        actions={<button type="button" className="secondary-btn" disabled={busy || !persistence} onClick={onSaveDefaults}>Save as my defaults</button>}
      >
        <TextField form={form} path="exporter.name" label="Company name" required wide />
        <TextField form={form} path="exporter.address" label="Address" required multiline rows={2} wide hint="Two lines, as printed on the invoice." />
        <TextField form={form} path="exporter.contact_person" label="Contact person" />
        <TextField form={form} path="exporter.phone" label="Contact number" />
        <TextField form={form} path="exporter.gstin" label="GSTIN" />
        <TextField form={form} path="exporter.iec" label="IEC" />
        <TextField form={form} path="exporter.signatory_name" label="Signature line name" hint='Printed as "For …" above Authorised Signatory.' wide />
      </Section>

      <Section title="Bank details" description="Printed under Payment to be made to our bank account, and in term 8 through {bank_…} placeholders.">
        <TextField form={form} path="bank.name" label="Bank" />
        <TextField form={form} path="bank.branch" label="Branch" />
        <TextField form={form} path="bank.account" label="Account number" autoComplete="off" />
        <TextField form={form} path="bank.swift" label="SWIFT code" autoComplete="off" />
        <TextField form={form} path="bank.ifsc" label="IFSC" autoComplete="off" />
      </Section>
    </>
  )
}
