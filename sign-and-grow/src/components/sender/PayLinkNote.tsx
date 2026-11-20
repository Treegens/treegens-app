'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate, toast } from '@/components/ui';

type Seen = { url: string; fingerprint: string; shown_at: string; opened_at: string | null };
type Person = { id: string; name: string; on_team: boolean; shown_at: string | null; opened_at: string | null; earlier: Seen[] };
type State = {
  pay_link: { url: string; host: string; label: string; fingerprint: string } | null; may: boolean; why: string | null; host_why: string | null;
  set_by: { id: string; name: string } | null; gone: { at: string; note: string } | null; people: Person[];
};
// "Pressed" is only what the page could see: a long press that opens a new tab sends nothing, so it is never "not pressed".
const pressed = (at: string | null) => (at ? `pressed on ${fmtDate(at, true)}` : 'not recorded as pressed');
function line(p: Person, link: State['pay_link']): string {
  if (p.on_team) return 'not asked, because they are on your team.';
  const now = !link ? '' : p.shown_at ? `shown this address on ${fmtDate(p.shown_at, true)}, ${pressed(p.opened_at)}.` : 'not shown this address yet. It appears after they finish.';
  const before = p.earlier.map((x) => ` Earlier shown ${x.url} (fingerprint ${x.fingerprint}) on ${fmtDate(x.shown_at, true)}, ${pressed(x.opened_at)}.`).join('');
  return `${now}${before}` || 'not shown it.';
}

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
  // Shown while there is a link, when one was taken off without the sender doing it, or when someone saw one before.
  if (!st || (!link && !st.gone && !st.people.some((p) => p.earlier.length))) return null;
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
      {link ? (
        <>
          <p>After they press Finish, each person who signs sees <b>{link.label}</b>, which opens <code style={{ overflowWrap: 'anywhere', wordBreak: 'break-all' }}>{link.url}</code>{st.set_by ? <>, the payment page of <b>{st.set_by.name}</b></> : null}. Nobody on your team is asked. The address is never put in our emails, certificates or exports: the audit trail names it by its fingerprint, <code>{link.fingerprint}</code>.</p>
          {(!st.may || st.host_why) && <div className="notice warn" role="status"><b>Not shown to anyone right now.</b> {st.why || st.host_why}</div>}
        </>
      ) : st.gone ? (
        <div className="notice" role="status"><b>Taken off on {fmtDate(st.gone.at, true)}.</b> {st.gone.note}{closed ? '' : ' To ask for a payment on this envelope, add your own link on the last step of the editor.'}</div>
      ) : <p>There is no payment link on this envelope now.</p>}
      {st.people.length > 0 && (
        <ul className="small" style={{ paddingLeft: 18, overflowWrap: 'anywhere' }}>
          {st.people.map((p) => <li key={p.id}><b>{p.name}</b>: {line(p, link)}</li>)}
        </ul>
      )}
      <p className="muted small">Sign&Grow takes no part in the payment and cannot tell you whether anyone paid. Your payment provider can. The button opens exactly this address: Sign&Grow does not check where that page sends people next.{link ? (closed ? ' This envelope can no longer be edited, so the link can only be taken off now.' : ' To change it, open the editor: the link is on its last step.') : ''}</p>
      {link && <button type="button" className="btn ghost" style={{ minHeight: 44 }} disabled={busy} onClick={remove}>Remove the link</button>}
    </section>
  );
}
