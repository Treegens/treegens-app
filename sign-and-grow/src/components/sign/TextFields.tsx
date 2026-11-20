'use client';
import { AUTO, LABEL, fieldName, groupKey, isMulti, isSig, problemWith } from './fields';

// A signer's fields as an ordinary form, used by the text view. It reads and writes the same answers as the
// fields on the document, so switching between the two views loses nothing.

export type FieldCtx = {
  me: any;
  values: Record<string, string>;
  sig: string | null;
  ini: string | null;
  dateText: string;
  ordered: any[];
  uploading: string;
  filled: (f: any) => boolean;
  set: (id: string, v: string) => void;
  pickRadio: (f: any) => void;
  clickSig: (f: any) => void;
  attach: (f: any, file?: File) => void;
};

const Need = ({ f }: { f: any }) => <span className="hint"> ({f.required ? 'required' : 'optional'})</span>;
// Fields without a label are described by the words printed next to them on the page.
const Near = ({ id, text }: { id: string; text?: string }) => (text ? <span id={id} className="sg-near">Next to: {text}</span> : null);

function Row({ f, c, near }: { f: any; c: FieldCtx; near?: string }) {
  const id = `t-${f.id}`;
  const name = fieldName(f);
  const hint = !f.label && near ? near : '';
  const described = hint ? `${id}-near` : undefined;

  if (isSig(f)) {
    const word = f.type === 'signature' ? 'signature' : 'initials';
    const image = f.type === 'signature' ? c.sig : c.ini;
    return (
      <div className="sg-row">
        <div className="sg-row-label">{name}<Need f={f} /></div>
        <Near id={`${id}-near`} text={hint} />
        {c.filled(f) && image ? (
          <div className="sg-row-sig">
            <img src={image} alt={`Your ${word}`} />
            <button type="button" id={id} className="btn" onClick={() => c.clickSig(f)} aria-describedby={described}>Change or clear<span className="sg-vh"> your {word}</span></button>
          </div>
        ) : (
          <button type="button" id={id} className="btn primary" onClick={() => c.clickSig(f)} aria-describedby={described}>{f.type === 'signature' ? 'Sign here' : 'Initial here'}</button>
        )}
      </div>
    );
  }
  if (AUTO.includes(f.type) || f.readonly) {
    const shown = f.type === 'full_name' ? c.me.name : f.type === 'email' ? c.me.email : f.type === 'date_signed' ? c.dateText : f.type === 'checkbox' || f.type === 'radio' ? (f.value === '1' ? 'Ticked' : 'Not ticked') : f.value || 'Empty';
    return (
      <div className="sg-row">
        <div className="sg-row-label">{name}</div>
        <div>{shown} <span className="muted small">{f.readonly ? 'Filled in by the sender.' : 'Added for you.'}</span></div>
      </div>
    );
  }
  if (f.type === 'checkbox')
    return (
      <div className="sg-row">
        <label className="sg-choice">
          <input type="checkbox" id={id} checked={!!c.values[f.id]} onChange={(e) => c.set(f.id, e.target.checked ? '1' : '')} aria-describedby={described} />
          <span><span className="sg-choice-label">{f.label || 'Tick this box'}<Need f={f} /></span><Near id={`${id}-near`} text={hint} /></span>
        </label>
      </div>
    );
  if (f.type === 'dropdown')
    return (
      <div className="sg-row">
        <label className="f"><span>{name}<Need f={f} /></span>
          <select id={id} value={c.values[f.id] || ''} onChange={(e) => c.set(f.id, e.target.value)} aria-required={!!f.required} aria-describedby={described}>
            <option value="">Choose one</option>
            {(f.options || []).map((o: string) => <option key={o}>{o}</option>)}
          </select>
        </label>
        <Near id={`${id}-near`} text={hint} />
      </div>
    );
  if (f.type === 'attachment') {
    const busy = c.uploading === f.id;
    return (
      <div className="sg-row">
        <label className="f"><span>{name}<Need f={f} /></span>
          <input type="file" id={id} accept="application/pdf,image/png,image/jpeg" onChange={(e) => (c.attach(f, e.target.files?.[0]), (e.target.value = ''))} aria-describedby={`${id}-state`} />
        </label>
        <p id={`${id}-state`} className="muted small sg-row-state">
          {busy ? 'Uploading.' : c.values[f.id] ? 'A file is attached. Choose another to replace it.' : 'PDF, PNG or JPEG.'}
          {c.values[f.id] && !busy && <> <button type="button" className="sg-link" onClick={() => c.set(f.id, '')}>Remove the file</button></>}
        </p>
      </div>
    );
  }
  const problem = problemWith(f, c.values[f.id] || '');
  const shared = { id, value: c.values[f.id] || '', 'aria-required': !!f.required, 'aria-invalid': !!problem, 'aria-describedby': [described, problem ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined };
  return (
    <div className="sg-row">
      <label className="f"><span>{name}<Need f={f} /></span>
        {isMulti(f)
          ? <textarea {...shared} rows={3} onChange={(e) => c.set(f.id, e.target.value)} />
          : <input {...shared} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} autoComplete={f.type === 'company' ? 'organization' : f.type === 'title' ? 'organization-title' : 'off'} onChange={(e) => c.set(f.id, e.target.value)} />}
      </label>
      <Near id={`${id}-near`} text={hint} />
      {problem && <p id={`${id}-err`} className="sg-fielderr">{problem}</p>}
    </div>
  );
}

