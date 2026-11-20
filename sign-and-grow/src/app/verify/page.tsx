'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, fmtDate } from '@/components/ui';
import { PublicNav, PublicFooter } from '@/components/Public';

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
            <span className="badge completed">Authentic and unchanged</span>
            <h2>{res.envelope.subject}</h2>
            <div className="muted">Sent by {res.envelope.sender}. Completed {fmtDate(res.envelope.completed_at, true)}.</div>
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
        {res && !res.match && (
          <div ref={result} tabIndex={-1} role="status" className="card pub-verdict bad pub-focus" style={{ marginTop: 18 }}>
            <span className="badge declined">No match</span>
            <p style={{ margin: '10px 0 6px' }}><b>{res.name}</b> is not a completed document from this service, or it was changed after signing.</p>
            <p className="muted small">Make sure you have the original download, not a copy that was saved again, printed or scanned. Those have a different fingerprint. The sender or any signer can send you the original.</p>
            <div className="mono muted" style={{ marginTop: 8 }}>SHA-256 {res.hash}</div>
          </div>
        )}
        <section className="pub-aside" aria-labelledby="else-h">
          <h2 id="else-h">Looking for something else?</h2>
          <p>To find out whether an email is genuine before you open anything, use <Link href="/check">Check an email</Link>. To get your copy of a document again, use <Link href="/help#find-documents">Find my documents</Link>.</p>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
