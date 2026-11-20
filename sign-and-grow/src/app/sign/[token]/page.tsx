'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, toast, fmtDate } from '@/components/ui';
import { PdfDoc } from '@/components/PdfDoc';
import { AdoptSignature } from '@/components/SignaturePad';
import { formatDate } from '@/lib/dates';
import { fmtNum } from '@/lib/impact';
import { Shell, StateCard, Sender, Impact, Icon, useMedia, bringIntoView } from '@/components/sign/parts';
import { ReplacedLink, UnknownLink, LoadProblem } from '@/components/sign/deadEnds';
import { MenuDialog, AskDialog, ReportDialog, DeclineDialog, ReassignDialog, SignedFieldDialog, ReviewDialog, FieldSheet, type MenuItem } from '@/components/sign/dialogs';
import { TextView } from '@/components/sign/TextView';
import { PageFields, PageOthers, type FieldCtx } from '@/components/sign/TextFields';
import { AUTO, TYPED, fieldName, groupKey, isBox, isMulti, buildItems, problemWith, pos, readKept, writeKept } from '@/components/sign/fields';

type Save = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
type Open = '' | 'menu' | 'decline' | 'reassign' | 'ask' | 'report' | 'review';
const SAVE_TEXT: Record<Save, string> = { idle: 'Saves as you go', pending: 'Saving', saving: 'Saving', saved: 'Saved', error: 'Not saved yet' };
const FLAG: Record<string, string> = { signature: 'Sign here', initials: 'Initial here', checkbox: 'Tick here', radio: 'Choose one', dropdown: 'Choose here', attachment: 'Attach here' };
// Phones, and anything else used mainly by touch, get a sheet with a large input instead of typing into the page.
// Typing straight into a small box makes touch browsers zoom in and out.
const TOUCH = '(max-width: 600px), (pointer: coarse)';

