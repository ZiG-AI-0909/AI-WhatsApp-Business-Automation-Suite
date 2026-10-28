import { Segments, money } from './fields.jsx'
import logoUrl from './sudarshan-logo.png'

// On-screen replica of the exported sheet (backend/src/proforma/
// proformaExport.js): same 12-column grid A..L, same boxes and borders.
// Values come from the form; totals, words and placeholder text from the
// backend preview, so the screen and the Excel file agree.

const COLUMN_PX = [48, 40, 60, 32, 48, 87, 91, 66, 72, 86, 88, 88]
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function C({ span = 1, rows = 1, b = '', bold, center, right, top, bottom, small, under, children }) {
  const className = [
    ...b.split('').map((side) => `pv-${side}`),
    bold && 'pv-bold', center && 'pv-center', right && 'pv-right', top && 'pv-top', bottom && 'pv-bottom', small && 'pv-small', under && 'pv-under',
  ].filter(Boolean).join(' ')
  return <td colSpan={span > 1 ? span : undefined} rowSpan={rows > 1 ? rows : undefined} className={className || undefined}>{children}</td>
}

const join = (parts, separator = ', ') => parts.map((part) => String(part || '').trim()).filter(Boolean).join(separator)

function withCountry(address, country) {
  const text = String(address || '').trim()
  const name = String(country || '').trim()
  if (!name || text.toLowerCase().replace(/[\s.]+$/, '').endsWith(name.toLowerCase())) return text
  return text ? `${text}, ${name}` : name
}

function addressLines(address) {
  const lines = String(address || '').split('\n').map((line) => line.trim()).filter(Boolean)
  return [lines[0] || '', lines.slice(1).join(', ')]
}

function Dated({ date }) {
  const [year, month, day] = String(date || '').split('-').map(Number)
  if (!year || !month || !day) return 'Dated:'
  const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th')
  return <>Dated: {day}<sup>{suffix}</sup> {MONTHS[month - 1]} {year}</>
}

// "Label: value | Label: value" with bold labels, as printed.
function Labelled({ parts }) {
  const kept = parts.filter(([, value]) => String(value || '').trim())
  return kept.map(([label, value], index) => <span key={label}>{index ? ' | ' : ''}<strong>{label}</strong>{String(value).trim()}</span>)
}

const coupler = (value) => {
  const text = String(value || '').trim()
  return !text || /^\(.*\)$/.test(text) ? text : `(${text})`
}

const num = (value, digits = 2) => {
  if (value === '' || value === null || value === undefined) return ''
  const number = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(number) ? number.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : String(value)
}