/** Everything this signer has on one page, in reading order. Returns nothing when the page has no fields for them. */
export function PageFields({ docId, page, c, near }: { docId: string; page: number; c: FieldCtx; near?: (f: any) => string }) {
  const here = c.ordered.filter((f) => f.document_id === docId && f.page === page);
  if (!here.length) return null;
  const seen = new Set<string>();
  return (
    <div className="sg-form" role="group" aria-label={`Your fields on page ${page + 1}`}>
      <div className="sg-form-title">For you to fill in on this page</div>
      {here.map((f) => {
        if (f.type !== 'radio' || f.readonly) return <Row key={f.id} f={f} c={c} near={near?.(f)} />;
        const key = groupKey(f);
        if (seen.has(key)) return null;
        seen.add(key);
        // A group is shown once, where its first button sits, even when the buttons are spread over the page.
        const members = c.ordered.filter((x) => x.type === 'radio' && !x.readonly && groupKey(x) === key);
        if (members[0].id !== f.id) return null;
        return (
          <fieldset key={f.id} className="sg-row sg-choices">
            <legend>{f.group_name || 'Choose one'}<span className="hint"> ({members.some((m) => m.required) ? 'required' : 'optional'})</span></legend>
            {members.map((m, i) => (
              <label key={m.id} className="sg-choice">
                <input type="radio" name={`t-${key}`} id={`t-${m.id}`} checked={!!c.values[m.id]} onChange={() => c.pickRadio(m)} />
                <span><span className="sg-choice-label">{m.label || `Option ${i + 1}`}</span>{!m.label && near?.(m) ? <span className="sg-near">Next to: {near(m)}</span> : null}</span>
              </label>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

/** What other people already put on this page, as text. */
export function PageOthers({ others }: { others: any[] }) {
  if (!others.length) return null;
  return (
    <div className="sg-others">
      <div className="sg-form-title">Already filled in by others on this page</div>
      <ul>
        {others.map((f) => (
          <li key={f.id}>
            {LABEL[f.type] || 'Field'}: {f.image ? <img src={f.image} alt="Signed" /> : f.type === 'checkbox' || f.type === 'radio' ? (f.value === '1' ? 'ticked' : 'not ticked') : f.value}
          </li>
        ))}
      </ul>
    </div>
  );
}
