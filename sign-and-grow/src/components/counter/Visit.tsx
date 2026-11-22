'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, fmtDate, oops, toast } from '@/components/ui';
import { QrCode } from '@/components/QrCode';
import { openToSign } from '@/components/sender/Recipients';
import { qrForLink } from '@/lib/qrlink';
import { CANNOT_CHECK_ID, ID_QUESTION, ID_METHODS, ID_DOC_TYPES, ID_STATEMENT, HELPS, HELP_KINDS, helpStatement, behalfSecond, PAD_LINE, PAIR_MINUTES, showCode, type HelpKind } from '@/lib/counter';
import { Receipt } from './Receipt';

// One person at the counter with one official (src/server/counter.ts): 1. how the official knows who this is,
// 2. help with signing when needed, 3. the document on the person's own screen or handed over on this device,
// then progress, and the receipt once they have finished. What the person types is not shown here unless the
// template allows it.
export function Visit({ id }: { id: string }) {
  const [v, setV] = useState<any>(null);
  const [n, setN] = useState(0);
  const reload = () => setN((x) => x + 1);
  useEffect(() => {
    let live = true;
    api(`/counter/visits/${id}`).then((d) => live && setV(d)).catch(oops);
    return () => {
      live = false;
    };
  }, [id, n]);
  // Progress while the person signs: looked up again every few seconds, never faster.
  useEffect(() => {
    if (!v || v.person.status === 'completed' || !v.identity) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [v]);
  if (!v) return <p className="muted">Loading…</p>;
  const done = v.person.status === 'completed';
  return (
    <div className="stack" data-feature="gov-G18">
      <div><Link href="/app/counter" className="btn ghost">Back to the Counter</Link></div>
      <div>
        <h1 className="serif" style={{ overflowWrap: 'anywhere' }}>{v.person.name}</h1>
        <div className="muted" style={{ overflowWrap: 'anywhere' }}>{v.envelope.subject} · with {v.visit.official}</div>
      </div>
      {v.visit.closed && <div className="notice warn">Another official took this person over. Go back to the Counter to see who has them now.</div>}
      {!v.visit.mine && !v.visit.closed && !done && <SecondOfficial v={v} onDone={reload} />}
      {v.visit.mine && !v.visit.closed && !done && (
        <ol className="ct-steps">
          <li><Identity v={v} onDone={reload} /></li>
          <li><Helps v={v} onDone={reload} /></li>
          {v.identity && <li><OpenIt v={v} onDone={reload} /></li>}
        </ol>
      )}
      {v.identity && !done && <Progress v={v} />}
      {done && (
        <>
          <div className="notice">{v.person.name} finished on {fmtDate(v.person.finished_at, true)}.</div>
          <Receipt visitId={v.visit.id} />
        </>
      )}
    </div>
  );
}

function Identity({ v, onDone }: { v: any; onDone: () => void }) {
  const [again, setAgain] = useState(false);
  const [f, setF] = useState({ method: '', doc_type: ID_DOC_TYPES[0] as string, doc_other: '', last4: '', country: '' });
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picture, setPicture] = useState<File | null>(null);
  if (v.identity && !again)
    return (
      <div className="card stack">
        <h2>1. Who this is</h2>
        <p className="ct-done">Recorded: {v.identity.words}</p>
        <p className="muted small" style={{ margin: 0 }}>{CANNOT_CHECK_ID}</p>
        <div><button type="button" className="btn ghost" onClick={() => setAgain(true)}>Change what you recorded</button></div>
      </div>
    );
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/counter/visits/${v.visit.id}/identity`, { body: { ...f, attest } });
      if (picture) {
        const form = new FormData();
        form.append('file', picture);
        await api(`/counter/visits/${v.visit.id}/picture`, { form });
      }
      toast('Identity check recorded');
      setAgain(false);
      onDone();
    } catch (err) {
      oops(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" onSubmit={save}>
      <h2>1. Who this is</h2>
      <fieldset className="ct-radio">
        <legend>{ID_QUESTION}</legend>
        {ID_METHODS.map((m) => (
          <label key={m.key}><input type="radio" name="ct-method" checked={f.method === m.key} onChange={() => setF({ ...f, method: m.key })} /> {m.label}</label>
        ))}
      </fieldset>
      {f.method === 'document' && (
        <>
          <label className="f"><span>Kind of document</span>
            <select value={f.doc_type} onChange={(e) => setF({ ...f, doc_type: e.target.value })}>{ID_DOC_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          </label>
          {f.doc_type === 'Other' && <label className="f"><span>Name of the document</span><input value={f.doc_other} onChange={(e) => setF({ ...f, doc_other: e.target.value })} maxLength={60} /></label>}
          <label className="f"><span>Last 4 letters or digits of its number</span><input value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value })} maxLength={6} autoComplete="off" inputMode="text" style={{ maxWidth: 160 }} /></label>
          <label className="f"><span>Issued by (country or authority)</span><input value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} maxLength={60} /></label>
          {v.settings.id_scans && <label className="f"><span>Picture of the document (kept encrypted, optional)</span><input type="file" accept="image/jpeg,image/png,application/pdf" onChange={(e) => setPicture(e.target.files?.[0] || null)} /></label>}
        </>
      )}
      <label className="check ct-statement"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /> <span>{ID_STATEMENT}</span></label>
      <p className="muted small" style={{ margin: 0 }}>{CANNOT_CHECK_ID}</p>
      <div className="row wrap">
        <button className="btn primary" disabled={busy || !f.method || !attest}>Record the check</button>
        {v.identity && <button type="button" className="btn ghost" onClick={() => setAgain(false)}>Keep what was recorded</button>}
      </div>
    </form>
  );
}

function Helps({ v, onDone }: { v: any; onDone: () => void }) {
  const [kind, setKind] = useState<HelpKind | ''>('');
  const [language, setLanguage] = useState('');
  const [interpreter, setInterpreter] = useState('');
  const [attest, setAttest] = useState(false);
  const recorded = new Set(v.helps.map((h: any) => h.kind));
  const p = v.person.name;
  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/counter/visits/${v.visit.id}/helps`, { body: { kind, language, interpreter, attest } });
      toast('Recorded');
      setKind('');
      setAttest(false);
      onDone();
    } catch (err) {
      oops(err);
    }
  }
  return (
    <details className="card" data-fold="">
      <summary><b>2. Help with signing</b> <span className="muted small">{v.helps.length ? `${v.helps.length} recorded` : 'Only when needed'}</span></summary>
      <div className="stack" style={{ marginTop: 10 }}>
        {v.helps.map((h: any) => (
          <div key={h.id} className="ct-row">
            <div className="ct-who"><b>{h.label}</b>{h.language ? `, ${h.language}` : ''}{h.interpreter ? `, ${h.interpreter}` : ''}
              <div className="muted small">{h.needs_second ? 'Waiting for a second official to confirm it on their own device.' : h.second ? `Confirmed by ${h.second}.` : `Stated by ${h.by}.`}</div></div>
            <button type="button" className="btn ghost" aria-label={`Take back ${h.label}`} onClick={() => api(`/counter/visits/${v.visit.id}/helps/${h.id}`, { method: 'DELETE' }).then(onDone).catch(oops)}>Take back</button>
          </div>
        ))}
        {v.witness ? <p className="muted small" style={{ margin: 0 }}>Witness on this document: {v.witness.name}.</p> : null}
        <form className="stack" onSubmit={add}>
          <fieldset className="ct-radio">
            <legend>What help did you give?</legend>
            {/* A mark needs a witness on the document: without one the option is absent, not refused later. */}
            {HELP_KINDS.filter((k) => !recorded.has(k) && (k !== 'mark' || v.witness)).map((k) => (
              <label key={k}><input type="radio" name="ct-help" checked={kind === k} onChange={() => (setKind(k), setAttest(false))} /> <span>{HELPS[k].label}<span className="muted small"> {HELPS[k].hint}</span></span></label>
            ))}
          </fieldset>
          {(kind === 'read_aloud' || kind === 'interpreter') && <label className="f"><span>Language</span><input value={language} onChange={(e) => setLanguage(e.target.value)} maxLength={60} /></label>}
          {kind === 'interpreter' && <label className="f"><span>Interpreter&apos;s full name</span><input value={interpreter} onChange={(e) => setInterpreter(e.target.value)} maxLength={120} /></label>}
          {kind && <label className="check ct-statement"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /> <span>{helpStatement(kind, { p, language: language || '…', interpreter: interpreter || '…' })}</span></label>}
          {kind && <div><button className="btn" disabled={!attest}>Record this help</button></div>}
        </form>
      </div>
    </details>
  );
}

