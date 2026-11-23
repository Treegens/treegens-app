'use client';
// Signing in person where there is no signal: the page the host's device opens, with or without a connection
// (public/sw.js keeps this page, which is the same for everyone; what it shows comes from the device's own encrypted
// copy, src/components/sign/offlineInPerson.ts). The host types the PIN and hands the device over; the person agrees,
// reads, fills in, signs and finishes; the result waits on the device until there is signal; then it is sent, and
// nothing is signed before GrowSigning has it. The server's side is src/server/offlinesign.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { PdfDoc } from '@/components/PdfDoc';
import { AdoptSignature } from '@/components/SignaturePad';
import { OwnTermsBlock } from '@/components/sign/OwnTerms';
import { ConsentDetails } from '@/components/sign/ConsentDetails';
import { Logo } from '@/components/Brand';
import { consentWording, consentPart } from '@/lib/policy';
import { deviceZone, formatDate } from '@/lib/dates';
import { OFFLINE_WORDS, PIN_TRIES, OFFLINE_DAYS } from '@/lib/offlinesign';
import { idbBox, peek, unlock, saveResult, sendResult, wipe, HANDED_KEY, PinError, type Pack, type Result } from '@/components/sign/offlineInPerson';
import { fieldName, pos, finishProblem, problemWith } from '@/components/sign/fields';
import { keepPageForLater, pageKept } from '@/components/sign/offlinePage';
import '../styles/inperson.css';

type Stage = 'loading' | 'none' | 'pin' | 'host' | 'consent' | 'sign' | 'saved' | 'sent' | 'refused' | 'not_signing';
const AUTO = ['date_signed', 'full_name', 'email'];
const RETRY_MS = 15_000;

const post = async (url: string, body: any) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const handed = (v: string | null) => {
  try {
    if (v) localStorage.setItem(HANDED_KEY, v);
    else localStorage.removeItem(HANDED_KEY);
  } catch {
    /* without storage the lock on the server still holds when there was signal */
  }
};

/** Loads pdf.js and starts one worker for all documents of this page (src/components/PdfDoc.tsx loads the same module). */
async function warmViewer() {
  try {
    const m = await (new Function('u', 'return import(u)') as (u: string) => Promise<any>)('/pdfjs/pdf.min.mjs');
    // The worker is started from the file as fetched (through the kept copy when there is no signal): a worker's own
    // address is not always answered by the service worker, and with no signal it then fails to start.
    if (!m.GlobalWorkerOptions.workerPort) {
      let src = '/pdfjs/pdf.worker.min.mjs';
      try {
        const res = await fetch(src);
        if (res.ok) src = URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
      } catch {
        /* the address itself, below */
      }
      m.GlobalWorkerOptions.workerPort ??= new Worker(src, { type: 'module' });
    }
  } catch {
    /* the viewer says itself that the document cannot be shown, and the person's part still works */
  }
}

