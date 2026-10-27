import { Segments } from './fields.jsx'

// Numbered terms. Wording is kept exactly as typed (multi-line allowed);
// **bold** prints bold and {placeholders} are filled from the invoice.
export default function TermsConditionsEditor({ terms, texts, form, onAdd, onRemove, onMove, onRestore }) {
  const resolved = new Map((texts || []).map((entry) => [entry.id, entry]))
  return (
    <section className="pf-section">
      <div className="pf-section-head">
        <div>
          <h3>Terms & conditions</h3>
          <p className="muted-copy">
            Use <code>**bold**</code> for bold text. Placeholders: <code>{'{incoterm}'}</code> <code>{'{incoterm_place}'}</code> <code>{'{currency}'}</code> <code>{'{advance}'}</code> <code>{'{balance}'}</code> <code>{'{grand_total}'}</code> <code>{'{bank_name}'}</code> <code>{'{bank_branch}'}</code> <code>{'{bank_account}'}</code> <code>{'{bank_swift}'}</code> <code>{'{bank_ifsc}'}</code>
          </p>
        </div>
        <div className="button-row">
          <button type="button" className="secondary-btn" onClick={onRestore}>Restore standard terms</button>
          <button type="button" className="primary-btn" onClick={onAdd}>Add term</button>
        </div>
      </div>
      <ol className="pf-terms">
        {terms.map((term, index) => {
          const titleError = form.error(`terms.${term.id}.title`)
          const textError = form.error(`terms.${term.id}.text`)
          return (
            <li key={term.id} className="pf-term">
              <span className="pf-term-number" aria-hidden="true">{index + 1}</span>
              <div className="pf-term-body">
                <input value={term.title} onChange={(event) => form.setTerm(term.id, 'title', event.target.value)} onBlur={() => form.touch(`terms.${term.id}.title`)}
                  aria-label={`Term ${index + 1} title`} placeholder="Title" aria-invalid={titleError ? 'true' : undefined} />
                {titleError && <small className="pf-error" role="alert">{titleError}</small>}
                <textarea className="pf-textarea" rows={Math.min(6, Math.max(2, Math.ceil(term.text.length / 90) + (term.text.match(/\n/g) || []).length))}
                  value={term.text} onChange={(event) => form.setTerm(term.id, 'text', event.target.value)} onBlur={() => form.touch(`terms.${term.id}.text`)}
                  aria-label={`Term ${index + 1} text`} aria-invalid={textError ? 'true' : undefined} />
                {textError && <small className="pf-error" role="alert">{textError}</small>}
                {!textError && form.flag(`terms.${term.id}.text`) && <small className="pf-flag">{form.flag(`terms.${term.id}.text`)}</small>}
                {/[{*]/.test(term.text) && resolved.get(term.id) && <p className="pf-resolved"><span>Prints as: </span><Segments value={resolved.get(term.id)} /></p>}
              </div>
              <div className="pf-row-actions">
                <button type="button" className="ghost-btn" onClick={() => onMove(term.id, -1)} disabled={index === 0} aria-label={`Move term ${index + 1} up`}>↑</button>
                <button type="button" className="ghost-btn" onClick={() => onMove(term.id, 1)} disabled={index === terms.length - 1} aria-label={`Move term ${index + 1} down`}>↓</button>
                <button type="button" className="danger-btn" onClick={() => onRemove(term.id)}>Remove</button>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
