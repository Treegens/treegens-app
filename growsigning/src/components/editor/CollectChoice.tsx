'use client';
// Step 3, More options: "Ask for a payment" (research/ux-notes.json, ds-pay-collect). One control for both ways:
// by card here, into the account's own Stripe account (src/server/routes-collect.ts), or a link to the sender's own
// payment page (PayLinkCard in PayLinkChoice.tsx). Where the account has not connected Stripe, or this server does not take
// payments, this is exactly the payment link as it was: nothing new to read or choose.
//
// It saves by itself, as the other step 3 controls do: a choice at once, typing a moment after the last key. "No
// payment" takes a saved card payment off. Send waits for a save still on its way and stops, in words, when what is
// typed could not be saved (flushCollect, called by Editor.tsx), so a typed payment is never silently left out.
import { useEffect, useRef, useState } from 'react';
import { api, toast } from '../ui';
import { PayLinkCard } from './PayLinkChoice';
import { CURRENCIES, COLLECT_FOR_MAX, COLLECT_FOR_SENDER, COLLECT_HOW, WHEN_WORDS, WHEN_HINT, collectSummary, type CollectWhen } from '@/lib/collect';

type Setting = { amount: number | null; field_id: string | null; currency: string; for: string; when: CollectWhen; amount_text: string | null; field_label: string | null; field_gone: boolean } | null;
type State = { available: boolean; connected?: { name: string } | null; may?: boolean; why?: string | null; setting: Setting; pay_link?: boolean; fields?: { id: string; label: string }[] };
type LinkProps = Parameters<typeof PayLinkCard>[0];

/** Per document: a save on its way, and what is typed but not saved (and why). Read by flushCollect at Send. */
const pending = new Map<string, { saving?: Promise<void>; problem?: string }>();
const NOT_SAVED = 'Your payment is not saved yet.';

/**
 * Called by Send: waits for a payment save still on its way, then says why the payment typed on this document is
 * not saved, or null when there is nothing unsaved.
 */
export async function flushCollect(envelopeId: string): Promise<string | null> {
  const p = pending.get(envelopeId);
  if (p?.saving) await p.saving.catch(() => {});
  const q = pending.get(envelopeId);
  return q?.problem ? `${NOT_SAVED} ${q.problem}` : null;
}

export function AskPayment(props: LinkProps) {
  const { envelopeId } = props;
  const [st, setSt] = useState<State | null>(null);
  const [mode, setMode] = useState<'none' | 'card' | 'link'>('none');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!envelopeId) return;
    let live = true;
    api<State>(`/envelopes/${envelopeId}/collect`).then((r) => {
      if (!live) return;
      setSt(r);
      setMode(r.setting ? 'card' : r.pay_link ? 'link' : 'none');
    }).catch(() => live && setSt({ available: false, setting: null }));
    return () => {
      live = false;
      pending.delete(envelopeId);
    };
  }, [envelopeId]);
  if (!st) return null;
  // Nothing to choose between: the payment link as it always was.
  const card = st.available && !!st.connected && !!st.may;
  if (!card && !st.setting) return <PayLinkCard {...props} />;
  // Another way than "By card": a saved card payment is taken off at once, and that is said.
  const choose = async (k: 'none' | 'card' | 'link') => {
    setError('');
    if (k !== 'card') pending.delete(envelopeId!);
    setMode(k);
    if (k === 'card' || !st.setting) return;
    try {
      await api(`/envelopes/${envelopeId}/collect`, { method: 'PUT', body: { off: true } });
      setSt({ ...st, setting: null });
      toast('Payment taken off. Nobody was emailed.');
    } catch (e: any) {
      setMode('card');
      setError(e?.message || 'The payment could not be taken off. Try again in a moment.');
    }
  };
  return (
    <div className="card" data-feature="ds-pay-collect">
      <h3 style={{ margin: '0 0 4px' }}>Ask for a payment <span className="muted small">(optional)</span></h3>
      <fieldset className="f" style={{ border: 0, padding: 0, margin: '0 0 8px' }}>
        <legend className="sg-vh">How people pay</legend>
        {([['none', 'No payment'], ['card', `By card here, into your Stripe account${st.connected?.name ? ` (${st.connected.name})` : ''}`], ['link', 'On your own payment page']] as const).map(([k, l]) => (
          <label key={k} className="check" style={{ minHeight: 44 }}><input type="radio" name={`ask-pay-${envelopeId}`} checked={mode === k} onChange={() => choose(k)} /> {l}</label>
        ))}
      </fieldset>
      {error && <div className="notice err" role="alert">{error}</div>}
      {mode === 'card' && <CardForm envelopeId={envelopeId!} st={st} onSaved={(setting, linkGone) => setSt((x) => (x ? { ...x, setting, pay_link: linkGone ? false : x.pay_link } : x))} />}
      {mode === 'link' && <PayLinkCard {...props} />}
    </div>
  );
}

