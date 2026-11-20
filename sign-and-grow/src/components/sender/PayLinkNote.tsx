'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate, toast } from '@/components/ui';

type State = { pay_link: { url: string; host: string; label: string } | null; may: boolean; why: string | null; people: { id: string; name: string; shown_at: string | null; opened_at: string | null }[] };

// On the envelope page: the link to the sender's own payment page, who was shown it and who pressed it. Whether
// anyone paid is never known here, and the card says so instead of leaving a sender to guess. Nothing is shown when
// the envelope has no link. Taking it off is here too, because a finished envelope can no longer be edited.
export function PayLinkNote({ envelopeId, closed }: { envelopeId: string; closed: boolean }) {
  const [st, setSt] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api<State>(`/envelopes/${envelopeId}/pay-link`).then((r) => live && setSt(r)).catch(() => {});
    return () => {
      live = false;
    };
  }, [envelopeId]);
  const link = st?.pay_link;
  if (!st || !link) return null;
  const remove = async () => {
    if (!window.confirm('Take the payment link off? Nobody is shown it from now on, also people who already finished.')) return;
    setBusy(true);
    try {
      await api(`/envelopes/${envelopeId}/pay-link`, { method: 'PUT', body: { url: '' } });
      setSt({ ...st, pay_link: null });
      toast('Payment link removed. Nobody is shown it any more.');
    } catch (e: any) {
      toast(e?.message || 'The link could not be removed. Try again in a moment.', true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="sn-pay-h" id="sn-pay">
      <h2 id="sn-pay-h">Payment link</h2>
      <p>After they press Finish, each person who signs sees <b>{link.label}</b>, which opens <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{link.url}</code>. It is never put in our emails.</p>
      {!st.may && <div className="notice warn" role="status"><b>Not shown to anyone right now.</b> {st.why}</div>}
      {st.people.length > 0 && (
        <ul className="small" style={{ paddingLeft: 18 }}>
          {st.people.map((p) => (
            <li key={p.id}><b>{p.name}</b>: {p.shown_at ? `shown on ${fmtDate(p.shown_at, true)}` : 'not shown yet. It appears after they finish'}{p.opened_at ? `, pressed on ${fmtDate(p.opened_at, true)}` : p.shown_at ? ', not pressed yet' : ''}.</li>
          ))}
        </ul>
      )}
      <p className="muted small">Sign&Grow takes no part in the payment and cannot tell you whether anyone paid. Your payment provider can. {closed ? 'This envelope can no longer be edited, so the link can only be taken off now.' : 'To change it, open the editor: the link is on its last step.'}</p>
      <button type="button" className="btn ghost" style={{ minHeight: 44 }} disabled={busy} onClick={remove}>Remove the link</button>
    </section>
  );
}
