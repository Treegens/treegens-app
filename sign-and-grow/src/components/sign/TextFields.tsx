'use client';
import { AUTO, LABEL, fieldName, groupKey, isMulti, isSig, problemWith, inputLimit, amountHint, lengthHint, boxRuleHint } from './fields';
import { formatDateValue } from '@/lib/dates';
import { NUMBER_HINT } from '@/lib/numbers';
import { isStrike, strikeSays } from '@/lib/strike';

// A signer's fields as an ordinary form, used by the text view. It reads and writes the same answers as the
// fields on the document, so switching between the two views loses nothing.

export type FieldCtx = {
  me: any;
  values: Record<string, string>;
  sig: string | null;
  ini: string | null;
  dateText: string;
  /** The format the sender chose for dates on this envelope. A picked date is said back in it. */
  dateFormat?: string | null;
  ordered: any[];
  uploading: string;
  filled: (f: any) => boolean;
  set: (id: string, v: string) => void;
  pickRadio: (f: any) => void;
  clickSig: (f: any) => void;
  attach: (f: any, file?: File) => void;
  /** Opens the dialog that puts this person's stamp on a stamp field (src/components/stamps/StampDialog.tsx). */
  clickStamp?: (f: any) => void;
  /** Where the picture of the stamp on a field of theirs is, or null while there is none. */
  stampUrl?: (f: any) => string | null;
};

const Need = ({ f }: { f: any }) => <span className="hint"> ({f.required ? 'required' : 'optional'})</span>;
// Fields without a label are described by the words printed next to them on the page.
const Near = ({ id, text }: { id: string; text?: string }) => (text ? <span id={id} className="sg-near">Next to: {text}</span> : null);

function Row({ f, c, near }: { f: any; c: FieldCtx; near?: string }) {
  const id = `t-${f.id}`;
  const name = fieldName(f);
  // Company and job title already say what they are. Everything else unlabelled borrows the words printed beside it.
  const hint = !f.label && near && f.type !== 'company' && f.type !== 'title' ? near : '';
  const described = hint ? `${id}-near` : undefined;

  // A stamp: the picture they put on, said in words, and the one button that opens the dialog to put it on or change it.
  if (f.type === 'stamp') {
    const url = c.stampUrl?.(f) || null;
    return (
      <div className="sg-row">
        <div className="sg-row-label">{name}<Need f={f} /></div>
        <Near id={`${id}-near`} text={hint} />
        <div className="sg-row-stamp">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {url && <img src={url} alt="Your stamp, as it is printed on the document" />}
          <button type="button" id={id} className={`btn${url ? '' : ' primary'}`} onClick={() => c.clickStamp?.(f)} aria-describedby={described}>{url ? <>Change or take off<span className="sg-vh"> your stamp</span></> : 'Put your stamp on'}</button>
        </div>
      </div>
    );
  }
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
    const shown = f.type === 'full_name' ? c.me.name : f.type === 'email' ? c.me.email : f.type === 'date_signed' ? c.dateText : f.type === 'checkbox' || f.type === 'radio' ? (f.value === '1' ? 'Ticked' : 'Not ticked') : f.type === 'date' ? formatDateValue(f.value, c.dateFormat) || 'Empty' : f.value || 'Empty';
    return (
      <div className="sg-row">
        <div className="sg-row-label">{name}</div>
        <div><bdi>{shown}</bdi> <span className="muted small">{f.calc_note || (f.readonly ? 'Filled in by the sender.' : 'Added for you.')}</span></div>
      </div>
    );
  }
  if (f.type === 'checkbox')
    return (
      <div className="sg-row">
        <label className="sg-choice">
          <input type="checkbox" id={id} checked={!!c.values[f.id]} onChange={(e) => c.set(f.id, e.target.checked ? '1' : '')} aria-describedby={described} />
          <span className="sg-choice-label">{f.label || 'Tick this box'}<Need f={f} /></span>
        </label>
        <Near id={`${id}-near`} text={hint} />
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
        <p id={`${id}-state`} className="muted small sg-row-state">{busy ? 'Uploading.' : c.values[f.id] ? 'A file is attached. Choose another to replace it.' : 'PDF, PNG or JPEG.'}</p>
        {c.values[f.id] && !busy && <button type="button" className="btn sm sg-row-remove" onClick={() => c.set(f.id, '')}>Remove the file</button>}
      </div>
    );
  }
  const problem = problemWith(f, c.values[f.id] || '', c.dateFormat);
  // dir="auto": right-to-left text (Arabic, Hebrew, Persian) starts at the right edge, by what is typed.
  const shared = { dir: 'auto' as const, id, value: c.values[f.id] || '', maxLength: inputLimit(f), 'aria-required': !!f.required, 'aria-invalid': !!problem, 'aria-describedby': [described, problem ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined };
  return (
    <div className="sg-row">
      <label className="f"><span>{name}<Need f={f} /></span>
        {isMulti(f)
          ? <textarea {...shared} rows={3} onChange={(e) => c.set(f.id, e.target.value)} />
          : <input {...shared} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} autoComplete={f.type === 'company' ? 'organization' : f.type === 'title' ? 'organization-title' : 'off'} onChange={(e) => c.set(f.id, e.target.value)} />}
      </label>
      <Near id={`${id}-near`} text={hint} />
      {problem && <p id={`${id}-err`} className="sg-fielderr">{problem}</p>}
      {lengthHint(f, c.values[f.id] || '') && !problem && <p className="muted small sg-row-state" aria-live="polite">{lengthHint(f, c.values[f.id] || '')}</p>}
      {f.type === 'number' && !problem && <p className="muted small sg-row-state">{amountHint(f) ? `${amountHint(f)} ` : ''}{NUMBER_HINT}</p>}
      {f.type === 'date' && c.values[f.id] && <p className="muted small sg-row-state">On the document this date is written as {formatDateValue(c.values[f.id], c.dateFormat)}.</p>}
    </div>
  );
}