function OpenIt({ v, onDone }: { v: any; onDone: () => void }) {
  const [code, setCode] = useState<any>(null);
  async function connect() {
    try {
      setCode(await api(`/counter/visits/${v.visit.id}/code`, { method: 'POST' }));
    } catch (err) {
      oops(err);
    }
  }
  async function here() {
    try {
      const { url } = await api(`/counter/visits/${v.visit.id}/link`, { method: 'POST' });
      await openToSign(v.envelope.id, { role: 'inperson', name: v.person.name }, url);
    } catch (err) {
      oops(err);
    }
  }
  // Once a screen is connected with this code, the code is no longer needed here. A screen connected before the code
  // was made (one that stopped working, say) does not count.
  useEffect(() => {
    if (code && v.screen && v.screen_at && v.screen_at >= code.created_at) setCode(null);
  }, [v.screen, v.screen_at, code]);
  const qr = code ? qrForLink(code.url) : null;
  const connected = v.screen && !code;
  return (
    <div className="card stack">
      <h2>3. The document</h2>
      {connected && <p className="ct-done">The citizen&apos;s screen is connected. The document is open there.</p>}
      <>
          {/* Also while a screen is connected: a tablet that died or was swapped can be replaced at once. */}
          <div className="row wrap">
            <button type="button" className={connected ? 'btn ghost' : 'btn primary'} onClick={connect}>{connected ? 'Connect another screen' : 'Connect the citizen\'s screen'}</button>
            <button type="button" className={connected ? 'btn ghost' : 'btn'} onClick={here}>Hand this device over</button>
          </div>
          {code && (
            <div className="stack" role="status">
              <p style={{ margin: 0 }}>On the citizen&apos;s screen, open {window.location.origin}/counter/screen and type this code, or scan it. It works once, for {PAIR_MINUTES} minutes.</p>
              <div className="ct-code" aria-label={`Code ${code.code.split('').join(' ')}`}>{showCode(code.code)}</div>
              {qr && qr.ok && <div className="ct-qr"><QrCode svg={qr.svg} label="QR code that connects the citizen's screen to this signing" /></div>}
              <div><button type="button" className="btn ghost" onClick={onDone}>I have typed it in</button></div>
            </div>
          )}
          <p className="muted small" style={{ margin: 0 }}>Hand this device over locks your account in this browser until you type your password again.</p>
      </>
      <p className="muted small" style={{ margin: 0 }}>{PAD_LINE}</p>
    </div>
  );
}

