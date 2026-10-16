import Icon from '../components/Icon.jsx'
import { formatIN, formatMoney, parseNumber, round2, rowStatus } from './boqReview.js'

/** Step 3: the BOQ is confirmed — make the quotation or the RFQ. */
export default function BoqDone({ doc, onCreateQuotation, creatingQuote, onExport, exporting, onReopen, busy }) {
  const items = doc.items || []
  const lines = items.filter((item) => item.forQuotation).length
  const fixed = items.filter((item) => item.fixed).length
  const kept = items.filter((item) => rowStatus(item) === 'kept')
  const sum = round2(items.reduce((total, item) => total + (parseNumber(item.amount) || 0), 0))
  const printed = doc.extraction_metadata?.validation?.printedTotal ?? null
  const difference = printed === null ? null : round2(printed - sum)

  return (
    <section className="panel boq-done" aria-labelledby="boq-done-title">
      <div className="boq-done-head">
        <span className="boq-done-icon" aria-hidden="true"><Icon name="check-circle" size={30} /></span>
        <div>
          <p className="eyebrow">Step 3</p>
          <h2 id="boq-done-title">BOQ confirmed</h2>
          <p className="muted-copy">{doc.filename}</p>
        </div>
      </div>

      <ul className="boq-done-facts">
        <li><Icon name="clipboard" size={16} /> <strong className="mono">{formatIN(items.length)}</strong> items confirmed</li>
        <li><Icon name="layers" size={16} /> <strong className="mono">{formatIN(lines)}</strong> pipe and stoneware lines for the quotation</li>
        <li><Icon name="check" size={16} /> <strong className="mono">{formatIN(fixed)}</strong> {fixed === 1 ? 'row' : 'rows'} corrected by you</li>
        {kept.length > 0 && <li><Icon name="info" size={16} /> <strong className="mono">{kept.length}</strong> kept as printed: {kept.slice(0, 4).map((item) => `S.No ${item.serialNumber || '?'} (${item.acceptance?.reason || 'no reason'})`).join('; ')}{kept.length > 4 ? '; …' : ''}</li>}
      </ul>

      {difference !== null && Math.abs(difference) > 1 && (
        <div className="notice warning" role="status">
          Printed total {formatMoney(printed)} and the sum of amounts {formatMoney(sum)} still differ by <strong>{formatMoney(Math.abs(difference))}</strong>. The quotation uses your own rates, so this does not affect it.
        </div>
      )}

      <div className="boq-done-actions">
        <button type="button" className="primary-btn boq-big-btn" onClick={onCreateQuotation} disabled={creatingQuote || !lines}>
          <Icon name="receipt" size={20} /> {creatingQuote ? 'Preparing…' : 'Create quotation'}
        </button>
        <button type="button" className="secondary-btn boq-big-btn" onClick={() => onExport('excel')} disabled={!!exporting}>
          <Icon name="download" size={20} /> {exporting === 'excel' ? 'Building…' : 'Download RFQ (Excel)'}
        </button>
      </div>
      <div className="button-row">
        <button type="button" className="ghost-btn" onClick={() => onExport('pdf')} disabled={!!exporting}>{exporting === 'pdf' ? 'Building…' : 'Download RFQ as PDF'}</button>
        <button type="button" className="ghost-btn" onClick={onReopen} disabled={busy}>Make changes to the rows</button>
      </div>
      {!lines && <p className="file-note">No pipe or stoneware lines were found, so there is nothing to quote.</p>}
    </section>
  )
}