export default function InvoicePreview({ invoice, preview }) {
  const totals = preview?.totals
  const texts = preview?.texts
  const currency = invoice.invoice.currency
  const { exporter, consignee, buyer, shipping, bank } = invoice
  const [address1, address2] = addressLines(exporter.address)
  const amounts = new Map((totals?.items || []).map((item) => [item.id, item.amount]))
  const otherAmounts = new Map((totals?.other_charges || []).map((item) => [item.id, item.amount]))
  const enquiry = join([invoice.invoice.enquiry_ref.replace(/\s*\n\s*/g, ' '), invoice.invoice.po_number ? `PO No. ${invoice.invoice.po_number}${invoice.invoice.po_date ? ` dated ${invoice.invoice.po_date}` : ''}` : ''], '; ')
  const termTexts = new Map((texts?.terms || []).map((entry) => [entry.id, entry]))
  const terms = invoice.terms.filter((term) => term.title.trim() || term.text.trim())
  const buyerName = (buyer.signatory_name || (buyer.name || consignee.name || '').toUpperCase()).trim()
  const letterhead = invoice.letterhead || {}
  const [buyer1, buyer2] = addressLines(withCountry(buyer.address, buyer.country))
  const footer = [letterhead.footer_title, letterhead.footer_address, letterhead.footer_contact].map((line) => String(line || '').trim())

  const tableRow = (key, { A, B, H, I, J, K, L }, { full, bold } = {}) => {
    const sides = full ? 'tlbr' : 'lr'
    return (
      <tr key={key}>
        <C b={sides} center bold={bold}>{A}</C>
        <C span={6} b={sides} bold={bold}>{B}</C>
        <C b={sides} center>{H}</C>
        <C b={sides} center>{I}</C>
        <C b={sides} right bold={bold}>{J}</C>
        <C b={sides} right>{K}</C>
        <C b={sides} right bold={bold}>{L}</C>
      </tr>
    )
  }

  const itemRows = []
  let group = null
  invoice.items.forEach((item, index) => {
    const heading = item.description.trim()
    if (heading && heading !== group) itemRows.push(tableRow(`g-${item.id}`, { B: heading }, { bold: true }))
    group = heading || group
    itemRows.push(
      <tr key={item.id}>
        <C b="lr" center>{index + 1}</C>
        <C b="l">{item.size}</C>
        <C span={3}>{item.specification}</C>
        <C>{item.pressure}</C>
        <C b="r" small>{coupler(item.coupler)}</C>
        <C b="lr" center>{item.length !== '' && item.length !== null ? `${num(item.length, 1)} Mtr.` : ''}</C>
        <C b="lr" center>{item.hsn}</C>
        <C b="lr" right>{num(item.qty, 0)}</C>
        <C b="lr" right>{num(item.rate)}</C>
        <C b="lr" right>{amounts.get(item.id) == null ? '' : money(amounts.get(item.id))}</C>
      </tr>,
    )
  })

  const freightRow = (key, freight, amount) => tableRow(key, { B: freight.description, H: freight.unit, J: num(freight.qty, 0), K: num(freight.rate), L: amount == null ? '' : money(amount) }, { full: true })

  return (
    <div className="pv-wrap">
      <table className="pv-sheet" aria-label="Proforma invoice preview">
        <colgroup>{COLUMN_PX.map((px, index) => <col key={index} style={{ width: px }} />)}</colgroup>
        <tbody>
          {letterhead.show_logo !== false && <tr className="pv-logo"><td colSpan={12}><img src={logoUrl} alt="Sudarshan Pipes & Fittings" /></td></tr>}
          <tr><C span={12} b="b" bold center>PROFORMA INVOICE</C></tr>
          <tr><C span={7} b="tl" bold>Manufacturer &amp; Exporter:</C><C span={5} b="tlr" bold>Proforma Invoice No. &amp; Date</C></tr>
          <tr><C span={7} b="l" bold>{exporter.name}</C><C span={5} b="lr">{invoice.invoice.number}</C></tr>
          <tr><C span={7} b="l">{address1}</C><C span={5} rows={2} b="lrb" bold top><Dated date={invoice.invoice.date} /></C></tr>
          <tr><C span={7} b="l">{address2}</C></tr>
          <tr><C span={7} b="l"><Labelled parts={[['GSTIN: ', exporter.gstin], ['IEC: ', exporter.iec]]} /></C><C span={5} b="lr" bold>Buyer&apos;s Enquiry / Purchase Order No. &amp; Date</C></tr>
          <tr><C span={7} b="lb"><Labelled parts={[['Contact: ', exporter.contact]]} /></C><C span={5} b="lrb" small>{enquiry}</C></tr>

          <tr><C span={7} b="l" bold>Consignee:</C><C span={5} b="lr" bold>Buyer / Notifying Party: (If other than Consignee)</C></tr>
          <tr><C span={7} b="l" bold>{consignee.name}</C><C span={5} b="lr" bold>{buyer.name}</C></tr>
          <tr><C span={7} b="l">{withCountry(consignee.address, consignee.country).replace(/\s*\n\s*/g, ', ')}</C><C span={5} b="lr">{buyer1}</C></tr>
          <tr><C span={7} b="l"><Labelled parts={[['Tax Registration Number: ', consignee.tax_id]]} /></C><C span={5} b="lr">{buyer2}</C></tr>
          <tr><C span={7} b="l"><Labelled parts={[['ACID No.: ', consignee.acid]]} /></C><C span={5} b="lr"><Labelled parts={[['Tax Registration Number: ', buyer.tax_id]]} /></C></tr>
          <tr><C span={7} b="lb"><Labelled parts={[['Email ID: ', consignee.email], ['Tel. ', consignee.phone]]} /></C><C span={5} b="lrb"><Labelled parts={[['Attn: ', buyer.contact_person], ['Emailid: ', buyer.email], ['Tel. ', buyer.phone]]} /></C></tr>

          <tr><C span={3} b="l" bold>Pre - Carriage by</C><C span={4} b="l" bold>Place of Receipt by Pre - Carrier</C><C span={3} b="l" bold>Country of Origin of Goods</C><C span={2} b="lr" bold>Country of Final Destination</C></tr>
          <tr><C span={3} b="lb">{shipping.pre_carriage}</C><C span={4} b="lb">{shipping.place_of_receipt}</C><C span={3} b="lb" center>{shipping.origin_country}</C><C span={2} b="lrb" center>{shipping.destination_country}</C></tr>

          <tr><C span={3} b="l" bold>Container No.</C><C span={4} b="l" bold>Port of Loading</C><C span={5} b="lr" bold>Terms of Delivery and Payment:</C></tr>
          <tr><C span={3} b="l">{shipping.container_no}</C><C span={4} rows={2} b="lb" bottom>{shipping.port_of_loading}</C><C span={5} b="lr"><Labelled parts={[['Delivery: ', texts?.delivery_terms]]} /></C></tr>
          <tr><C span={3} b="lb"><strong>Vessel / Flight No.</strong>{shipping.vessel_no ? ` ${shipping.vessel_no}` : ''}</C><C span={5} rows={2} b="lr" top><span className="pv-pre"><Segments value={texts?.payment} /></span></C></tr>
          <tr><C span={3} b="l" bold>Port of Discharge</C><C span={4} b="l" bold>Final Destination</C></tr>
          <tr><C span={3} rows={3} b="lb">{shipping.port_of_discharge}</C><C span={4} rows={3} b="lb">{shipping.place_of_delivery}</C><C span={5} b="lr" bold under>Payment to be made to our bank account:</C></tr>
          <tr><C span={5} b="lr">{join([bank.name, bank.branch])}</C></tr>
          <tr><C span={5} b="lrb">{bank.account && <>A/c No.: <strong>{bank.account}</strong></>}{bank.swift && <> SWIFT Code: <strong>{bank.swift}</strong></>}{bank.ifsc && ` IFSC: ${bank.ifsc}`}</C></tr>

          <tr className="pv-head">
            <C b="tlbr" bold center>Sl. No.</C><C span={6} b="tlbr" bold center>Description of Goods</C><C b="tlbr" bold center>Length per Piece</C>
            <C b="tlbr" bold center>H S Code</C><C b="tlbr" bold center>Quantity (Pieces)</C><C b="tlbr" bold center>Unit Price ({currency} / Piece)</C><C b="tlbr" bold center>Amount ({currency})</C>
          </tr>
          {itemRows}
          {tableRow('exw', { A: 'I', B: 'Total - Ex-Works', J: totals ? Number(totals.total_qty).toLocaleString('en-US') : '', L: money(totals?.ex_works) }, { full: true, bold: true })}
          {invoice.inland_freight.include && freightRow('inland', invoice.inland_freight, totals?.inland_freight)}
          {tableRow('fob', { A: 'II', B: 'Total - FOB Value', L: money(totals?.fob) }, { full: true, bold: true })}
          {invoice.ocean_freight.include && tableRow('fc', { B: 'Freight Charges #' }, { full: true, bold: true })}
          {invoice.ocean_freight.include && freightRow('ocean', invoice.ocean_freight, totals?.ocean_freight)}
          {invoice.other_charges.map((charge) => freightRow(charge.id, { ...charge, description: charge.include_in_total ? charge.description : `${charge.description} (not included in Grand Total)` }, otherAmounts.get(charge.id)))}
          {tableRow('grand', { A: 'III', B: `Total - ${join([shipping.incoterm, 'Value'], ' ')}`, L: money(totals?.grand_total) }, { full: true, bold: true })}

          <tr><C span={4} b="tlbr" bold>Amount in Words:</C><C span={8} b="tlbr">{totals?.amount_in_words}</C></tr>
          <tr><C span={12} b="tlbr" bold>TERMS &amp; CONDITIONS:</C></tr>
          {terms.map((term, index) => (
            <tr key={term.id}>
              <C b="tlbr" bold center>{index + 1}</C>
              <C span={3} b="tlbr" bold>{term.title}</C>
              <C span={8} b="tlbr"><span className="pv-pre"><Segments value={termTexts.get(term.id)} /></span></C>
            </tr>
          ))}

          <tr><C span={7} b="tl" bold center>Accepted By Buyer</C><C span={5} b="tr" /></tr>
          <tr><C span={7} b="l" bold center>{buyerName ? `For ${buyerName}` : 'For Buyer'}</C><C span={5} b="r" bold center>For {exporter.signatory_name || exporter.name}</C></tr>
          <tr className="pv-sign"><C span={7} b="l" /><C span={5} b="r" /></tr>
          <tr><C span={7} b="lb" bold center>Authorised Signatory</C><C span={5} b="rb" bold center>Authorised Signatory</C></tr>
          {footer.some(Boolean) && <tr className="pv-gap"><td colSpan={12} /></tr>}
          {footer[0] && <tr className="pv-footer pv-footer-title"><td colSpan={12}>{footer[0]}</td></tr>}
          {footer[1] && <tr className="pv-footer"><td colSpan={12}>{footer[1]}</td></tr>}
          {footer[2] && <tr className="pv-footer"><td colSpan={12}>{footer[2]}</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
