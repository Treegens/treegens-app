'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { api, fmtDate } from '@/components/ui';

// For the holder of a printed or scanned copy, who has the envelope ID at the foot of every page and nothing else.
// The server says what an ID may reveal (lookupEnvelope in src/server/evidence.ts): never a name, an address or the
// title. "Choose the file to compare" fingerprints a file in this browser when it can, so the file is not sent.

const STATE: Record<string, (r: any) => { title: string; text: string; good: boolean }> = {
  completed: (r) => ({ good: true, title: `Completed on ${fmtDate(r.completed_at, true)}`, text: 'Everyone who was asked to sign had signed. The signed file has the fingerprint below.' }),
  sent: () => ({ good: false, title: 'Still out for signature', text: 'It is not completed: not everyone has signed yet. A copy that looks signed by everyone is not the finished document.' }),
  voided: (r) => ({ good: false, title: `Voided${r.closed_at ? ` on ${fmtDate(r.closed_at, true)}` : ''}`, text: 'Its sender cancelled it before everyone had signed. It is not a signed document, whatever a copy of it shows.' }),
  declined: (r) => ({ good: false, title: `Declined${r.closed_at ? ` on ${fmtDate(r.closed_at, true)}` : ''}`, text: 'Someone who was asked to sign declined, which closed it for everyone. It is not a signed document, whatever a copy of it shows.' }),
  expired: (r) => ({ good: false, title: `Ran out of time${r.closed_at ? ` on ${fmtDate(r.closed_at, true)}` : ''}`, text: 'The deadline passed before everyone had signed. It is not a signed document, whatever a copy of it shows.' }),
  deleted: (r) => ({ good: true, title: `Completed on ${fmtDate(r.completed_at, true)}, deleted since`, text: `Its sender deleted it with their account on ${fmtDate(r.deleted_at, true)}. We kept only its fingerprint and this day, until ${fmtDate(r.kept_until, true)}, and nothing about who signed it.` }),
};

async function fingerprint(file: File): Promise<string> {
  // In this browser, when it can: the file stays on this device.
  if (globalThis.crypto?.subtle) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
    return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const fd = new FormData();
  fd.append('file', file);
  return (await api('/public/verify', { form: fd })).hash;
}

export function ById() {
  const [id, setId] = useState('');
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [same, setSame] = useState<{ name: string; hash: string } | null>(null);
  const result = useRef<HTMLDivElement>(null);

  // /verify?id=env_... opens with that ID looked up.
  useEffect(() => {
    const given = new URLSearchParams(window.location.search).get('id');
    if (given) (setId(given), look(given));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (res) result.current?.focus();
  }, [res]);

  async function look(wanted: string) {
    const clean = wanted.trim().replace(/^.*Envelope ID:?\s*/i, '');
    if (!clean) return setError('Type the envelope ID first. It stands at the foot of every page, after "Envelope ID", and starts with env_.');
    setBusy(true);
    setError('');
    setRes(null);
    setSame(null);
    try {
      setRes(await api(`/public/verify/${encodeURIComponent(clean)}`));
    } catch (e: any) {
      setError(!e?.status ? 'We could not reach Sign&Grow, so nothing was looked up. Check your connection and try again.'
        : e.status === 429 ? 'That is a lot of lookups from your connection in a short time. Wait an hour and try again.' : e.message);
    } finally {
      setBusy(false);
    }
  }

  async function compare(file?: File | null) {
    if (!file) return;
    setError('');
    try {
      setSame({ name: file.name, hash: await fingerprint(file) });
    } catch {
      setError('That file could not be read, so nothing was compared. Choose it again.');
    }
  }

  const s = res ? (STATE[res.status] || STATE.sent)(res) : null;
  return (
    <section className="pub-aside" aria-labelledby="byid-h">
      <h2 id="byid-h">Have a printed copy? Look it up by its envelope ID</h2>
      <p>Every page of a signed PDF from Sign&amp;Grow has its envelope ID at the foot, after &ldquo;Envelope ID&rdquo;. It tells you whether that envelope was completed, and gives you the fingerprint of the signed file to compare a file with. It never shows names, addresses or the title.</p>
      <form className="card pub-check-form" onSubmit={(e: FormEvent) => (e.preventDefault(), look(id))} noValidate>
        <label className="f" style={{ marginBottom: 12 }}>
          <span>Envelope ID</span>
          <input value={id} onChange={(e) => (setId(e.target.value.slice(0, 120)), setError(''))} placeholder="env_..." autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-describedby="byid-hint" aria-invalid={!!error && !res} />
        </label>
        <p id="byid-hint" className="muted small" style={{ margin: '0 0 14px' }}>Type it exactly as printed. Capitals count.</p>
        {error && <div className="notice err" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Looking it up' : 'Look it up'}</button>
      </form>
      {res && s && (
        <div ref={result} tabIndex={-1} role="status" className={`card pub-verdict ${s.good ? 'good' : 'bad'} pub-focus`} style={{ marginTop: 18 }}>
          <h3 style={{ margin: '0 0 6px' }}>{s.title}</h3>
          <p style={{ margin: '0 0 10px' }}>{s.text}</p>
          {res.disputed_at && <div className="notice warn" style={{ marginBottom: 12 }}><b>Disputed.</b> On {fmtDate(res.disputed_at, true)}, {res.disputes === 1 ? 'a person' : `${res.disputes} people`} named on this document told us they did not sign it, or that it was not them. Nothing was changed or deleted because of that. Who is right is not something this page can tell you.</div>}
          <dl className="pub-facts">
            <dt>Envelope</dt><dd className="mono">{res.id}</dd>
            {res.pages && <><dt>Pages</dt><dd>{res.pages.documents} in the documents{res.pages.signed_file ? <small>{res.pages.signed_file} in the signed file, with the certificate and any files signers attached</small> : null}</dd></>}
            {res.signers != null && <><dt>Asked to sign</dt><dd>{res.signers} {res.signers === 1 ? 'person' : 'people'}<small>{res.signed} signed{res.approvers ? `, and ${res.approvers} asked to approve` : ''}</small></dd></>}
            {res.sha256 && <><dt>Fingerprint</dt><dd className="mono">SHA-256 {res.sha256}</dd></>}
          </dl>
          {res.sha256 && (
            <>
              <label className="btn pub-pick">
                <input type="file" accept="application/pdf,.pdf" className="pub-vh" onChange={(e) => (compare(e.target.files?.[0]), (e.target.value = ''))} />
                Choose the file to compare
              </label>
              <p className="muted small" style={{ marginTop: 8 }}>The file is fingerprinted in your browser where it can be, so it is not sent anywhere.</p>
              {same && (same.hash === res.sha256
                ? <div className="notice" role="status"><b>{same.name} is that signed file,</b> byte for byte. The printed copy can still differ from it: compare the pages with your paper.</div>
                : <div className="notice err" role="status"><b>{same.name} is not that signed file.</b> It may have been changed, saved again by a viewer, or be another document. Its fingerprint is <span className="mono">{same.hash}</span>.</div>)}
            </>
          )}
          <p className="muted small" style={{ marginTop: 12 }}>What a fingerprint shows and does not show: <Link href="/security/certificate">How to read a Sign&amp;Grow certificate</Link>.</p>
        </div>
      )}
    </section>
  );
}
