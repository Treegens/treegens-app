'use client';
// The page behind the link in the email that asks an address whether it should get copies of a team's emails
// (src/server/routes-archive.ts). Opening it changes nothing: a mail program that opens links to check them confirms
// nothing. Only a press on one of the two buttons does. Whoever reads the inbox is often not a customer of ours, on
// a phone: plain words, every control at least 44 pixels tall, and the answer is said in a line a screen reader reads.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/components/ui';
import { Logo } from '@/components/Brand';

const TAP = { minHeight: 44 };
const OFFLINE = 'We could not reach GrowSigning, so nothing was changed. Check your connection and try again.';

type Ask = { email: string; account: string; asked_by: string | null; state: 'waiting' | 'confirmed' | 'expired'; what: string; refused_days: number };

export function ConfirmView() {
  const [token, setToken] = useState('');
  const [ask, setAsk] = useState<Ask | null>(null);
  const [gone, setGone] = useState('');
  // What a press did: 'confirmed', 'refused' (which can be taken back from here for a while) or back to 'waiting'.
  const [done, setDone] = useState<{ state: string; message: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token') || '';
    if (!t) return setGone('This link is not complete. Open it again from the email, or copy the whole link into the address bar.');
    setToken(t);
    api(`/public/archive-confirm?token=${encodeURIComponent(t)}`).then(setAsk).catch((e) => setGone(e?.status ? e.message : OFFLINE));
  }, []);

  const answer = (a: 'yes' | 'no' | 'undo') => {
    setBusy(a);
    setError('');
    api('/public/archive-confirm', { body: { token, answer: a } })
      .then((r) => setDone({ state: r.state, message: r.message }))
      .catch((e) => setError(e?.status ? e.message : OFFLINE))
      .finally(() => setBusy(''));
  };

  const state = done?.state || ask?.state || '';
  const asking = !!ask && state === 'waiting';
  const title = gone ? 'This link does not work' : !ask ? 'One moment…'
    : state === 'confirmed' ? 'This address gets the copies'
    : state === 'refused' ? 'Nothing is sent here'
    : state === 'expired' ? 'This link has run out'
    : 'Should this address get copies?';

  return (
    <div className="authbox">
      <Link href="/" className="logo" style={{ marginBottom: 20 }}><Logo height={26} /></Link>
      <main id="main" className="card">
        <h1 className="serif" style={{ fontSize: 24 }}>{title}</h1>
        <div role="status">
          {gone && <p className="muted" style={{ margin: '10px 0 0' }}>{gone}</p>}
          {done && <p style={{ margin: '10px 0 0' }}>{done.message}</p>}
          {ask && !done && state === 'confirmed' && <p className="muted" style={{ margin: '10px 0 0' }}>{ask.email} was confirmed already. To stop the copies, ask {ask.account} to remove this address in their settings.</p>}
          {ask && !done && state === 'expired' && <p className="muted" style={{ margin: '10px 0 0' }}>Nothing was changed, and nothing is sent to {ask.email}. If copies should come here, ask {ask.account} to send the link again.</p>}
        </div>
        {asking && (
          <>
            <p style={{ margin: '10px 0', overflowWrap: 'anywhere' }}>
              {ask.asked_by ? `${ask.asked_by} of ${ask.account}` : ask.account} asked GrowSigning to send copies of the team&apos;s emails about its documents to <b>{ask.email}</b>, for their records.
            </p>
            <p className="small">{ask.what}</p>
            <p className="small muted">Nothing is sent here unless you confirm. To stop the copies later, ask {ask.account} to remove this address in their settings.</p>
            <div className="row wrap" style={{ gap: 10, marginTop: 16 }}>
              <button type="button" className="btn primary" style={TAP} disabled={!!busy} onClick={() => answer('yes')}>{busy === 'yes' ? 'Confirming…' : 'Confirm'}</button>
              <button type="button" className="btn" style={TAP} disabled={!!busy} onClick={() => answer('no')}>{busy === 'no' ? 'One moment…' : 'This was not me'}</button>
            </div>
            <p className="small muted" style={{ margin: '12px 0 0' }}>&quot;This was not me&quot; means nothing is sent here, and {ask.account} cannot ask this address again for {ask.refused_days} days.</p>
          </>
        )}
        {done?.state === 'refused' && (
          <p style={{ margin: '14px 0 0' }}>
            <button type="button" className="btn" style={TAP} disabled={!!busy} onClick={() => answer('undo')}>{busy === 'undo' ? 'One moment…' : 'Take that back'}</button>
          </p>
        )}
        {error && <p className="notice err" role="alert" style={{ marginTop: 14, marginBottom: 0 }}>{error}</p>}
      </main>
      <p className="muted small center" style={{ marginTop: 14 }}>Did not expect this? Then close this page. Nothing is sent to an address that was not confirmed. <Link href="/help#contact">Need a hand? Get help</Link></p>
    </div>
  );
}