function CardForm({ envelopeId, st, onSaved }: { envelopeId: string; st: State; onSaved: (s: Setting, linkGone: boolean) => void }) {
  const s = st.setting;
  const fields = st.fields || [];
  const [from, setFrom] = useState<'fixed' | 'field'>(s?.field_id ? 'field' : 'fixed');
  const [amount, setAmount] = useState(s?.amount_text ? s.amount_text.split(' ')[0] : '');
  const [field, setField] = useState(s?.field_id || fields[0]?.id || '');
  const [currency, setCurrency] = useState(s?.currency || 'eur');
  const [what, setWhat] = useState(s?.for || '');
  const [when, setWhen] = useState<CollectWhen>(s?.when || 'after');
  const [said, setSaid] = useState<'' | 'saving' | 'saved'>('');
  const [error, setError] = useState('');
  const first = useRef(true);
  const link = useRef(!!st.pay_link);
  const fixed = from === 'fixed' || !fields.length;
  // Declared first, so its clean-up runs first: closing More options before the save went out still saves it.
  const leaving = useRef(false);
  useEffect(() => {
    leaving.current = false;
    return () => void (leaving.current = true);
  }, []);
  useEffect(() => {
    // Nothing to save on first show: it is what is saved already.
    if (first.current) return void (first.current = false);
    const missing = !what.trim() ? 'Say what the payment is for, under "What it is for".' : fixed && !amount.trim() ? 'Type how much, under "Amount".' : '';
    if (missing) {
      pending.set(envelopeId, { problem: `${missing} Or choose "No payment".` });
      setSaid('');
      return;
    }
    let live = true;
    let done!: () => void;
    const saving = new Promise<void>((ok) => (done = ok));
    pending.set(envelopeId, { saving, problem: 'It is still being saved. Try again in a moment.' });
    setSaid('saving');
    const timer = setTimeout(async () => {
      try {
        const r = await api<{ setting: Setting; pay_link_removed?: boolean }>(`/envelopes/${envelopeId}/collect`, { method: 'PUT', body: { currency, for: what, when, ...(link.current ? { replace_link: true } : {}), ...(fixed ? { amount } : { field_id: field }) } });
        if (r.pay_link_removed) {
          link.current = false;
          toast('Payment saved. The link to your own payment page was taken off.');
        }
        onSaved(r.setting, !!r.pay_link_removed);
        pending.set(envelopeId, {});
        if (live) (setError(''), setSaid('saved'));
      } catch (e: any) {
        const why = e?.message || 'The payment could not be saved. Try again in a moment.';
        pending.set(envelopeId, { problem: `${why.replace(/ Nothing was saved\.$/, '')} Or choose "No payment".` });
        if (live) (setError(why), setSaid(''));
      } finally {
        done();
      }
    }, 700);
    return () => {
      live = false;
      if (leaving.current) return;
      clearTimeout(timer);
      done();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, amount, field, currency, what, when]);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="muted small" id="ask-pay-says" style={{ margin: 0 }}>{COLLECT_FOR_SENDER}</p>
      <details className="small"><summary style={{ minHeight: 44, display: 'flex', alignItems: 'center', cursor: 'pointer' }}>How this works</summary><p style={{ margin: '4px 0 0' }}>{COLLECT_HOW}</p></details>
      {s?.field_gone && <div className="notice warn" role="status">The field that held the amount is gone, so nobody is asked to pay. Choose another field or a fixed amount.</div>}
      {fields.length > 0 && (
        <label className="f" style={{ margin: 0 }}><span>Amount</span>
          <select value={from} onChange={(e) => setFrom(e.target.value as any)} style={{ minHeight: 44 }}>
            <option value="fixed">A fixed amount</option>
            <option value="field">The amount in a field</option>
          </select>
        </label>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        {fixed
          ? <label className="f" style={{ margin: 0, flex: '1 1 140px' }}><span>{fields.length ? 'How much' : 'Amount'}</span><input inputMode="decimal" value={amount} placeholder="25.00" onChange={(e) => setAmount(e.target.value)} aria-describedby={error ? 'ask-pay-error' : undefined} style={{ minHeight: 44 }} /></label>
          : <label className="f" style={{ margin: 0, flex: '1 1 140px' }}><span>Field</span><select value={field} onChange={(e) => setField(e.target.value)} style={{ minHeight: 44 }}>{fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>}
        <label className="f" style={{ margin: 0, flex: '0 1 110px' }}><span>Currency</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ minHeight: 44 }}>{Object.keys(CURRENCIES).map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select>
        </label>
      </div>
      <label className="f" style={{ margin: 0 }}><span>What it is for</span><input value={what} maxLength={COLLECT_FOR_MAX} placeholder="Membership fee" onChange={(e) => setWhat(e.target.value)} style={{ minHeight: 44 }} /></label>
      <label className="f" style={{ margin: 0 }}><span>When they pay</span>
        <select value={when} onChange={(e) => setWhen(e.target.value as CollectWhen)} aria-describedby="ask-pay-when" style={{ minHeight: 44, maxWidth: '100%' }}>
          <option value="after">{WHEN_WORDS.after}</option>
          <option value="before">{WHEN_WORDS.before}</option>
        </select>
      </label>
      <p className="muted small" id="ask-pay-when" style={{ margin: 0 }}>{WHEN_HINT[when]}</p>
      {error && <div className="notice err" role="alert" id="ask-pay-error">{error}</div>}
      <p className="small" role="status" style={{ margin: 0 }}>
        {said === 'saving' ? 'Saving...' : s && !error ? <>Saved: each person who signs is asked to pay <b>{s.amount_text || `the amount in "${s.field_label}"`}</b> for {s.for}, {s.when === 'before' ? 'before their part is complete' : 'after they finish'}. Nobody was emailed.</> : null}
      </p>
    </div>
  );
}

/** For step 3's closed More options: the card payment this document asks for, in words, or null. Read again when `open` changes. */
export function useCollectSummary(envelopeId: string | undefined, open: boolean): string | null {
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => {
    if (!envelopeId || open) return;
    let live = true;
    api<State>(`/envelopes/${envelopeId}/collect`).then((r) => live && setSaid(collectSummary(r.setting))).catch(() => {});
    return () => {
      live = false;
    };
  }, [envelopeId, open]);
  return said;
}