export default function SignPage() {
  const { token } = useParams<{ token: string }>();
  const base = `/sign/${token}`;
  const [data, setData] = useState<any>(null);
  const [problem, setProblem] = useState<{ status: number; message: string } | null>(null);
  const [handedTo, setHandedTo] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [sig, setSig] = useState<string | null>(null);
  const [ini, setIni] = useState<string | null>(null);
  const [adopt, setAdopt] = useState<{ kind: 'signature' | 'initials'; field?: string } | null>(null);
  const [open, setOpen] = useState<Open>('');
  const [signedField, setSignedField] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [view, setView] = useState<'doc' | 'text'>('doc');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  const [agree, setAgree] = useState(false);
  const [code, setCode] = useState('');
  const [formError, setFormError] = useState('');
  const [finishError, setFinishError] = useState('');
  const [finished, setFinished] = useState<any>(null);
  const [save, setSave] = useState<Save>('idle');
  const [muted, setMuted] = useState(false);
  const [muteNote, setMuteNote] = useState<'' | 'done' | 'failed'>('');
  const [moreTime, setMoreTime] = useState<'' | 'busy' | 'asked'>('');
  const touch = useMedia(TOUCH);

  const valuesRef = useRef(values);
  valuesRef.current = values;
  const kept = useRef<{ sig: string | null; ini: string | null }>({ sig: null, ini: null });
  kept.current = { sig, ini };
  const lastSaved = useRef('');
  const canSave = useRef(false);
  const rejected = useRef(0);
  const afterClose = useRef<any>(null);
  const stageRef = useRef('loading');

  const load = useCallback(async () => {
    try {
      const d = await api(base);
      setProblem(null);
      setData(d);
      setMuted((m) => m || !!d.recipient?.muted);
      if (d.fields) {
        const server: Record<string, string> = Object.fromEntries(d.fields.map((f: any) => [f.id, f.value || '']));
        const before = JSON.stringify(server);
        const stored = readKept(token);
        const s = kept.current.sig || d.recipient.signature_png || stored.sig;
        const i = kept.current.ini || d.recipient.initials_png || stored.ini;
        // A field saved as signed is no use without the signature itself. Ask again instead of guessing.
        for (const f of d.fields) if ((f.type === 'signature' && !s) || (f.type === 'initials' && !i)) server[f.id] = '';
        setSig(s);
        setIni(i);
        const unsaved = !!lastSaved.current && JSON.stringify(valuesRef.current) !== lastSaved.current;
        setValues((prev) => (unsaved ? { ...server, ...prev } : server));
        lastSaved.current = before;
      }
    } catch (e: any) {
      const status = e?.status || 0;
      if (status === 404 || status === 410) setData(null);
      setProblem({ status, message: e?.message || 'Something went wrong on our side.' });
    }
  }, [base, token]);
  useEffect(() => {
    load();
  }, [load]);

  // Someone who is signed in gets the signature saved on their own account offered. Never in person: that device belongs to the host.
  useEffect(() => {
    if (!data?.recipient || data.recipient.role === 'inperson' || !data.fields) return;
    api('/me').then((m) => {
      if (m.user?.email?.toLowerCase() === data.recipient.email.toLowerCase()) {
        setSig((s) => s || m.user.signature_png || null);
        setIni((s) => s || m.user.initials_png || null);
      }
    }).catch(() => {});
  }, [data?.recipient?.email, data?.recipient?.role, !!data?.fields]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try {
      if (localStorage.getItem('sg:view') === 'text') setView('text');
    } catch {
      /* no storage: start in the document view */
    }
  }, []);
  function chooseView(v: 'doc' | 'text') {
    setView(v);
    try {
      localStorage.setItem('sg:view', v);
    } catch {
      /* the choice just is not remembered */
    }
  }

  const mute = useCallback(async (fromEmail = false) => {
    try {
      await api(`${base}/mute`, { method: 'POST' });
      setMuted(true);
      if (fromEmail) setMuteNote('done');
      else toast('Reminder emails are off for this document.');
    } catch (e: any) {
      if (e?.status === 404 || e?.status === 410) return;
      if (fromEmail) setMuteNote('failed');
      else toast(`${e?.message || 'We could not turn off reminders.'} Try again in a minute.`, true);
    }
  }, [base]);
  // The "stop reminders" link in a reminder email lands here.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('mute') !== '1') return;
    q.delete('mute');
    window.history.replaceState(null, '', window.location.pathname + (q.size ? `?${q}` : ''));
    mute(true);
  }, [mute]);

  const me = data?.recipient;
  const env = data?.envelope;
  const fields: any[] = useMemo(() => data?.fields || [], [data?.fields]);
  const acts = me?.role === 'signer' || me?.role === 'inperson';
  const closed = !!env && (env.status === 'voided' || env.status === 'declined' || env.status === 'expired' || me.status === 'declined');
  const iAmDone = !!finished || me?.status === 'completed';
  // A closed or not-yet-ready document says so straight away, before anyone is asked for an access code.
  const stage = handedTo ? 'handed' : !data ? (problem ? 'problem' : 'loading') : closed ? 'closed' : me.status === 'pending' ? 'pending' : data.locked ? 'locked' : iAmDone ? 'done' : !me.consented ? 'consent' : 'sign';
  canSave.current = stage === 'sign' && acts && fields.length > 0;

  // When the screen changes, start reading from its heading rather than from wherever focus was left.
  useEffect(() => {
    const before = stageRef.current;
    stageRef.current = stage;
    if (before === stage || before === 'loading') return;
    window.scrollTo({ top: 0 });
    (document.getElementById('sg-h1') || document.getElementById('sg-main'))?.focus({ preventScroll: true });
  }, [stage]);

  const filled = useCallback((f: any) => (f.type === 'signature' ? !!values[f.id] && !!sig : f.type === 'initials' ? !!values[f.id] && !!ini : !!values[f.id]), [values, sig, ini]);
  const ordered = useMemo(() => {
    const docIndex = new Map<string, number>((data?.documents || []).map((d: any, i: number) => [d.id, i]));
    const row = (f: any) => Math.round((f.y + f.h / 2) / 0.012);
    return [...fields].sort((a, b) => docIndex.get(a.document_id)! - docIndex.get(b.document_id)! || a.page - b.page || row(a) - row(b) || a.x - b.x);
  }, [fields, data?.documents]);
  const items = useMemo(() => buildItems(ordered, filled), [ordered, filled]);
  const required = items.filter((i) => i.required);
  const left = required.filter((i) => !i.done);
  const nextField = left[0]?.first;
  const dateText = formatDate(new Date(), env?.date_format);
  const byId = (id: string | null | undefined) => fields.find((f) => f.id === id);

  const set = useCallback((id: string, v: string) => setValues((s) => ({ ...s, [id]: v })), []);
  const pickRadio = useCallback((f: any) => setValues((s) => {
    const n = { ...s };
    fields.filter((x) => x.type === 'radio' && groupKey(x) === groupKey(f)).forEach((x) => (n[x.id] = ''));
    n[f.id] = '1';
    return n;
  }), [fields]);

  // ---- Autosave: nothing typed is lost to a timeout, a closed tab or a flat battery ---------------
  const flush = useCallback(async (leaving = false): Promise<boolean> => {
    if (!canSave.current) return true;
    const json = JSON.stringify(valuesRef.current);
    if (json === lastSaved.current) return true;
    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: valuesRef.current }), credentials: 'same-origin' as const };
    if (leaving) {
      // The page is going away: hand the request to the browser and do not wait for an answer.
      try {
        void fetch(`/api${base}/save`, { ...request, keepalive: true }).catch(() => {});
      } catch {
        try {
          navigator.sendBeacon(`/api${base}/save`, new Blob([request.body], { type: 'application/json' }));
        } catch {
          /* nothing more can be done from a closing page */
        }
      }
      return true;
    }
    setSave('saving');
    try {
      const res = await fetch(`/api${base}/save`, request);
      if (!res.ok) throw Object.assign(new Error(), { status: res.status });
      lastSaved.current = json;
      rejected.current = 0;
      setSave(JSON.stringify(valuesRef.current) === json ? 'saved' : 'pending');
      return true;
    } catch (e: any) {
      if (!canSave.current) return true;
      // The document changed underneath us (voided, corrected, finished elsewhere): show what is true now.
      if (e?.status >= 400 && e.status < 500 && e.status !== 429 && rejected.current++ < 2) {
        setSave('idle');
        load();
      } else setSave((s) => {
        if (s !== 'error') toast('We could not save just now. Check your connection. We will keep trying, and nothing is lost while this page stays open.', true);
        return 'error';
      });
      return false;
    }
  }, [base, load]);

  const valuesJson = JSON.stringify(values);
  useEffect(() => {
    if (stage !== 'sign' || !canSave.current || valuesJson === lastSaved.current) return;
    setSave((s) => (s === 'error' ? s : 'pending'));
    const t = setTimeout(() => flush(), 1500);
    return () => clearTimeout(t);
  }, [valuesJson, stage, flush]);
  useEffect(() => {
    if (save !== 'error') return;
    const t = setInterval(() => flush(), 8000);
    return () => clearInterval(t);
  }, [save, flush]);
  useEffect(() => {
    const hidden = () => document.visibilityState === 'hidden' && flush(true);
    const leaving = () => flush(true);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
    };
  }, [flush]);

  // The adopted signature lives in this tab until the document is finished, so a reload does not lose it.
  useEffect(() => {
    if (stage === 'sign' && acts) writeKept(token, sig, ini);
  }, [sig, ini, stage, acts, token]);

  // ---- Moving around ------------------------------------------------------------------------------
  const usesSheet = (f: any) => touch && view === 'doc' && (TYPED.includes(f.type) || f.type === 'dropdown');

  function goTo(f: any) {
    const el = document.getElementById(`${view === 'text' ? 't' : 'f'}-${f.id}`);
    if (!el) return toast('The document is still loading. Try again in a moment.');
    if (usesSheet(f)) {
      bringIntoView(el, 0.25);
      setSheet(f.id);
      return;
    }
    bringIntoView(el, view === 'text' ? 0.35 : 0.42);
    (el.matches('button, input, select, textarea, [tabindex]') ? el : el.querySelector<HTMLElement>('input, select, textarea, button'))?.focus({ preventScroll: true });
  }
  // Focus cannot move to the page while a dialog is still closing, so the move waits for it.
  useEffect(() => {
    if (sheet || adopt || open || signedField || !afterClose.current) return;
    const f = afterClose.current;
    afterClose.current = null;
    goTo(f);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  /** The next required thing after this field, wrapping round to the top. */
  function nextAfter(id: string) {
    const rest = left.filter((i) => !i.fields.some((f) => f.id === id));
    const here = ordered.findIndex((f) => f.id === id);
    return (rest.find((i) => ordered.indexOf(i.first) > here) || rest[0])?.first;
  }
  function sheetNext(id: string) {
    const f = nextAfter(id);
    if (!f) return setSheet(null);
    if (usesSheet(f)) return goTo(f);
    afterClose.current = f;
    setSheet(null);
  }

  function clickSig(f: any) {
    const kind = f.type as 'signature' | 'initials';
    if (filled(f)) return setSignedField(f.id);
    if (kind === 'signature' ? sig : ini) set(f.id, '1');
    else setAdopt({ kind, field: f.id });
  }

  async function attach(f: any, file?: File) {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    setUploading(f.id);
    try {
      const r = await api(`${base}/upload`, { form });
      set(f.id, r.id);
      toast('File attached');
    } catch (e: any) {
      toast(`${e?.message || 'That file could not be attached.'} Choose the file again, or try a PDF, PNG or JPEG.`, true);
    } finally {
      setUploading('');
    }
  }

  function pressFinish() {
    if (me.role === 'viewer') return complete();
    const wrong = acts && ordered.find((f) => problemWith(f, values[f.id] || ''));
    if (wrong) {
      // On a phone the field opens in its sheet, which says what is wrong right under the input.
      if (!usesSheet(wrong)) toast(`${fieldName(wrong)} needs another look. ${problemWith(wrong, values[wrong.id])}`, true);
      return goTo(wrong);
    }
    setFinishError('');
    setOpen('review');
  }

  async function complete() {
    setBusy(true);
    setFinishError('');
    try {
      const r = await api(`${base}/complete`, { body: { values, signature_png: sig, initials_png: ini } });
      canSave.current = false;
      writeKept(token, null, null);
      setOpen('');
      setFinished(r);
    } catch (e: any) {
      const msg = e?.message || 'Something went wrong on our side.';
      if (/no longer open|already finished|not your turn/i.test(msg)) {
        setOpen('');
        toast(msg, true);
        await load();
      } else if (open === 'review') setFinishError(`${msg} Go back, put it right, then finish again.`);
      else toast(`${msg} Try again in a moment.`, true);
    } finally {
      setBusy(false);
    }
  }

  async function askForTime() {
    setMoreTime('busy');
    try {
      await api(`${base}/request-extension`, { method: 'POST' });
      setMoreTime('asked');
      return true;
    } catch (e: any) {
      setMoreTime('');
      toast(`${e?.message || 'We could not send that.'} You can also email ${env.sender.email} directly.`, true);
      return false;
    }
  }

  // ---- Screens that are not the document ------------------------------------------------------------

  if (handedTo)
    return (
      <Shell>
        <StateCard tone="ok" title={`You passed this to ${handedTo}`}>
          <p>They have been emailed their own link, and the sender has been told. Your link no longer opens the document, and there is nothing more for you to do.</p>
        </StateCard>
      </Shell>
    );
  if (!data && problem) {
    if (problem.status === 410) return <ReplacedLink token={token} />;
    if (problem.status === 404) return <UnknownLink />;
    return <LoadProblem message={problem.message} onRetry={load} />;
  }
  if (!data) return <Shell><div className="muted center sg-loading" role="status">Opening your document</div></Shell>;

  const sender = env.sender;
  const myEmail = <span className="sg-email">{me.email}</span>;
  const stillOpen = env.status === 'sent' && !iAmDone && !closed;
  const report = <button type="button" className="sg-link" onClick={() => setOpen('report')}>Report this request</button>;
  const downloadUrl = `/api${base}/download`;
  const notice = muteNote === 'done' ? (
    <div className="notice sg-top" role="status">
      <b>Reminders are off.</b> We will not send you any more reminder emails about this document.{stillOpen ? ` You can still ${acts ? 'sign' : 'open'} it here whenever you are ready.` : ''}
    </div>
  ) : muteNote === 'failed' ? (
    <div className="notice warn sg-top" role="alert">We could not turn off reminders just now. <button type="button" className="sg-link" onClick={() => mute(true)}>Try again</button></div>
  ) : null;
  const dialogs = (
    <>
      {open === 'report' && <ReportDialog base={base} sender={sender} onClose={() => setOpen('')} />}
      {open === 'ask' && <AskDialog base={base} sender={sender} replyTo={me.email} onClose={() => setOpen('')} />}
      {open === 'decline' && <DeclineDialog base={base} sender={sender} title={me.role === 'approver' ? 'Decline to approve' : 'Decline to sign'} onClose={() => setOpen('')} onDone={() => { canSave.current = false; writeKept(token, null, null); setOpen(''); load(); }} />}
      {open === 'reassign' && <ReassignDialog base={base} sender={sender} onClose={() => setOpen('')} onDone={(name) => { canSave.current = false; writeKept(token, null, null); setOpen(''); setHandedTo(name); }} />}
    </>
  );

  if (stage === 'locked')
    return (
      <Shell data={data} footer={report}>
        {notice}
        <form className="card sg-narrow" noValidate onSubmit={async (e) => {
          e.preventDefault();
          if (!code.trim()) return setFormError('Type the access code first.');
          setBusy(true);
          setFormError('');
          try {
            await api(`${base}/unlock`, { body: { code } });
            await load();
          } catch (err: any) {
            setFormError(err?.status === 401 ? `That access code is not right. Check it and try again, or ask ${sender.name} for the code.` : `${err?.message || 'Something went wrong on our side.'}`);
          } finally {
            setBusy(false);
          }
        }}>
          <div className="sg-state-icon lock"><Icon name="lock" size={26} /></div>
          <h1 className="serif" id="sg-h1" tabIndex={-1}>Enter your access code</h1>
          <p>{sender.name} protected this document with a code and will have given it to you separately. It is not in the email from us.</p>
          <label className="f"><span>Access code</span><input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={!!formError} /></label>
          {formError && <div className="notice err sg-problem" role="alert">{formError}</div>}
          <button className="btn primary lg" disabled={busy}>{busy ? 'Opening' : 'Open document'}</button>
          <p className="muted small sg-after">Do not have a code? Ask the sender for it.</p>
          <Sender env={env} brand={data.brand} />
        </form>
        {dialogs}
      </Shell>
    );

  if (stage === 'closed') {
    const expired = env.status === 'expired';
    const voided = env.status === 'voided';
    const mine = me.status === 'declined';
    return (
      <Shell data={data} footer={report}>
        {notice}
        <StateCard tone={expired ? 'warn' : 'stop'} title={voided ? `${sender.name} cancelled this document` : expired ? 'This signing request has expired' : mine ? 'You declined this document' : 'This document was declined'}>
          {voided && <p>It was voided, so there is nothing for you to sign and nothing more to do.{env.void_reason ? '' : ` Contact ${sender.name} if you have questions.`}</p>}
          {voided && env.void_reason && <p className="sg-quote"><span className="muted small">Their reason</span>{env.void_reason}</p>}
          {!voided && !expired && <p>{mine ? `We told ${sender.name}. The document is closed and there is nothing more for you to do. Changed your mind? Ask them to send it again.` : 'One of the people asked to sign said no, so the document is closed. There is nothing more for you to do.'}</p>}
          {expired && (
            <>
              <p>The deadline{env.expires_at ? ` was ${fmtDate(env.expires_at)}` : ' has passed'}. Nothing is lost: {sender.name} can open it again and you carry on from where you were.</p>
              {me.status !== 'completed' && me.status !== 'declined' && me.role !== 'cc' && (moreTime === 'asked' ? (
                <div className="notice sg-confirmed" role="status"><b>Done. We asked {sender.name} for more time.</b> You will get an email as soon as the document is open again.</div>
              ) : (
                <button type="button" className="btn primary lg" disabled={moreTime === 'busy'} onClick={askForTime}>{moreTime === 'busy' ? 'Asking' : `Ask ${sender.name} for more time`}</button>
              ))}
            </>
          )}
          <Sender env={env} brand={data.brand} lead={expired ? 'Or contact' : 'Questions? Contact'} />
        </StateCard>
        {dialogs}
      </Shell>
    );
  }

  if (stage === 'done') {
    const allDone = finished?.envelope_status === 'completed' || env.status === 'completed';
    const inPerson = me.role === 'inperson';
    const title = allDone ? 'All done. Everyone has signed.' : me.role === 'cc' ? 'Here is your copy' : me.role === 'approver' ? 'You approved this. Thank you.' : me.role === 'viewer' ? 'Marked as viewed. Thank you.' : 'You are done. Thank you.';
    return (
      <Shell data={data} footer={report}>
        {notice}
        <div className="stack">
          <StateCard tone="ok" title={title}>
            <p>
              {allDone
                ? inPerson ? `The completed document, with its certificate, has been emailed to ${sender.name}. Download your own copy here.` : <>A copy has been emailed to {myEmail}. It includes a certificate with the full record of who signed and when.</>
                : inPerson ? `${sender.name} will get the completed document by email once everyone has finished. You can download it as it stands now.` : <>Others still need to finish. We will email the completed document to {myEmail} as soon as they have.</>}
            </p>
            <div className="row wrap sg-actions">
              <a className="btn primary lg" href={`${downloadUrl}?inline=1`} target="_blank" rel="noreferrer"><Icon name="eye" /> {allDone ? 'View completed document' : 'View document so far'}<span className="sg-vh"> (opens in a new tab)</span></a>
              <a className="btn lg" href={downloadUrl}><Icon name="download" /> Download PDF</a>
            </div>
          </StateCard>
          <Impact impact={finished?.impact || env.impact} />
        </div>
        {dialogs}
      </Shell>
    );
  }

  if (stage === 'pending')
    return (
      <Shell data={data} footer={report}>
        {notice}
        <StateCard tone="wait" title="It is not your turn yet">
          <p>Others need to finish first. We will email {myEmail} as soon as the document is ready for you. There is nothing to do until then.</p>
          <Sender env={env} brand={data.brand} lead="Questions? Contact" />
        </StateCard>
        {dialogs}
      </Shell>
    );

  // ---- Other actions, shared by the consent screen and the document ---------------------------------

  const go = (o: Open) => () => setOpen(o);
  const declineLabel = me.role === 'approver' ? 'Decline to approve' : 'Decline to sign';
  const menu: MenuItem[] = [
    ...(stage === 'sign' && acts ? [{ key: 'later', label: 'Finish later', hint: 'Your answers are saved. Come back with the same link.', icon: 'clock', onClick: async () => { const ok = await flush(); setOpen(''); if (ok) toast('Saved. Use the link in your email to come back and finish.'); } }] : []),
    { key: 'ask', label: `Ask ${sender.name} a question`, hint: 'They reply by email. Asking signs nothing.', icon: 'mail', onClick: go('ask') },
    { key: 'download', label: 'Download the document', icon: 'download', href: downloadUrl, download: true },
    { key: 'print', label: 'View or print the document', hint: 'Opens in a new tab.', icon: 'eye', href: `${downloadUrl}?inline=1` },
    ...(stage === 'sign' && acts && (sig || ini) ? [{ key: 'sig', label: 'Change my signature', icon: 'pen', onClick: () => { setOpen(''); setAdopt({ kind: sig ? 'signature' : 'initials' }); } }] : []),
    ...(env.expires_at ? [{ key: 'time', label: `Ask ${sender.name} for more time`, hint: moreTime === 'asked' ? 'Asked. They will be in touch by email.' : `The deadline is ${fmtDate(env.expires_at)}.`, icon: 'clock', onClick: async () => { if (moreTime !== 'asked' && (await askForTime())) toast(`We asked ${sender.name} for more time. They will be in touch by email.`); } }] : []),
    ...(me.role === 'signer' || me.role === 'approver' ? [{ key: 'reassign', label: 'Assign to someone else', hint: 'If you are not the right person to sign.', icon: 'link', onClick: go('reassign') }] : []),
    ...(!muted && me.role !== 'inperson' ? [{ key: 'mute', label: 'Stop reminder emails', hint: 'For this document only.', icon: 'stop', onClick: () => { setOpen(''); mute(); } }] : []),
    ...(me.role !== 'viewer' && me.role !== 'cc' ? [{ key: 'decline', label: declineLabel, hint: 'Closes the document for everyone.', icon: 'stop', danger: true, onClick: go('decline') }] : []),
  ];
  const other = <button type="button" className="btn sm sg-other" aria-haspopup="dialog" onClick={go('menu')}>Other actions</button>;
  const menuDialog = open === 'menu' && <MenuDialog items={menu} onClose={() => setOpen('')} />;

  if (stage === 'consent') {
    const ask = me.role === 'approver' ? 'You have been asked to approve' : me.role === 'viewer' ? 'You have been asked to read' : 'You have been asked to sign';
    return (
      <Shell data={data} bar={other} footer={report} helpInNewTab>
        {notice}
        <div className="card sg-consent">
          <p className="sg-kicker">{ask}</p>
          <h1 className="serif" id="sg-h1" tabIndex={-1}>{env.subject}</h1>
          <Sender env={env} brand={data.brand} />
          <p className="muted small">This was sent to {me.name} ({myEmail}). Not expecting it? Do not sign. You can <button type="button" className="sg-link" onClick={go('report')}>report this request</button>.</p>
          {data.message && <div className="sg-quote"><span className="muted small">Message from {sender.name}</span>{data.message}</div>}
          {data.note && <div className="notice sg-gap"><b>Private note for you:</b> {data.note}</div>}
          {me.role === 'inperson' && <div className="notice warn sg-gap">In-person signing. Hand this device to <b>{me.name}</b> now.</div>}
          <div className="row wrap sg-actions">
            <a className="btn" href={downloadUrl}><Icon name="download" /> Download</a>
            <a className="btn" href={`${downloadUrl}?inline=1`} target="_blank" rel="noreferrer"><Icon name="eye" /> View or print<span className="sg-vh"> (opens in a new tab)</span></a>
          </div>
          <hr className="sg-rule" />
          <h2>Electronic records and signatures</h2>
          <p className="muted sg-legal">
            You are about to review{acts ? ' and sign' : ''} this document on screen. An electronic signature has the same legal effect as a handwritten one.
            You can download or print a copy at any time, decline, or ask {sender.name} for a paper copy instead. We record the time, your IP address and each step you take in a tamper-evident audit trail.
          </p>
          <label className="check sg-agree">
            <input type="checkbox" checked={agree} onChange={(e) => (setAgree(e.target.checked), setFormError(''))} aria-describedby={formError ? 'sg-agree-err' : undefined} /> <span>I agree to use electronic records and signatures.</span>
          </label>
          {formError && <div id="sg-agree-err" className="notice err sg-problem" role="alert">{formError}</div>}
          <button type="button" className="btn primary lg sg-continue" disabled={busy} onClick={async () => {
            if (!agree) return setFormError('Tick the box above to agree, then choose Continue.');
            setBusy(true);
            try {
              await api(`${base}/consent`, { method: 'POST' });
              await load();
            } catch (e: any) {
              setFormError(`${e?.message || 'Something went wrong on our side.'} Try again in a moment.`);
            } finally {
              setBusy(false);
            }
          }}>Continue</button>
        </div>
        {menuDialog}
        {dialogs}
      </Shell>
    );
  }

  // ---- The document -----------------------------------------------------------------------------------

  const finishLabel = me.role === 'approver' ? 'Approve' : me.role === 'viewer' ? 'Mark as viewed' : 'Finish';
  const hasNext = acts && left.length > 0;
  const count = !acts ? '' : !required.length ? 'Nothing is required' : left.length ? `${left.length} of ${required.length} left` : 'Ready to finish';
  const mainButton = (big: boolean) => hasNext
    ? <button type="button" className={`btn go${big ? ' sg-big' : ''}`} onClick={() => goTo(nextField)}>Next</button>
    : <button type="button" className={`btn go finish${big ? ' sg-big' : ''}`} disabled={busy} onClick={pressFinish}>{finishLabel}</button>;
  const done = required.length - left.length;
  const bar = (
    <>
      {acts && (
        <div className="sg-count sg-wide">
          {required.length > 0 && <div className="progress" aria-hidden="true"><i style={{ width: `${(done / required.length) * 100}%` }} /></div>}
          <div><b>{count}</b><span aria-hidden="true"> · {SAVE_TEXT[save]}</span></div>
        </div>
      )}
      {other}
      <span className="sg-wide">{mainButton(false)}</span>
    </>
  );
  const bottom = (
    <>
      {acts && <div className="sg-bottom-info"><b>{count}</b><span aria-hidden="true">{SAVE_TEXT[save]}</span></div>}
      {mainButton(true)}
    </>
  );
  const live = save === 'saved' ? 'Saved' : save === 'error' ? 'Not saved yet. We will keep trying.' : '';

  const docField = (f: any) => {
    const ok = filled(f);
    const auto = AUTO.includes(f.type) || f.readonly;
    const value = values[f.id] || '';
    const wrong = !auto && !!problemWith(f, value);
    const cls = `field fill sg-f${auto || ok ? ' done' : ''}${f.id === nextField?.id ? ' next' : ''}${isBox(f) ? ' box' : ''}${wrong ? ' bad' : ''}${auto ? ' sg-auto' : ''}`;
    const common = { id: `f-${f.id}`, className: cls, style: pos(f) };
    const name = fieldName(f);
    const need = f.required ? ', required' : ', optional';

    if (f.type === 'signature' || f.type === 'initials') {
      const word = f.type === 'signature' ? 'signature' : 'initials';
      return (
        <button key={f.id} type="button" {...common} onClick={() => clickSig(f)} aria-label={ok ? `Your ${word}. Change or clear it` : `${name}${need}. ${FLAG[f.type]}`}>
          {ok ? <img src={(f.type === 'signature' ? sig : ini) || ''} alt="" /> : <span className="cta"><Icon name="pen" size={14} /> {f.type === 'signature' ? 'Sign' : 'Initial'}</span>}
        </button>
      );
    }
    if (AUTO.includes(f.type)) return <div key={f.id} {...common} title="Added for you"><span className="sg-val">{f.type === 'full_name' ? me.name : f.type === 'email' ? me.email : dateText}</span></div>;
    if (f.readonly) return <div key={f.id} {...common}><span className="sg-val">{isBox(f) ? (f.value === '1' ? '✓' : '') : f.value}</span></div>;
    if (f.type === 'checkbox') {
      const flip = () => set(f.id, value ? '' : '1');
      return <div key={f.id} {...common} role="checkbox" aria-checked={!!value} aria-label={`${name}${need}`} tabIndex={0} onClick={flip} onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), flip())}>{value && <Icon name="check" />}</div>;
    }
    if (f.type === 'radio')
      return (
        <div key={f.id} {...common} style={{ ...pos(f), borderRadius: '50%' }} role="radio" aria-checked={!!value} aria-label={`${f.label || 'Option'}${f.group_name ? `, ${f.group_name}` : ''}`} tabIndex={0}
          onClick={() => pickRadio(f)} onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), pickRadio(f))}>{value && <span className="sg-dot" />}</div>
      );
    if (f.type === 'attachment')
      return (
        <label key={f.id} {...common}>
          <input type="file" className="sg-vh" aria-label={`${name}${need}. ${value ? 'A file is attached. Choose another to replace it' : 'Choose a PDF, PNG or JPEG'}`} accept="application/pdf,image/png,image/jpeg" onChange={(e) => (attach(f, e.target.files?.[0]), (e.target.value = ''))} />
          <span className="cta"><Icon name={value ? 'check' : 'clip'} size={14} /> {uploading === f.id ? 'Uploading' : value ? 'Attached' : name}</span>
        </label>
      );
    if (usesSheet(f))
      return (
        <button key={f.id} type="button" {...common} onClick={() => goTo(f)} aria-label={`${name}${need}. ${value ? `Your answer: ${value}` : 'Empty'}. Opens a box to type in`}>
          <span className={`sg-val${value ? '' : ' ph'}`}>{value || name + (f.required ? ' *' : '')}</span>
        </button>
      );
    if (f.type === 'dropdown')
      return (
        <div key={f.id} {...common}>
          <select aria-label={name} aria-required={!!f.required} value={value} onChange={(e) => set(f.id, e.target.value)}>
            <option value="">{name}</option>
            {(f.options || []).map((o: string) => <option key={o}>{o}</option>)}
          </select>
        </div>
      );
    const shared = { 'aria-label': name, 'aria-required': !!f.required, 'aria-invalid': wrong, placeholder: name + (f.required ? ' *' : ''), value, title: wrong ? problemWith(f, value) : undefined };
    return (
      <div key={f.id} {...common}>
        {isMulti(f)
          ? <textarea {...shared} onChange={(e) => set(f.id, e.target.value)} />
          : <input {...shared} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} onChange={(e) => set(f.id, e.target.value)} />}
      </div>
    );
  };

  // The pointer sits above the field unless that would cover the top of the page or something another person filled in.
  const flagBelow = !!nextField && (nextField.y < 0.07 || [...data.others, ...fields].some((g: any) =>
    g.id !== nextField.id && g.document_id === nextField.document_id && g.page === nextField.page
    && g.y + g.h > nextField.y - 0.07 && g.y < nextField.y && g.x < nextField.x + 0.3 && g.x + g.w > nextField.x));

  const overlay = (docId: string) => (page: number) => (
    <>
      {data.others.filter((f: any) => f.document_id === docId && f.page === page).map((f: any) => (
        <div key={f.id} className={`field other${isBox(f) ? ' box' : ''}`} style={pos(f)}>
          {f.image ? <img src={f.image} alt="Signature of another signer" /> : isBox(f) ? (f.value === '1' ? '✓' : '') : f.value}
        </div>
      ))}
      {fields.filter((f) => f.document_id === docId && f.page === page).map(docField)}
      {nextField && nextField.document_id === docId && nextField.page === page && !sheet && (
        <span className={`sg-flag${flagBelow ? ' below' : ''}`} aria-hidden="true"
          style={{ left: `min(${nextField.x * 100}%, calc(100% - 8.5em))`, top: `${(nextField.y + (flagBelow ? nextField.h : 0)) * 100}%` }}>
          {FLAG[nextField.type] || 'Fill in here'}
        </span>
      )}
    </>
  );

  const ctx: FieldCtx = { me, values, sig, ini, dateText, ordered, uploading, filled, set, pickRadio, clickSig, attach };
  const signed = byId(signedField);
  const sheetField = byId(sheet);
  const sheetTarget = sheetField && nextAfter(sheetField.id);

  return (
    <Shell data={data} bar={bar} bottom={bottom} footer={report} titleIsHeading live={live} helpInNewTab>
      {notice}
      {me.role === 'inperson' && <div className="notice warn sg-top">In-person signing for <b>{me.name}</b>. Hand them the device now.</div>}
      <p className="sg-guide" id="sg-guide">
        {!acts ? (me.role === 'approver' ? 'Read the document, then choose Approve. To say no, choose Decline to approve from Other actions.' : 'Read the document, then choose Mark as viewed.')
          : hasNext ? <>Choose <b>Next</b> and we take you to each place that needs you, one at a time.</>
          : <>Everything needed is filled in. Choose <b>Finish</b> to check it and send.</>}
      </p>
      <div className="sg-tools">
        <div className="sg-seg" role="group" aria-label="How to read the document">
          <button type="button" aria-pressed={view === 'doc'} onClick={() => chooseView('doc')}>Document</button>
          <button type="button" aria-pressed={view === 'text'} onClick={() => chooseView('text')}>Text view</button>
        </div>
        <a className="btn" href={downloadUrl}><Icon name="download" /> Download</a>
      </div>

      {view === 'doc' ? (
        <div className="stack sg-doc">
          {data.documents.map((d: any) => (
            <div key={d.id}>
              {data.documents.length > 1 && <h2 className="sg-docname">{d.name}</h2>}
              <PdfDoc url={`/api${base}/doc/${d.id}`} overlay={overlay(d.id)} />
            </div>
          ))}
        </div>
      ) : (
        <TextView documents={data.documents} urlFor={(id) => `/api${base}/doc/${id}`} senderName={sender.name} onAsk={go('ask')}
          fields={(docId, page, near) => <PageFields docId={docId} page={page} c={ctx} near={near} />}
          others={(docId, page) => <PageOthers others={data.others.filter((f: any) => f.document_id === docId && f.page === page)} />} />
      )}
      <p className="muted small center sg-envelope">Envelope {env.id}{env.expires_at ? ` · open until ${fmtDate(env.expires_at)}` : ''} · Signing on screen saves about {fmtNum(env.impact.sheets)} sheets of paper.</p>

      {sheetField && (
        <FieldSheet field={sheetField} value={values[sheetField.id] || ''} onChange={(v) => set(sheetField.id, v)} onDone={() => setSheet(null)} onNext={sheetTarget ? () => sheetNext(sheetField.id) : undefined} />
      )}
      {signed && (
        <SignedFieldDialog kind={signed.type} image={(signed.type === 'signature' ? sig : ini) || ''} onClose={() => setSignedField(null)}
          onClear={() => { set(signed.id, ''); setSignedField(null); }}
          onChange={() => { setSignedField(null); setAdopt({ kind: signed.type }); }} />
      )}
      {menuDialog}
      {dialogs}
      {open === 'review' && (
        <ReviewDialog me={me} sender={sender} items={items} sig={sig} ini={ini} approving={me.role === 'approver'} busy={busy} error={finishError}
          usesSig={fields.some((f) => f.type === 'signature' && filled(f))} usesIni={fields.some((f) => f.type === 'initials' && filled(f))}
          onChangeSig={(kind) => setAdopt({ kind })} onBack={() => setOpen('')} onFinish={complete}
          onRename={async (name) => {
            await api(`${base}/name`, { body: { name } });
            setData((d: any) => (d ? { ...d, recipient: { ...d.recipient, name } } : d));
          }} />
      )}
      {adopt && (
        <AdoptSignature kind={adopt.kind} name={me.name} onClose={() => setAdopt(null)}
          onDone={(png) => {
            if (adopt.kind === 'signature') setSig(png);
            else setIni(png);
            if (adopt.field) set(adopt.field, '1');
            setAdopt(null);
          }} />
      )}
    </Shell>
  );
}
