'use client';
// Step 3, More options: "Ask for a payment" (research/ux-notes.json, ds-pay-collect). One control for both ways:
// by card here, into the account's own Stripe account (src/server/routes-collect.ts), or a link to the sender's own
// payment page (PayLinkCard in PayLinkChoice.tsx). Where the account has not connected Stripe, or this server does not take
// payments, this is exactly the payment link as it was: nothing new to read or choose.
import { useEffect, useState } from 'react';
import { api, toast } from '../ui';
import { PayLinkCard } from './PayLinkChoice';
import { CURRENCIES, COLLECT_FOR_MAX, COLLECT_FOR_SENDER, WHEN_WORDS, type CollectWhen } from '@/lib/collect';

type Setting = { amount: number | null; field_id: string | null; currency: string; for: string; when: CollectWhen; amount_text: string | null; field_label: string | null; field_gone: boolean } | null;
type State = { available: boolean; connected?: { name: string } | null; may?: boolean; why?: string | null; setting: Setting; pay_link?: boolean; fields?: { id: string; label: string }[] };
type LinkProps = Parameters<typeof PayLinkCard>[0];

export function AskPayment(props: LinkProps) {
  const { envelopeId } = props;
  const [st, setSt] = useState<State | null>(null);
  const [mode, setMode] = useState<'none' | 'card' | 'link'>('none');
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
    };
  }, [envelopeId]);
  if (!st) return null;
  // Nothing to choose between: the payment link as it always was.
  const card = st.available && !!st.connected && !!st.may;
  if (!card && !st.setting) return <PayLinkCard {...props} />;
  return (
    <div className="card" data-feature="ds-pay-collect">
      <h3 style={{ margin: '0 0 4px' }}>Ask for a payment <span className="muted small">(optional)</span></h3>
      <fieldset className="f" style={{ border: 0, padding: 0, margin: '0 0 8px' }}>
        <legend className="sg-vh">How people pay</legend>
        {([['none', 'No payment'], ['card', `By card here, into your Stripe account${st.connected?.name ? ` (${st.connected.name})` : ''}`], ['link', 'On your own payment page']] as const).map(([k, l]) => (
          <label key={k} className="check" style={{ minHeight: 44 }}><input type="radio" name={`ask-pay-${envelopeId}`} checked={mode === k} onChange={() => setMode(k)} /> {l}</label>
        ))}
      </fieldset>
      {mode === 'card' && <CardForm envelopeId={envelopeId!} st={st} onSaved={(setting) => setSt({ ...st, setting, pay_link: setting ? false : st.pay_link })} />}
      {mode === 'link' && (st.setting ? <p className="small">This document asks for a payment by card. Choose &ldquo;By card&rdquo; and take it off to use a link instead.</p> : <PayLinkCard {...props} />)}
      {mode === 'none' && st.setting && <p className="small">This document still asks for a payment by card. Choose &ldquo;By card&rdquo; and take it off.</p>}
    </div>
  );
}

function CardForm({ envelopeId, st, onSaved }: { envelopeId: string; st: State; onSaved: (s: Setting) => void }) {
  const s = st.setting;
  const fields = st.fields || [];
  const [from, setFrom] = useState<'fixed' | 'field'>(s?.field_id ? 'field' : 'fixed');
  const [amount, setAmount] = useState(s?.amount_text ? s.amount_text.split(' ')[0] : '');
  const [field, setField] = useState(s?.field_id || fields[0]?.id || '');
  const [currency, setCurrency] = useState(s?.currency || 'eur');
  const [what, setWhat] = useState(s?.for || '');
  const [when, setWhen] = useState<CollectWhen>(s?.when || 'after');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (off = false) => {
    setBusy(true);
    setError('');
    try {
      // One way to ask: a link to the sender's own page is taken off when they choose a card payment.
      if (!off && st.pay_link) await api(`/envelopes/${envelopeId}/pay-link`, { method: 'PUT', body: { url: '' } });
      const r = await api<{ setting: Setting }>(`/envelopes/${envelopeId}/collect`, { method: 'PUT', body: off ? { off: true } : { currency, for: what, when, ...(from === 'field' ? { field_id: field } : { amount }) } });
      onSaved(r.setting);
      toast(off ? 'Payment taken off.' : st.pay_link ? 'Payment saved. The link to your own payment page was taken off.' : 'Payment saved. Nobody was emailed.');
    } catch (e: any) {
      setError(e?.message || 'The payment could not be saved. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="muted small" id="ask-pay-says" style={{ margin: 0 }}>{COLLECT_FOR_SENDER}</p>
      {s?.field_gone && <div className="notice warn" role="status">The field that held the amount is gone, so nobody is asked to pay. Choose another field or a fixed amount.</div>}
      {fields.length > 0 && (
        <label className="f" style={{ margin: 0 }}><span>Amount</span>
          <select value={from} disabled={busy} onChange={(e) => setFrom(e.target.value as any)} style={{ minHeight: 44 }}>
            <option value="fixed">A fixed amount</option>
            <option value="field">The amount in a field</option>
          </select>
        </label>
      )}
      <div className="row wrap" style={{ gap: 8 }}>
        {from === 'fixed' || !fields.length
          ? <label className="f" style={{ margin: 0, flex: '1 1 140px' }}><span>{fields.length ? 'How much' : 'Amount'}</span><input inputMode="decimal" value={amount} disabled={busy} placeholder="25.00" onChange={(e) => setAmount(e.target.value)} aria-describedby={error ? 'ask-pay-error' : undefined} style={{ minHeight: 44 }} /></label>
          : <label className="f" style={{ margin: 0, flex: '1 1 140px' }}><span>Field</span><select value={field} disabled={busy} onChange={(e) => setField(e.target.value)} style={{ minHeight: 44 }}>{fields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>}
        <label className="f" style={{ margin: 0, flex: '0 1 110px' }}><span>Currency</span>
          <select value={currency} disabled={busy} onChange={(e) => setCurrency(e.target.value)} style={{ minHeight: 44 }}>{Object.keys(CURRENCIES).map((c) => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select>
        </label>
      </div>
      <label className="f" style={{ margin: 0 }}><span>What it is for</span><input value={what} maxLength={COLLECT_FOR_MAX} disabled={busy} placeholder="Membership fee" onChange={(e) => setWhat(e.target.value)} style={{ minHeight: 44 }} /></label>
      <label className="f" style={{ margin: 0 }}><span>When they pay</span>
        <select value={when} disabled={busy} onChange={(e) => setWhen(e.target.value as CollectWhen)} style={{ minHeight: 44 }}>
          <option value="after">{WHEN_WORDS.after}</option>
          <option value="before">{WHEN_WORDS.before}</option>
        </select>
      </label>
      {error && <div className="notice err" role="alert" id="ask-pay-error">{error}</div>}
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy || !what.trim() || (from === 'fixed' && !amount.trim())} onClick={() => save()}>{s ? 'Save the change' : 'Save the payment'}</button>
        {s && <button type="button" className="btn ghost" style={{ minHeight: 44 }} disabled={busy} onClick={() => save(true)}>Take it off</button>}
      </div>
      {s && <p className="small" style={{ margin: 0 }}>Saved: each person who signs is asked to pay <b>{s.amount_text || `the amount in "${s.field_label}"`}</b> for {s.for}, {s.when === 'before' ? 'before their part is complete' : 'after they finish'}.</p>}
    </div>
  );
}
