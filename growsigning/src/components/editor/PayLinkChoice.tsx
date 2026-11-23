'use client';
import { useEffect, useState } from 'react';
import { api, toast } from '../ui';
import { PAY_FOR_SENDER } from '@/lib/paylink';
import { AskPayment } from './CollectChoice';

type Link = { url: string; host: string; kind: string; label: string } | null;
type State = { pay_link: Link; may: boolean; why: string | null; host_why?: string | null; gone?: { at: string; note: string } | null; kinds: Record<string, string> };

// A link to the sender's own payment page, shown to each signer after they press Finish (src/lib/paylink.ts). It
// stands on the step with the Send button and is saved by itself, straight away, with its own button: it changes
// nothing on the pages and emails nobody. An account that may not show one yet is not offered it here at all (the
// help page says when it is). One that has a link and lost the right to show it sees why, and can take it off.
// `onChange` tells the step what is saved now, for the line next to its closed More options (ReviewParts.tsx).
type Props = { envelopeId?: string; isTpl?: boolean; onChange?: (p: { pay_link: Link; host_why: null }) => void };
// "Ask for a payment": where the account connected its own Stripe account, one card that chooses between a card
// payment here and this link (CollectChoice.tsx). Everywhere else it is this link card, as it always was.
export function PayLinkChoice(props: Props) {
  return <AskPayment {...props} />;
}

export function PayLinkCard({ envelopeId, isTpl, onChange }: Props) {
  const [st, setSt] = useState<State | null>(null);
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState('deposit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!envelopeId) return;
    let live = true;
    api<State>(`/envelopes/${envelopeId}/pay-link`).then((r) => {
      if (!live) return;
      setSt(r);
      setUrl(r.pay_link?.url || '');
      setKind(r.pay_link?.kind || 'deposit');
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [envelopeId]);
  if (!envelopeId || !st || (!st.may && !st.pay_link)) return null;
  const link = st.pay_link;
  const save = async (to: string) => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ pay_link: Link }>(`/envelopes/${envelopeId}/pay-link`, { method: 'PUT', body: { url: to, kind } });
      setSt({ ...st, pay_link: r.pay_link, host_why: null, gone: r.pay_link ? null : st.gone });
      onChange?.({ pay_link: r.pay_link, host_why: null });
      setUrl(r.pay_link?.url || '');
      toast(r.pay_link ? 'Payment link saved. Nobody was emailed.' : 'Payment link removed.');
    } catch (e: any) {
      setError(e?.message || 'The link could not be saved. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card ed-paylink">
      <h3 style={{ margin: '0 0 4px' }}>Payment at signing <span className="muted small">(optional)</span></h3>
      <p className="muted small" id="ed-pay-says" style={{ marginTop: 0 }}>{PAY_FOR_SENDER}{isTpl ? ' Every document made from this template starts with this link.' : ''}</p>
      {!st.may && <div className="notice warn" role="status"><b>Not shown to anyone right now.</b> {st.why}</div>}
      {st.may && link && st.host_why && <div className="notice warn" role="status"><b>Not shown to anyone right now.</b> {st.host_why}</div>}
      {!link && st.gone && <div className="notice" role="status">{st.gone.note}</div>}
      {st.may && (
        <>
          <label className="f" style={{ marginBottom: 8 }}>
            <span>Address of your own payment page</span>
            <input type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://" value={url} disabled={busy}
              aria-describedby={`ed-pay-says${error ? ' ed-pay-error' : ''}`} aria-invalid={!!error} onChange={(e) => setUrl(e.target.value)} style={{ minHeight: 44 }} />
          </label>
          <label className="f" style={{ marginBottom: 8 }}>
            <span>The button says</span>
            <select value={kind} disabled={busy} onChange={(e) => setKind(e.target.value)} style={{ minHeight: 44 }}>
              {Object.entries(st.kinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
        </>
      )}
      {error && <div className="notice err" role="alert" id="ed-pay-error">{error}</div>}
      <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
        {st.may && <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy || !url.trim()} onClick={() => save(url)}>{link ? 'Save the change' : 'Save the link'}</button>}
        {link && <button type="button" className="btn ghost" style={{ minHeight: 44 }} disabled={busy} onClick={() => save('')}>Remove the link</button>}
      </div>
      {link && <p className="small" style={{ marginBottom: 0 }}>Saved: each person who signs sees <b>{link.label}</b> after Finish, which opens <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{link.url}</code></p>}
    </div>
  );
}