function Progress({ v }: { v: any }) {
  const p = v.person;
  const step = p.status === 'completed' ? 'Finished' : p.agreed ? 'Signing' : p.opened ? 'Reading' : 'Not opened yet';
  return (
    <div className="card stack" aria-live="polite">
      <h2>Progress</h2>
      <dl className="ct-progress">
        <div><dt>Now</dt><dd>{step}</dd></div>
        <div><dt>Fields filled in</dt><dd>{v.progress.filled} of {v.progress.fields}</dd></div>
        {v.helps.some((h: any) => h.needs_second) && <div><dt>Second official</dt><dd>Not confirmed yet</dd></div>}
      </dl>
      {v.progress.values ? (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{v.progress.values.map((x: any, i: number) => <li key={i}>{x.label}: {x.value || 'empty'}</li>)}</ul>
      ) : <p className="muted small" style={{ margin: 0 }}>What they type is not shown here. An admin can allow it for this template.</p>}
    </div>
  );
}

// A colleague's visit that needs a second official: they confirm with their own login, on their own device.
function SecondOfficial({ v, onDone }: { v: any; onDone: () => void }) {
  const [attest, setAttest] = useState(false);
  const h = v.helps.find((x: any) => x.needs_second);
  if (!h) return <div className="notice">{v.visit.official} is with this person. Press Start on their line on the Counter to take them over.</div>;
  return (
    <div className="card stack">
      <h2>Confirm as the second official</h2>
      <p style={{ margin: 0 }}>{v.visit.official} is signing for {v.person.name}, who cannot sign. Confirm only if you heard them ask for it yourself.</p>
      <label className="check ct-statement"><input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} /> <span>{behalfSecond(v.person.name, h.by)}</span></label>
      <div><button type="button" className="btn primary" disabled={!attest} onClick={() => api(`/counter/visits/${v.visit.id}/helps/${h.id}/confirm`, { body: { attest } }).then(() => (toast('Confirmed'), onDone())).catch(oops)}>Confirm</button></div>
    </div>
  );
}
