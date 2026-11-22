'use client';
// Settings, Sending: "Take payments", for admins, only when the people who run this server set up Stripe Connect
// (src/server/routes-collect.ts). The account connects its own Stripe account; payments go there, never to us.
import { useEffect, useState } from 'react';
import { useMe } from '@/components/AppShell';
import { api, toast } from '@/components/ui';
import { useST, senderRich } from '@/components/senderLang';

type Conn = { available: boolean; connected?: { name: string; livemode: boolean; connected_at: string } | null; may?: boolean; why?: string | null; open_asking?: number };
/** What the page says on coming back from Stripe (?collect=...): settings.pay.back_<word> in en.json. */
const BACK = ['connected', 'declined', 'failed'];

export function TakePayments() {
  const me = useMe();
  const T = useST();
  const [st, setSt] = useState<Conn | null>(null);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [said, setSaid] = useState('');
  const admin = me.role === 'owner' || me.role === 'admin';
  useEffect(() => {
    if (!admin) return;
    api<Conn>('/collect/connection').then(setSt).catch(() => setSt({ available: false }));
    const q = new URLSearchParams(window.location.search).get('collect');
    if (q && BACK.includes(q)) setSaid(`settings.pay.back_${q}`);
  }, [admin]);
  if (!admin || !st?.available) return null;
  const connect = async () => {
    setBusy(true);
    try {
      const r = await api<{ url: string }>('/collect/connect', { method: 'POST' });
      window.location.assign(r.url);
    } catch (e: any) {
      toast(e?.code || e?.message ? T.error(e) : T('settings.pay.unreachable'), true);
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await api('/collect/connection', { method: 'DELETE' });
      setSt({ ...st, connected: null });
      setSure(false);
      toast(T('settings.pay.disconnected'));
    } catch (e: any) {
      toast(e?.code || e?.message ? T.error(e) : T('settings.did_not_work'), true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" data-feature="ds-pay-collect" data-item="card" aria-labelledby="take-payments-h">
      <h2 id="take-payments-h">{T('settings.pay.title')}</h2>
      <p className="muted" style={{ marginTop: 6 }}>{T('settings.pay.lead')}</p>
      {said && <div className="notice" role="status">{T(said)}</div>}
      {st.connected ? (
        <>
          <p>{senderRich(T.lang, st.connected.livemode ? 'settings.pay.connected' : 'settings.pay.connected_test', { label: <b>{T('settings.pay.connected_label')}</b> }, { name: st.connected.name })}</p>
          {sure ? (
            <div className="notice warn" role="alert">
              <p style={{ marginTop: 0 }}>{st.open_asking ? T('settings.pay.open_asking', { count: st.open_asking }) : T('settings.pay.nobody')} {T('settings.pay.kept')}</p>
              <div className="row wrap" style={{ gap: 8 }}>
                <button type="button" className="btn danger" style={{ minHeight: 44 }} disabled={busy} onClick={disconnect}>{T('settings.pay.disconnect_sure')}</button>
                <button type="button" className="btn ghost" style={{ minHeight: 44 }} onClick={() => setSure(false)}>{T('settings.pay.keep')}</button>
              </div>
            </div>
          ) : <button type="button" className="btn ghost" style={{ minHeight: 44 }} onClick={() => setSure(true)}>{T('settings.pay.disconnect')}</button>}
        </>
      ) : st.may ? (
        <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={connect}>{T('settings.pay.connect')}</button>
      ) : <p className="small">{st.why}</p>}
    </section>
  );
}
