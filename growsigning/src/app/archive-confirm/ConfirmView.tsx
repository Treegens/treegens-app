'use client';
// The page behind the link in the email that asks an address whether it should get copies of a team's emails
// (src/server/routes-archive.ts). Opening it changes nothing: a mail program that opens links to check them confirms
// nothing. Only a press on one of the two buttons does. The long list of what is copied is folded under them. Whoever reads the inbox is often not a customer of ours, on
// a phone: plain words, every control at least 44 pixels tall, and the answer is said in a line a screen reader reads.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api } from '@/components/ui';
import { Logo } from '@/components/Brand';
import { ARCHIVE_NO } from '@/lib/archivemail';

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
    // A pressed button stays as it is while the answer is on its way (the focus stays on it); a second press waits.
    if (busy) return;
    setBusy(a);
    setError('');
    api('/public/archive-confirm', { body: { token, answer: a } })
      .then((r) => setDone({ state: r.state, message: r.message }))
      .catch((e) => setError(e?.status ? e.message : OFFLINE))
      .finally(() => setBusy(''));
  };

  // The buttons go once one was pressed: the focus moves to the heading, which now says what happened.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (done) heading.current?.focus();
  }, [done]);

  const state = done?.state || ask?.state || '';
  const asking = !!ask && state === 'waiting';
  const title = gone ? 'This link does not work' : !ask ? 'One moment…'
    : state === 'confirmed' ? 'This address gets the copies'
    : state === 'refused' ? 'Nothing is sent here'
    : state === 'expired' ? 'This link has run out'
    : 'Should this address get copies?';

  return (
    <div className="authbox">
      <Link href="/" className="logo" aria-label="GrowSigning home" style={{ marginBottom: 20, display: 'inline-flex', alignItems: 'center', minHeight: 44 }}><Logo height={26} /></Link>
      <main id="main" className="card">
        <h1 ref={heading} tabIndex={-1} className="serif" style={{ fontSize: 24, outline: 'none' }}>{title}</h1>
        <div role="status">
          {gone && <p className="muted" style={{ margin: '10px 0 0' }}>{gone}</p>}
          {done && <p style={{ margin: '10px 0 0' }}>{done.message}</p>}
          {ask && !done && state === 'confirmed' && <p className="muted" style={{ margin: '10px 0 0' }}>{ask.email} was confirmed already. To stop the copies, ask {ask.account} to remove this address in their settings.</p>}
          {ask && !done && state === 'expired' && <p className="muted" style={{ margin: '10px 0 0' }}>Nothing was changed, and nothing is sent to {ask.email}. If copies should come here, ask {ask.account} to send the link again.</p>}
        </div>
        {asking && (
          <>
            <p style={{ margin: '10px 0', overflowWrap: 'anywhere' }}>
              {ask.asked_by ? `${ask.asked_by} of ${ask.account}` : ask.account} asked GrowSigning to send <b>{ask.email}</b> a copy of every email the team sends about its documents, with any signed PDF attached. Signing links and codes are taken out of each copy. Nothing is sent here unless you confirm.
            </p>
            <div className="row wrap" style={{ gap: 10, marginTop: 16 }}>
              <button type="button" className="btn primary" style={TAP} aria-busy={busy === 'yes'} onClick={() => answer('yes')}>{busy === 'yes' ? 'Confirming…' : 'Confirm'}</button>
              <button type="button" className="btn" style={TAP} aria-busy={busy === 'no'} onClick={() => answer('no')}>{busy === 'no' ? 'One moment…' : ARCHIVE_NO}</button>
            </div>
            <p className="small muted" style={{ margin: '12px 0 0' }}>If you choose No, nothing is sent here, and {ask.account} cannot ask this address again for {ask.refused_days} days.</p>
            <details style={{ marginTop: 8 }}>
              <summary className="small" style={{ padding: '12px 0', cursor: 'pointer' }}>What exactly is copied</summary>
              <p className="small" style={{ margin: '0 0 8px' }}>{ask.what}</p>
              <p className="small muted" style={{ margin: 0 }}>To stop the copies later, ask {ask.account} to remove this address in their settings.</p>
            </details>
          </>
        )}
        {done?.state === 'refused' && (
          <p style={{ margin: '14px 0 0' }}>
            <button type="button" className="btn" style={TAP} aria-busy={busy === 'undo'} onClick={() => answer('undo')}>{busy === 'undo' ? 'One moment…' : 'Take that back'}</button>
          </p>
        )}
        {error && <p className="notice err" role="alert" style={{ marginTop: 14, marginBottom: 0 }}>{error}</p>}
      </main>
      <p className="muted small center" style={{ margin: '14px 0 0' }}>Did not expect this? Close this page and nothing is sent here.</p>
      <p className="small center" style={{ margin: 0 }}><Link href="/help#contact" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, padding: '0 12px' }}>Need a hand? Get help</Link></p>
    </div>
  );
}
