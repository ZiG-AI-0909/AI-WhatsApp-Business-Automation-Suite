import { Section, TextField } from './fields.jsx'

export default function ShippingDetailsForm({ form, deliveryTerms }) {
  return (
    <>
      <Section title="Shipping & delivery">
        <TextField form={form} path="shipping.pre_carriage" label="Pre-carriage by" placeholder="e.g. Road" />
        <TextField form={form} path="shipping.place_of_receipt" label="Place of receipt by pre-carrier" />
        <TextField form={form} path="shipping.port_of_loading" label="Port of loading" required />
        <TextField form={form} path="shipping.port_of_discharge" label="Port of discharge" required />
        <TextField form={form} path="shipping.place_of_delivery" label="Final destination" hint="Printed beside the port of discharge, e.g. Giza, Egypt." />
        <TextField form={form} path="shipping.container_no" label="Container number" hint="Optional" />
        <TextField form={form} path="shipping.vessel_no" label="Vessel / flight number" hint="Optional" />
        <TextField form={form} path="shipping.origin_country" label="Country of origin of goods" required />
        <TextField form={form} path="shipping.destination_country" label="Country of final destination" required />
      </Section>
      <Section title="Terms of delivery and payment" description="Shipment terms (lead time, part shipment, transhipment) are term 10 under Terms.">
        <TextField form={form} path="shipping.delivery_terms" label="Terms of delivery line" wide
          placeholder={deliveryTerms || 'Incoterm + named place'}
          hint={`Leave empty to print "${deliveryTerms || 'Incoterm + named place'}" from the Incoterm on the Invoice tab.`} />
      </Section>
    </>
  )
}