export default function InPersonPage() {
  const box = useRef(idbBox());
  const [stage, setStage] = useState<Stage>('loading');
  const [ends, setEnds] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [pack, setPack] = useState<Pack | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [note, setNote] = useState('');
  const [agree, setAgree] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [sig, setSig] = useState<string | null>(null);
  // How the signature and initials were made here, for the certificate (src/lib/switches.ts howText).
  const hows = useRef<{ signature_how?: string; initials_how?: string }>({});
  const [ini, setIni] = useState<string | null>(null);
  const [adopt, setAdopt] = useState<'signature' | 'initials' | null>(null);
  const [urls, setUrls] = useState<string[]>([]);
  const [pinBack, setPinBack] = useState(false);
  const [hostBack, setHostBack] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [refusedKept, setRefusedKept] = useState(false);
  const [sure, setSure] = useState(false);
  const [notKept, setNotKept] = useState(false);

  useEffect(() => {
    document.title = 'Sign in person · GrowSigning';
    // In the installed app the page also has to open later with no signal: it asks to be kept (public/sw.js).
    // Visiting it is not enough to keep it (src/components/sign/offlinePage.ts): it is kept on purpose, and checked.
    if (process.env.NODE_ENV === 'production') {
      void pageKept().then(async (kept) => {
        if (kept) return;
        if (online() && (await keepPageForLater())) return;
        setNotKept(true);
      });
    }
    // The PDF viewer and its worker are loaded now, while the page may still have signal, and kept for every page
    // drawn later: with no signal they come from the device's copy (public/sw.js) or from here.
    void warmViewer();
    peek(box.current).then((p) => {
      if (p.state === 'none') return setStage('none');
      setEnds(p.expires_at);
      setStage('pin');
    });
  }, []);

  // The files as the device keeps them, shown with the same viewer as the signing page.
  useEffect(() => {
    if (!pack) return;
    const made = pack.files.map((f) => URL.createObjectURL(new Blob([Uint8Array.from(atob(f.pdf), (c) => c.charCodeAt(0))], { type: 'application/pdf' })));
    setUrls(made);
    return () => made.forEach((u) => URL.revokeObjectURL(u));
  }, [pack]);

  const name = pack?.view?.recipient?.name || 'the person signing';
  const host = pack?.host || 'the host';
  const subject = pack?.view?.envelope?.subject || 'the document';
  const sender = pack?.view?.envelope?.sender?.name || host;
  const wording = consentWording(sender, consentPart('inperson'), undefined, 'en');
  const fields: any[] = (pack?.view?.fields || []).filter((f: any) => !f.readonly && !AUTO.includes(f.type));

  const trySend = useCallback(async (p: Pack, r: Result) => {
    if (!online()) return setNote(OFFLINE_WORDS.saved);
    const s = await sendResult(box.current, p, r, post);
    setNote(s.text);
    // Sent: the account stays locked for whoever holds the device until the host types their password (AppShell).
    if (s.state === 'sent') setStage('sent');
    else if (s.state === 'refused') (setRefusedKept(!!s.kept), setStage('refused'));
  }, []);

  // While the person holds the device, Back stays on this page: the pages behind it need signal, and are the host's.
  const holding = stage === 'consent' || stage === 'sign' || stage === 'not_signing' || (stage === 'saved' && !hostBack);
  useEffect(() => {
    if (!holding) return;
    history.pushState({ ip: 1 }, '', location.href);
    const stay = () => history.pushState({ ip: 1 }, '', location.href);
    window.addEventListener('popstate', stay);
    return () => window.removeEventListener('popstate', stay);
  }, [holding]);

  // Sent by itself when the device says it is back online, and every 15 seconds while it says it is.
  useEffect(() => {
    if (stage !== 'saved' || !pack || !result) return;
    const go = () => void trySend(pack, result);
    window.addEventListener('online', go);
    const t = window.setInterval(() => online() && go(), RETRY_MS);
    return () => (window.removeEventListener('online', go), window.clearInterval(t));
  }, [stage, pack, result, trySend]);

  async function open(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError('');
    try {
      const o = await unlock(box.current, pin);
      setPin('');
      setKey(o.key);
      setPack(o.pack);
      if (o.result) {
        setHostBack(true);
        setResult(o.result);
        setStage('saved');
        setNote(OFFLINE_WORDS.saved);
        void trySend(o.pack, o.result);
      } else setStage('host');
      setPinBack(false);
      setDeclined(false);
    } catch (e: any) {
      setError(e?.message || 'That did not work. Try again.');
      if (e instanceof PinError && e.code !== 'wrong_pin') setStage('none');
    }
    setBusy(false);
  }

  async function handOver() {
    if (!pack) return;
    handed(pack.prep_id);
    // With signal, the account locks on the server now, as Host signing now does. Without, the app locks it the
    // first time it opens with signal (AppShell reads HANDED_KEY).
    if (online()) await fetch(`/api/offline/${encodeURIComponent(pack.prep_id)}/hand-over`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.ok && handed(null)).catch(() => {});
    setStage(pack.view?.recipient?.consented ? 'sign' : 'consent');
    window.scrollTo(0, 0);
  }

  async function finish() {
    if (!pack || !key) return;
    const missing = fields.find((f) => f.required && !values[f.id] && !(f.type === 'signature' && sig) && !(f.type === 'initials' && ini) && !(f.type === 'radio' && fields.some((x) => x.type === 'radio' && (x.group_name || x.id) === (f.group_name || f.id) && values[x.id])));
    if (missing) return (setError(`${fieldName(missing)} is still empty. Fill it in, then choose Finish.`), goTo(missing));
    if (fields.some((f) => f.type === 'signature') && !sig) return setError('Add your signature first, then choose Finish.');
    // The same checks GrowSigning makes when it receives it (src/lib/fieldrules.ts), so a mistake is put right now,
    // while the person is still here, not found after they have gone.
    const wrong = finishProblem(fields, values, pack.view?.envelope?.date_format);
    if (wrong) return (setError(`${fieldName(wrong.field)}: ${wrong.text}`), goTo(wrong.field));
    setBusy(true);
    const all: Record<string, string> = { ...values };
    for (const f of fields) if (f.type === 'signature' || f.type === 'initials') all[f.id] = '1';
    const r: Result = { values: all, signature_png: sig, initials_png: ini, ...hows.current, consent: { wording: wording.version, language: wording.language, page_language: 'en', tz: deviceZone(), own: pack.view?.own_terms?.id }, device_at: new Date().toISOString() };
    try {
      await saveResult(box.current, key, r);
    } catch (e: any) {
      setBusy(false);
      return setError(e?.message || 'This could not be saved on this device. Try again.');
    }
    setResult(r);
    setStage('saved');
    setNote(OFFLINE_WORDS.saved);
    setBusy(false);
    window.scrollTo(0, 0);
    void trySend(pack, r);
  }

  async function remove() {
    await wipe(box.current);
    handed(null);
    // The copy on the server ends too when there is signal, so nothing can come back for it.
    if (pack && online()) await fetch(`/api/envelopes/${encodeURIComponent(pack.view?.envelope?.id || '')}/offline/${encodeURIComponent(pack.prep_id)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    setPack(null);
    setResult(null);
    setSure(false);
    setStage('none');
  }

  /** Back to the form with what the person did, after the server would not take it as it was. */
  function changePart() {
    if (!result) return;
    setValues(Object.fromEntries(Object.entries(result.values).filter(([id]) => !fields.some((f) => f.id === id && (f.type === 'signature' || f.type === 'initials')))));
    setSig(result.signature_png);
    setIni(result.initials_png);
    setAgree(true);
    setHostBack(false);
    setError('');
    setStage('sign');
    window.scrollTo(0, 0);
  }

  /** Moves to the control of a field in "Your part", from its spot on the page or from a message about it. */
  function goTo(f: any) {
    window.setTimeout(() => {
      const el = document.getElementById(`ip-f-${f.id}`);
      el?.scrollIntoView({ block: 'center' });
      el?.focus({ preventScroll: true });
    }, 0);
  }

  const top = (
    <header className="ip-top"><Logo height={20} /></header>
  );

  if (stage === 'loading') return <main className="ip">{top}<p className="muted">Opening…</p></main>;

  if (stage === 'none') return (
    <main className="ip">{top}
      <div className="card">
        <h1>Nothing is ready on this device</h1>
        {error ? <p className="notice err" role="alert">{error}</p> : <p className="muted">A document kept here to sign in person without signal stays for {OFFLINE_DAYS} days at most, and is wiped once it is sent.</p>}
        <p><a className="btn" href="/app">Open GrowSigning</a></p>
      </div>
    </main>
  );

  if (stage === 'pin') return (
    <main className="ip">{top}
      <form className="card" onSubmit={open}>
        <h1>{pinBack ? 'Hand the device back' : 'Type your PIN'}</h1>
        {notKept && <p className="notice warn small">{OFFLINE_WORDS.notKept}</p>}
        {declined && <p className="notice small">{name} chose not to sign. Nothing was sent. The document still waits for them.</p>}
        <p className="muted">{pinBack ? `Only ${host} goes on from here.` : `This device holds a document for someone to sign in person.${ends ? ` It is kept until ${formatDate(ends, 'D MMM YYYY')}.` : ''}`}</p>
        <label className="f"><span>PIN</span>
          <input type="password" autoComplete="off" autoFocus value={pin} onChange={(e) => (setPin(e.target.value), setError(''))} aria-describedby={error ? 'ip-err' : undefined} />
        </label>
        {error && <p id="ip-err" className="notice err" role="alert">{error}</p>}
        <button className="btn primary ip-wide" disabled={busy || !pin}>{busy ? 'Checking…' : 'Open'}</button>
        <p className="muted small">{PIN_TRIES} wrong PINs in a row wipe the copy on this device.</p>
      </form>
    </main>
  );

  if (stage === 'host' && pack) return (
    <main className="ip">{top}
      <div className="card">
        <h1>Ready for {name}</h1>
        <p><b>{subject}</b></p>
        {notKept && <p className="notice warn small">{OFFLINE_WORDS.notKept}</p>}
        <p className="muted">Kept on this device until {formatDate(pack.expires_at, 'D MMM YYYY')}. {name} can sign here without signal. It is sent when the device has signal again, and nothing is signed until then.</p>
        <p className="muted small">If you hand the device over with no signal, your account locks the first time GrowSigning opens on it with signal. Until then, only this page is open on it.</p>
        <button className="btn primary ip-wide" onClick={handOver}>Hand over to {name}</button>
        <p className="small"><button type="button" className="btn sm" onClick={remove}>Remove it from this device</button></p>
      </div>
    </main>
  );

  if (stage === 'consent' && pack) return (
    <main className="ip">{top}
      <div className="card">
        <h1>{subject}</h1>
        <p>{sender} asks you to sign this, {name}.</p>
        <div id="ip-legal">
          <p className="small">{OFFLINE_WORDS.consentNote(host)}</p>
          {wording.legal && <p className="muted small">{wording.legal}</p>}
          {wording.practical && <p className="muted small">{wording.practical}</p>}
        </div>
        {pack.view?.own_terms && <OwnTermsBlock own={pack.view.own_terms} lang="en" paper={false} />}
        <label className="check ip-agree"><input type="checkbox" checked={agree} onChange={(e) => (setAgree(e.target.checked), setError(''))} aria-describedby="ip-legal" /> <span>{wording.agree}</span></label>
        {error && <p className="notice err" role="alert">{error}</p>}
        <button className="btn primary ip-wide" onClick={() => (agree ? (setError(''), setStage('sign'), window.scrollTo(0, 0)) : setError('Tick the box first, then choose Continue.'))}>Continue</button>
        <Ways urls={urls} files={pack.files} host={host} onNo={() => setStage('not_signing')} />
        <ConsentDetails wording={wording} />
      </div>
    </main>
  );

  if (stage === 'sign' && pack) return (
    <main className="ip ip-signing">{top}
      <h1 className="ip-subject">{subject}</h1>
      <p className="muted small ip-hint">Read the document, then fill in your part below it. <button type="button" className="btn sm" onClick={() => document.getElementById('ip-part-h')?.scrollIntoView({ block: 'start' })}>Go to your part</button></p>
      {pack.files.map((f, i) => (
        <section key={f.id} aria-label={f.name} className="ip-doc">
          {pack.files.length > 1 && <h2 className="small">{f.name}</h2>}
          {urls[i] && <PdfDoc url={urls[i]} maxWidth={760} overlay={(page) => fields.filter((x) => x.document_id === f.id && x.page === page).map((x) => (
            // Where each of the person's fields sits on the page, with its name. A tap goes to its control under the document.
            <button key={x.id} type="button" className="ip-spot" style={pos(x)} aria-label={`Fill in ${fieldName(x)}`} onClick={() => goTo(x)}><span>{fieldName(x)}</span></button>
          ))} />}
        </section>
      ))}
      <section className="card ip-part" aria-labelledby="ip-part-h">
        <h2 id="ip-part-h">Your part</h2>
        {fields.map((f) => <Field key={f.id} f={f} fields={fields} values={values} setValues={setValues} sig={sig} ini={ini} onAdopt={setAdopt} dateFormat={pack.view?.envelope?.date_format} />)}
        {error && <p className="notice err" role="alert">{error}</p>}
        <button className="btn primary ip-wide" disabled={busy} onClick={finish}>Finish</button>
        <p className="muted small">Finish keeps your answers on this device. They are sent to {sender} when the device has signal again.</p>
        <Ways urls={urls} files={pack.files} host={host} onNo={() => setStage('not_signing')} />
      </section>
      {adopt && <AdoptSignature kind={adopt} name={name} ways={pack.view?.switches?.ways} onClose={() => setAdopt(null)} onDone={(png, _typed, how) => (adopt === 'signature' ? setSig(png) : setIni(png), how && (hows.current = { ...hows.current, [adopt === 'signature' ? 'signature_how' : 'initials_how']: how }), setAdopt(null), setError(''))} />}
    </main>
  );

  if (stage === 'not_signing') return (
    <main className="ip">{top}
      <div className="card" role="status">
        <h1>Nothing was signed</h1>
        <p>Nothing was signed, and nothing is sent. Nothing you typed was kept. If you want it on paper instead, ask {host}. Please hand the device back to {host}.</p>
        <button className="btn ip-wide" onClick={() => (setPinBack(true), setDeclined(true), setKey(null), setPack(null), setValues({}), setSig(null), setIni(null), setAgree(false), setStage('pin'))}>I am {host}</button>
      </div>
    </main>
  );

  if (stage === 'saved' && hostBack) return (
    <main className="ip">{top}
      <div className="card" role="status">
        <h1>Waiting for signal</h1>
        <p>{note || OFFLINE_WORDS.saved}</p>
        <p className="muted">{name} finished on this device. Keep this page open, or open it again later and type your PIN. Send it within {OFFLINE_DAYS} days of getting it ready, before the copy is wiped.</p>
        <button className="btn primary ip-wide" disabled={busy} onClick={() => pack && result && (setBusy(true), trySend(pack, result).finally(() => setBusy(false)))}>Send now</button>
        {sure ? (
          <p className="notice warn small" role="alert">This removes what {name} did from this device, and nothing is signed.{' '}
            <button type="button" className="btn sm" onClick={remove}>Remove it</button> <button type="button" className="btn sm" onClick={() => setSure(false)}>Keep it</button></p>
        ) : <p className="small"><button type="button" className="btn sm" onClick={() => setSure(true)}>Remove it from this device</button></p>}
      </div>
    </main>
  );

  if (stage === 'saved') return (
    <main className="ip">{top}
      <div className="card" role="status">
        <h1>{OFFLINE_WORDS.savedTitle}</h1>
        <p>{note && note !== OFFLINE_WORDS.saved ? note : OFFLINE_WORDS.waiting}</p>
        <p className="notice">Thank you, {name}. Please hand the device back to {host}.</p>
        <button className="btn ip-wide" onClick={() => (setPinBack(true), setKey(null), setPack(null), setStage('pin'))}>I am {host}</button>
      </div>
    </main>
  );

  if (stage === 'sent') return (
    <main className="ip">{top}
      <div className="card" role="status">
        <h1>Sent</h1>
        <p>{note}</p>
        <p><a className="btn primary ip-wide" href={pack?.view?.envelope?.id ? `/app/envelopes/${pack.view.envelope.id}` : '/app'}>Back to the document</a></p>
      </div>
    </main>
  );

  return (
    <main className="ip">{top}
      <div className="card" role="alert">
        <h1>Not signed</h1>
        <p>{note}</p>
        {refusedKept && pack && key && result ? (
          <>
            <p>{OFFLINE_WORDS.keptAfterRefusal(name)}</p>
            <button className="btn primary ip-wide" onClick={changePart}>Change {name}&apos;s part</button>
            <p className="small"><button type="button" className="btn sm" onClick={remove}>Remove it from this device</button></p>
          </>
        ) : <p><a className="btn primary ip-wide" href={pack?.view?.envelope?.id ? `/app/envelopes/${pack.view.envelope.id}` : '/app'}>Open the document</a></p>}
      </div>
    </main>
  );
}

/** The other ways, as the consent wording promises: a copy of the document now, Decline (nothing is signed or sent), and paper (asked of the host, who is there). */
function Ways({ urls, files, host, onNo }: { urls: string[]; files: Pack['files']; host: string; onNo: () => void }) {
  return (
    <p className="ip-ways small">
      {files.map((f, i) => urls[i] && <a key={f.id} className="btn sm" href={urls[i]} download={`${f.name}.pdf`}>Download {files.length > 1 ? f.name : 'a copy'}</a>)}
      <button type="button" className="btn sm" onClick={onNo}>Decline to sign</button>
      <span className="muted">For paper instead, ask {host}.</span>
    </p>
  );
}

/** One field of the person's part, as a plain control with its name, so it works with a keyboard and a screen reader. */
function Field({ f, fields, values, setValues, sig, ini, onAdopt, dateFormat }: { f: any; fields: any[]; values: Record<string, string>; setValues: (fn: (v: Record<string, string>) => Record<string, string>) => void; sig: string | null; ini: string | null; onAdopt: (k: 'signature' | 'initials') => void; dateFormat?: string | null }) {
  const set = (v: string) => setValues((o) => ({ ...o, [f.id]: v }));
  const label = `${fieldName(f)}${f.required ? '' : ' (optional)'}`;
  const fid = `ip-f-${f.id}`;
  if (f.type === 'signature' || f.type === 'initials') {
    // Initials are the person's own, made for initials, as on the signing page: never their signature put in their place.
    const img = f.type === 'signature' ? sig : ini;
    return (
      <div className="ip-field">
        <span className="ip-label">{label}</span>
        {img && <img className="ip-mark" src={img} alt={`Your ${f.type === 'signature' ? 'signature' : 'initials'}`} />}
        <button type="button" id={fid} className="btn" onClick={() => onAdopt(f.type)}>{img ? 'Change' : f.type === 'signature' ? 'Sign' : 'Add initials'}</button>
      </div>
    );
  }
  if (f.type === 'checkbox') return <label className="check ip-field"><input id={fid} type="checkbox" checked={values[f.id] === '1'} onChange={(e) => set(e.target.checked ? '1' : '')} /> <span>{label}</span></label>;
  if (f.type === 'radio') {
    const group = f.group_name || f.id;
    const pick = () => setValues((o) => ({ ...o, ...Object.fromEntries(fields.filter((x) => x.type === 'radio' && (x.group_name || x.id) === group).map((x) => [x.id, x.id === f.id ? '1' : ''])) }));
    return <label className="check ip-field"><input id={fid} type="radio" name={`ip-${group}`} checked={values[f.id] === '1'} onChange={pick} /> <span>{f.label || `Option of ${f.group_name || 'a choice'}`}</span></label>;
  }
  if (f.type === 'dropdown') return (
    <label className="f ip-field"><span>{label}</span>
      <select id={fid} value={values[f.id] || ''} onChange={(e) => set(e.target.value)}><option value="">Choose</option>{(f.options || []).map((o: string) => <option key={o}>{o}</option>)}</select>
    </label>
  );
  // The same check GrowSigning makes when it receives it, said under the field as soon as something is typed.
  const problem = problemWith(f, values[f.id] || '', dateFormat);
  return (
    <label className="f ip-field"><span>{label}</span>
      <input id={fid} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} value={values[f.id] || ''} onChange={(e) => set(e.target.value)} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${fid}-p` : undefined} />
      {problem && <span id={`${fid}-p`} className="ip-problem small">{problem}</span>}
    </label>
  );
}