/** Everything this signer has on one page, in reading order. Returns nothing when the page has no fields for them. */
// `only`: Easy reading shows the fields of a page in a few places, each where it sits in the text (sign/reflow.ts),
// so it names which fields go here, and `title` says "here" instead of "on this page".
export function PageFields({ docId, page, c, near, only, title }: { docId: string; page: number; c: FieldCtx; near?: (f: any) => string; only?: string[]; title?: string }) {
  const here = c.ordered.filter((f) => f.document_id === docId && f.page === page && (!only || only.includes(f.id)))
    // A choice group is shown where its first button is: a part of the text with only later buttons shows no empty box.
    .filter((f) => !only || f.type !== 'radio' || f.readonly || c.ordered.find((x) => x.type === 'radio' && !x.readonly && groupKey(x) === groupKey(f))?.id === f.id);
  if (!here.length) return null;
  const seen = new Set<string>();
  return (
    <div className="sg-form" role="group" aria-label={`Your fields on page ${page + 1}`}>
      <div className="sg-form-title">{title || 'For you to fill in on this page'}</div>
      {here.map((f) => {
        // The first tick box of a group with a rule says the rule, so nobody learns it only when Finish is refused.
        const rule = f.type === 'checkbox' && !f.readonly && c.ordered.find((x) => x.type === 'checkbox' && x.group_name === f.group_name)?.id === f.id ? boxRuleHint(f, c.ordered) : '';
        if (rule) return <div key={f.id}><p className="sg-row-rule small"><b>{rule}</b></p><Row f={f} c={c} near={near?.(f)} /></div>;
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

/** Who put something on the page that is not this signer's to fill in. Said next to it in both views. */
export function otherSource(f: any, senderName: string): string {
  if (isStrike(f)) return `Struck out by ${senderName}.`;
  // A stamp is a picture someone put on the page: who, and nothing more (src/lib/stamps.ts).
  if (f.type === 'stamp') return f.by ? `Put on by ${f.by}.` : `Put on by ${senderName}, who sent this document.`;
  if (f.from === 'start') return `Filled in by ${senderName} for ${f.by || 'another signer'}, who can still change it.`;
  if (f.from === 'sender') return f.by ? `Written by ${senderName}, in the part for ${f.by}.` : `Written by ${senderName}.`;
  return `Filled in by ${f.by || 'another signer'}.`;
}

/** What is already on this page besides the signer's own fields, as text: the sender's wording and what others filled in. */
export function PageOthers({ others, senderName, near }: { others: any[]; senderName: string; near?: (f: any) => string }) {
  if (!others.length) return null;
  return (
    <div className="sg-others">
      <div className="sg-form-title">Already on this page, from {senderName} and other signers</div>
      <ul>
        {others.map((f) => (isStrike(f) ? (
          // A line through printed wording cannot be read out, so it is said: who drew it, and at which printed line.
          <li key={f.id}><b>Struck out:</b> {strikeSays(senderName, near?.(f))}</li>
        ) : (
          <li key={f.id}>
            {f.label || LABEL[f.type] || 'Field'}: {f.type === 'stamp' && f.image ? <img className="st-thumb" src={f.image} alt={f.stamp?.name ? `The stamp "${f.stamp.name}"` : 'A stamp'} /> : f.image ? <img src={f.image} alt="Signed" /> : f.type === 'checkbox' || f.type === 'radio' ? (f.value === '1' ? 'ticked' : 'not ticked') : <bdi>{f.value}</bdi>}
            {' '}<span className="muted small">{otherSource(f, senderName)}</span>
          </li>
        )))}
      </ul>
    </div>
  );
}
