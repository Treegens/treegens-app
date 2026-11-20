'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, fmtDate } from '@/components/ui';
import { PublicNav, PublicFooter } from '@/components/Public';
import { MATCH_MEANS, NO_MATCH_CAUSES } from '@/lib/evidence';
import { ById } from './ById';

// A day as people say it, in the reader's own calendar: "20 November 2026".
const longDay = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : 'a day we no longer know');

export default function Verify() {
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const result = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (res) result.current?.focus();
  }, [res]);

  async function check(file?: File | null) {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    setRes(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      setRes({ ...(await api('/public/verify', { form: fd })), name: file.name });
    } catch (e: any) {
      setError(!e?.status ? 'We could not reach Sign&Grow, so the file was not checked. Check your connection and choose the file again.'
        : e.status === 429 ? 'That is a lot of files in a short time. Wait an hour and try again.'
        : `${e.message} Choose the signed PDF exactly as you downloaded it and try again.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page narrow">
        <header className="pub-top">
          <h1 className="pub-h1">Verify a signed document</h1>
          <p className="pub-lead">Got a PDF that claims to be signed with Sign&Grow? Choose it here. We compare its fingerprint with the one recorded when signing finished. If a single byte was changed, it will not match.</p>
        </header>
        <label className={`drop pub-drop${over ? ' over' : ''}`}
          onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={(e) => (e.preventDefault(), setOver(false), check(e.dataTransfer.files[0]))}>
          <input type="file" accept="application/pdf,.pdf" className="pub-vh" aria-describedby="verify-hint" onChange={(e) => (check(e.target.files?.[0]), (e.target.value = ''))} />
          <b>{busy ? 'Checking' : 'Drop a PDF here, or choose one'}</b>
          <div id="verify-hint" className="muted small">No account needed. The file is fingerprinted and then discarded. We do not keep it.</div>
        </label>
        {error && <div className="notice err" role="alert" style={{ marginTop: 16 }}>{error}</div>}
        {res && res.match && (
          <div ref={result} tabIndex={-1} role="status" className="card pub-verdict good pub-focus" style={{ marginTop: 18 }}>
            <span className="badge completed">Unchanged since signing finished</span>
            <h2>{res.envelope.subject}</h2>
            <div className="muted">Sent by {res.envelope.sender}. Completed {fmtDate(res.envelope.completed_at, true)}.</div>
            <p className="small" style={{ margin: '10px 0 0' }}>{MATCH_MEANS}</p>
            {res.envelope.disputed_at && <div className="notice warn" style={{ marginTop: 12 }}><b>Disputed.</b> On {fmtDate(res.envelope.disputed_at, true)}, a person named on this document told us they did not sign it, or that it was not them. Nothing was changed or deleted because of that, and this page cannot tell you who is right. Ask the sender.</div>}
            <table className="t" style={{ marginTop: 12 }}>
              <caption className="pub-vh">Who took part</caption>
              <tbody>
                {res.signers.map((s: any, i: number) => <tr key={i}><td style={{ paddingLeft: 0 }}><b>{s.name}</b> <span className="muted small">{s.email}</span></td><td className="muted small" style={{ textAlign: 'right', paddingRight: 0 }}>{s.completed_at ? fmtDate(s.completed_at, true) : ''}</td></tr>)}
              </tbody>
            </table>
            <div className="small" style={{ marginTop: 10 }}>Audit trail: {res.chain.ok ? `intact, ${res.chain.events} events` : 'broken. The recorded history of this envelope was changed after the fact, so do not rely on it.'}</div>
            <div className="mono muted" style={{ marginTop: 6 }}>Envelope {res.envelope.id}<br />SHA-256 {res.hash}</div>
          </div>
        )}
        {res && !res.match && res.deleted && (
          <div ref={result} tabIndex={-1} role="status" className="card pub-verdict good pub-focus" style={{ marginTop: 18 }}>
            <span className="badge completed">Completed here, deleted since</span>
            <h2>This file was completed with Sign&amp;Grow on {longDay(res.deleted.completed_at)}</h2>
            <p>Its fingerprint matches the signed PDF of envelope <span className="mono">{res.deleted.envelope_id}</span>, which everyone had finished on that day. So the file is unchanged since then.</p>
            <p>Its sender has since deleted it, together with their account, on {longDay(res.deleted.deleted_at)}. We deleted what we knew about it too, so we no longer hold the document, the names on it or its audit trail, and cannot tell you anything about who signed it. The certificate inside the file is what is left: read it with <Link href="/security/certificate">How to read a Sign&amp;Grow certificate</Link>.</p>
            <p className="muted small">We keep only this fingerprint, the envelope ID and the day it was completed, until {longDay(res.deleted.kept_until)}. After that this check answers &ldquo;no match&rdquo; for this file.</p>
            <div className="mono muted" style={{ marginTop: 8 }}>SHA-256 {res.hash}</div>
          </div>
        )}
        {res && !res.match && !res.deleted && (
          <div ref={result} tabIndex={-1} role="status" className="card pub-verdict bad pub-focus" style={{ marginTop: 18 }}>
            <span className="badge declined">No match</span>
            <p style={{ margin: '10px 0 6px' }}><b>{res.name}</b> does not match any completed document we hold. That can have several causes:</p>
            <ul className="pub-list small">{NO_MATCH_CAUSES.map((x) => <li key={x}>{x}</li>)}</ul>
            <p className="muted small">What to do: ask the sender or a signer for the file exactly as it was downloaded or emailed, and choose that one. A printed or scanned copy cannot be checked this way: look it up by its envelope ID below instead.</p>
            <div className="mono muted" style={{ marginTop: 8 }}>SHA-256 {res.hash}</div>
          </div>
        )}
        <ById />
        <section className="pub-aside" aria-labelledby="else-h">
          <h2 id="else-h">Looking for something else?</h2>
          <p>To find out whether an email is genuine before you open anything, use <Link href="/check">Check an email</Link>. To get your copy of a document again, use <Link href="/help#find-documents">Find my documents</Link>.</p>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
