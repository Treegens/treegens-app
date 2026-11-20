'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, COLORS, Modal, newId, toast } from './ui';
import { useHistory } from './editor/history';
import { finished, fingerprint, freshValues, outcomes, rebase, restoreLocked } from './editor/changes';
import { precheck, uploadFile } from './editor/upload';
import { StepAdd } from './editor/StepAdd';
import { StepFields } from './editor/StepFields';
import { StepReview } from './editor/StepReview';
import { MAX_DOCS, SIGNS, clamp, plural, who, type Confirm, type Ed, type Upload } from './editor/shared';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (v: any) => typeof v === 'string' && v.length < 255 && EMAIL.test(v.trim());
const listNames = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
// api() turns a dropped connection into "Failed to fetch". Say something a person can act on instead.
const friendly = (e: any) => (e?.status ? e.message : 'We could not reach the server. Check your connection and try again.');

export function Editor({ id }: { id: string }) {
  const router = useRouter();
  const [env, setEnv] = useState<any>(null);
  const [base, setBase] = useState<any>(null); // the envelope as the server last gave it to us
  const [docs, setDocs] = useState<any[]>([]);
  const [rcps, setRcps] = useState<any[]>([]);
  const fields = useHistory<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [step, setStep] = useState(1);
  const [state, setState] = useState<'saved' | 'dirty' | 'saving' | 'stuck'>('saved');
  const [stuck, setStuck] = useState<{ message: string; retry: boolean; tries: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<string[]>([]);
  const [closed, setClosed] = useState('');
  const [ask, setAsk] = useState<Confirm | null>(null);
  const latest = useRef<any>(null);
  const live = useRef<{ docs: any[]; rcps: any[] }>({ docs: [], rcps: [] });
  const serverCopy = useRef<any>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const leaving = useRef(false);
  const opener = useRef<HTMLElement | null>(null);

  const isTpl = env?.kind === 'template';
  // An envelope that is already out for signature is corrected in place: no autosave, one explicit save.
  const correcting = !!env && env.kind === 'envelope' && env.status === 'sent';

  useEffect(() => {
    let on = true;
    api(`/envelopes/${id}`).then(({ envelope: e }) => {
      if (!on) return;
      if (e.status !== 'draft' && !(e.kind === 'envelope' && e.status === 'sent')) {
        toast(`This envelope is ${e.status}, so it can no longer be edited. Clone it to send a new version.`);
        return router.replace(`/app/envelopes/${id}`);
      }
      setEnv(e);
      setBase(e);
      setDocs(e.documents);
      setRcps(e.recipients);
      fields.reset(e.fields);
    }).catch((e) => {
      if (!on) return;
      toast(e?.status === 404 ? 'We could not find that envelope. It may have been deleted.' : friendly(e), true);
      router.replace('/app/envelopes');
    });
    api('/contacts').then((d) => on && setContacts(d.contacts)).catch(() => {});
    return () => {
      on = false;
    };
  }, [id, router, fields.reset]);

  // ---- What gets sent to the server --------------------------------------------------------------------------

  const body = (list: any[] = rcps, flds: any[] = fields.value) => ({
    subject: env.subject, message: env.message, ordered: env.ordered, reminder_days: env.reminder_days, expire_days: env.expire_days,
    ...(env.date_format ? { date_format: env.date_format } : {}),
    documents: docs.map((d) => ({ id: d.id, file_id: d.file_id, name: d.name })),
    // A draft is saved while people are still typing. A half-typed email would make the server turn the whole
    // save down, so it is left out until it is complete and everything else is kept safe meanwhile.
    recipients: list.map((r) => ({ id: r.id, role: r.role, role_name: r.role_name, name: r.name, email: correcting || !r.email || validEmail(r.email) ? r.email : '', routing_order: r.routing_order, access_code: r.access_code, note: r.note })),
    fields: flds,
  });
  latest.current = env && body();
  live.current = { docs, rcps };

  const dirty = useCallback(() => setState('dirty'), []);
  const save = useCallback(async () => {
    if (!latest.current) return;
    setState('saving');
    try {
      await api(`/envelopes/${id}`, { method: 'PUT', body: latest.current });
      setStuck(null);
      setState((s) => (s === 'saving' ? 'saved' : s));
    } catch (e: any) {
      // Connection trouble and server hiccups are retried quietly. Anything else waits for the next change.
      setStuck((p) => ({ message: friendly(e), retry: !e?.status || e.status >= 500, tries: (p?.tries || 0) + 1 }));
      setState((s) => (s === 'saving' ? 'stuck' : s));
      throw e;
    }
  }, [id]);
  useEffect(() => {
    if (!env || correcting) return;
    if (state === 'dirty') {
      const t = setTimeout(() => save().catch(() => {}), 1200);
      return () => clearTimeout(t);
    }
    if (state === 'stuck' && stuck?.retry) {
      const t = setTimeout(() => save().catch(() => {}), Math.min(30000, 2000 * 2 ** stuck.tries));
      return () => clearTimeout(t);
    }
  }, [state, stuck, env, docs, rcps, fields.value, save, correcting]);

  // ---- Locks: what finished people signed can no longer change -------------------------------------------------

  const lockedIds = useMemo(() => new Set<string>(correcting && base ? finished(base.recipients).map((r: any) => r.id) : []), [correcting, base]);
  const anyLocked = lockedIds.size > 0;
  const lockedNames = listNames(rcps.filter((r) => lockedIds.has(r.id)).map(who));
  const isLockedField = useCallback((f: any) => anyLocked && (!f.recipient_id || lockedIds.has(f.recipient_id)), [anyLocked, lockedIds]);

  // ---- Changes -------------------------------------------------------------------------------------------------

  // Confirmations remember what had focus, and hand it back when they close.
  const confirm = (c: Confirm) => {
    opener.current = document.activeElement as HTMLElement | null;
    setAsk(c);
  };
  const closeAsk = () => {
    setAsk(null);
    const el = opener.current;
    setTimeout(() => el?.isConnected && el.focus(), 0);
  };
  const patchEnv = (p: any) => (setEnv((e: any) => ({ ...e, ...p })), dirty());
  const color = (rid: string | null) => (rid ? COLORS[Math.max(0, rcps.findIndex((r) => r.id === rid)) % COLORS.length] : '#6b7280');
  const setFields: Ed['setFields'] = (next, options) => (fields.set(next, options), dirty());
  // After an undo, a remembered step may mention a document or person that has since been removed. Drop those.
  const tidy = () => fields.set((l) => {
    const ok = l.filter((f) => live.current.docs.some((d) => d.id === f.document_id) && (!f.recipient_id || live.current.rcps.some((r) => r.id === f.recipient_id)));
    return ok.length === l.length ? l : ok;
  }, { record: false });
  const undo = () => (fields.undo(), tidy(), dirty());
  const redo = () => (fields.redo(), tidy(), dirty());

  function addFiles(list: FileList | File[] | null) {
    if (!list?.length) return;
    let room = MAX_DOCS - live.current.docs.length - uploads.filter((u) => u.state !== 'error').length;
    for (const file of Array.from(list)) {
      const key = newId('up');
      const problem = precheck(file) || (room <= 0 ? `An envelope can hold up to ${MAX_DOCS} documents. Remove one to add this file.` : '');
      if (problem) {
        setUploads((u) => [...u, { key, name: file.name, size: file.size, progress: 0, state: 'error', error: problem }]);
        continue;
      }
      room--;
      setUploads((u) => [...u, { key, name: file.name, size: file.size, progress: 0, state: 'waiting' }]);
      const patch = (p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
      // One at a time, in the order they were chosen, so the documents end up in that order too.
      queue.current = queue.current.then(async () => {
        patch({ state: 'uploading' });
        try {
          const f = await uploadFile(file, (n) => patch(n >= 1 ? { progress: 1, state: 'checking' } : { progress: n }));
          setUploads((u) => u.filter((x) => x.key !== key));
          setDocs((d) => [...d, { id: newId('doc'), file_id: f.id, name: f.name, pages: f.pages, page_sizes: f.page_sizes, is_scan: f.is_scan }]);
          setEnv((e: any) => (e.subject ? e : { ...e, subject: e.kind === 'template' ? f.name : `Please sign: ${f.name}` }));
          dirty();
        } catch (e: any) {
          patch({ state: 'error', error: e?.message || 'The upload did not go through. Please try again in a moment.' });
        }
      });
    }
  }
  const renameDoc = (did: string, name: string) => (setDocs((l) => l.map((x) => (x.id === did ? { ...x, name } : x))), dirty());
  const moveDoc = (i: number, by: number) => (setDocs((d) => {
    const n = [...d];
    const [x] = n.splice(i, 1);
    n.splice(clamp(i + by, 0, n.length), 0, x);
    return n;
  }), dirty());
  // Swap in a corrected file. The document keeps its place and its fields; a field on a page that no longer exists
  // moves to the last page so nothing disappears quietly.
  async function replaceDoc(did: string, file: File | null | undefined) {
    if (!file) return;
    const problem = precheck(file);
    if (problem) return toast(problem, true);
    try {
      toast('Uploading the new file…');
      const f = await uploadFile(file, () => {});
      setDocs((l) => l.map((x) => (x.id === did ? { ...x, file_id: f.id, pages: f.pages, page_sizes: f.page_sizes, is_scan: f.is_scan } : x)));
      fields.set((l) => l.map((x) => (x.document_id === did && x.page >= f.pages ? { ...x, page: f.pages - 1 } : x)), { record: false });
      dirty();
      toast('File replaced. Your fields are where you left them. Check they still line up.');
    } catch (e: any) {
      toast(e?.message || 'The upload did not go through. Please try again in a moment.', true);
    }
  }
  function removeDoc(did: string) {
    const d = docs.find((x) => x.id === did);
    const n = fields.current().filter((f) => f.document_id === did).length;
    const go = () => (setDocs((l) => l.filter((x) => x.id !== did)), fields.set((l) => l.filter((f) => f.document_id !== did), { record: false }), dirty());
    if (n) confirm({ title: 'Remove this document?', body: `${d?.name || 'This document'} has ${plural(n, 'field')} on it. They are removed together with it.`, yes: 'Remove document', no: 'Keep it', danger: true, onYes: go });
    else go();
  }

  function addRcp(p: any = {}) {
    const r = { id: newId('rcp'), role: 'signer', role_name: isTpl ? `Signer ${rcps.length + 1}` : '', name: '', email: '', routing_order: rcps.length ? Math.max(...rcps.map((x) => x.routing_order)) + 1 : 1, access_code: '', note: '', ...p };
    setRcps((l) => [...l, r]);
    dirty();
  }
  const dropFieldsOf = (rid: string) => fields.set((l) => l.filter((f) => f.recipient_id !== rid), { record: false });
  function patchRcp(rid: string, p: any) {
    const apply = () => (setRcps((l) => l.map((r) => (r.id === rid ? { ...r, ...p } : r))), dirty());
    const r = rcps.find((x) => x.id === rid);
    const n = fields.current().filter((f) => f.recipient_id === rid).length;
    // People who approve, view or get a copy cannot fill in fields, so their fields would be left empty for good.
    if (r && p.role && !SIGNS(p) && n)
      return confirm({ title: `Change what ${who(r)} does?`, body: `${who(r)} has ${plural(n, 'field')} to fill in. Only people who sign can have fields, so ${n === 1 ? 'that field is' : 'those fields are'} removed if you change this.`, yes: 'Change and remove fields', no: 'Keep as it is', onYes: () => (apply(), dropFieldsOf(rid)) });
    apply();
  }
  function removeRcp(rid: string) {
    const r = rcps.find((x) => x.id === rid);
    const n = fields.current().filter((f) => f.recipient_id === rid).length;
    const go = () => (setRcps((l) => l.filter((x) => x.id !== rid)), dropFieldsOf(rid), dirty());
    if (n) confirm({ title: `Remove ${who(r)}?`, body: `${who(r)} has ${plural(n, 'field')}. ${n === 1 ? 'It is' : 'They are'} removed too.`, yes: `Remove ${isTpl ? 'role' : 'recipient'}`, no: 'Keep them', danger: true, onYes: go });
    else go();
  }

  // ---- Review ----------------------------------------------------------------------------------------------------

  const pages = docs.reduce((n, d) => n + d.pages, 0);
  const problems = useMemo(() => {
    const p: string[] = [];
    if (!docs.length) p.push('Add at least one document.');
    if (!rcps.length) p.push('Add at least one recipient.');
    for (const r of rcps) {
      const name = r.name || r.role_name || 'A recipient';
      if (!isTpl && (!r.name.trim() || !validEmail(r.email))) p.push(`${name} needs a name and a valid email.`);
      if (isTpl && !r.role_name?.trim() && !r.email) p.push('Give every open recipient a role name, such as "Client".');
      if (isTpl && r.email && !validEmail(r.email)) p.push(`${name} needs a valid email, or leave it empty to fill in later.`);
      if (SIGNS(r) && !fields.value.some((f) => f.recipient_id === r.id)) p.push(`${name} has no fields to sign yet.`);
    }
    if (!isTpl && rcps.length > 0 && !rcps.some((r) => r.role !== 'cc')) p.push('Add at least one recipient who signs, approves or views.');
    return [...new Set(p)];
  }, [docs, rcps, fields.value, isTpl]);

  const mine = { ordered: env?.ordered, documents: docs, recipients: rcps, fields: fields.value };
  const changed = useMemo(() => !!base && correcting && fingerprint(env, mine) !== fingerprint(base, base), [base, correcting, env, docs, rcps, fields.value]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => (correcting && step === 3 ? outcomes(base, mine) : null), [correcting, step, base, env, docs, rcps, fields.value]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the page with work that is not on the server yet: let the browser ask first.
  const unsaved = correcting ? changed : state !== 'saved';
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  const leave = (to: string) => {
    leaving.current = true;
    router.push(to);
  };
  const home = correcting ? `/app/envelopes/${id}` : isTpl ? '/app/templates' : '/app/envelopes';

  async function go(n: number) {
    if (n > 1 && !docs.length) return toast(uploads.some((u) => u.state !== 'error') ? 'Your document is still uploading. Give it a moment.' : 'Upload a document first.', true);
    setError('');
    if (correcting) return setStep(n);
    try {
      await save();
      setStep(n);
    } catch (e) {
      toast(friendly(e), true);
    }
  }

  async function closeDraft() {
    if (uploads.some((u) => u.state !== 'error')) return toast('A file is still uploading. Wait for it to finish, then close.', true);
    try {
      if (state !== 'saved') await save();
      leave(home);
    } catch (e) {
      confirm({ title: 'Your latest changes are not saved', body: `${friendly(e)} If you leave now, what you changed since the last save is lost.`, yes: 'Leave anyway', no: 'Keep editing', danger: true, onYes: () => leave(home) });
    }
  }

  function discard() {
    if (!changed) return leave(home);
    confirm({ title: 'Leave without saving?', body: 'Your changes have not been saved. If you leave now, the envelope stays exactly as it was and nobody is told anything.', yes: 'Discard changes', no: 'Keep editing', danger: true, onYes: () => leave(home) });
  }

  async function send() {
    setBusy(true);
    setError('');
    try {
      try {
        await save();
      } catch {
        // The strip under the top bar says what went wrong and keeps trying. Here, say what it means.
        return setError(isTpl ? 'Try again in a moment.' : 'Your latest changes could not be saved, so nothing was sent. Try again in a moment.');
      }
      if (isTpl) {
        toast('Template saved');
        return leave('/app/templates');
      }
      await api(`/envelopes/${id}/send`, { method: 'POST' });
      toast('Sent. No paper involved.');
      leave(`/app/envelopes/${id}?sent=1`);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  // Looks at the envelope as it is on the server right now and folds in whatever signers did while this editor was
  // open, so saving never wipes out a signer's progress and never trips over someone who has just finished.
  async function catchUp(): Promise<{ recipients: any[]; fields: any[]; ok: boolean }> {
    const now = (await api(`/envelopes/${id}`)).envelope;
    const none = { recipients: rcps, fields: fields.current(), ok: false };
    if (now.status !== 'sent') {
      setClosed(now.status);
      return none;
    }
    const merged = rebase(base, now, { ordered: env.ordered, documents: docs, recipients: rcps, fields: fields.current() });
    serverCopy.current = now;
    setRcps(merged.recipients);
    fields.mapAll((l) => freshValues(base, now, l));
    setBase(now);
    setEnv((e: any) => ({ ...e, expires_at: now.expires_at }));
    setConflict(merged.conflict);
    return { recipients: merged.recipients, fields: merged.fields, ok: !merged.conflict.length };
  }

  async function saveCorrection() {
    setBusy(true);
    setError('');
    try {
      const cur = await catchUp();
      if (!cur.ok) return;
      await api(`/envelopes/${id}`, { method: 'PUT', body: { ...body(cur.recipients, cur.fields), expire_days: undefined } });
      toast('Changes saved. Nobody had to start again.');
      leave(`/app/envelopes/${id}`);
    } catch (e: any) {
      setError(friendly(e));
      // The server turned it down because someone finished in the last moment. Find out who, so it can be put right.
      if (e?.status === 409) await catchUp().then((c) => !c.ok && setError('')).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  function restore() {
    if (!serverCopy.current) return;
    const next = restoreLocked(serverCopy.current, { ordered: env.ordered, documents: docs, recipients: rcps, fields: fields.current() });
    setDocs(next.documents);
    setRcps(next.recipients);
    fields.reset(next.fields);
    setConflict([]);
    setError('');
    toast('Their part is back as they signed it.');
  }

  if (!env) return <div className="muted center" style={{ padding: 80 }} role="status">Loading…</div>;

  const ed: Ed = {
    env, base, isTpl, correcting, lockedIds, lockedNames, anyLocked, isLockedField, docs, rcps, fields, contacts, uploads, color,
    patchEnv, addFiles, dismissUpload: (key) => setUploads((u) => u.filter((x) => x.key !== key)), renameDoc, removeDoc, replaceDoc, moveDoc, addRcp, patchRcp, removeRcp,
    setFields, undo, redo, modalOpen: !!ask, go,
  };
  const submit = correcting ? saveCorrection : send;
  const submitOff = busy || problems.length > 0 || !!closed || conflict.length > 0 || (correcting && !changed);
  const steps = ['Add', 'Place fields', isTpl ? 'Review' : correcting ? 'Review and save' : 'Review and send'];
  const status = correcting ? (changed ? 'Changes not saved yet' : 'No changes yet')
    : state === 'saved' ? 'All changes saved' : state === 'saving' ? 'Saving…' : state === 'stuck' ? 'Not saved yet' : 'Unsaved changes';

  return (
    <div className={`ed${step === 2 ? ' ed-step2' : ''}`}>
      <div className="topbar ed-top">
        {correcting
          ? <button type="button" className="btn sm ghost" onClick={discard}>Discard<span className="hide-sm">changes</span></button>
          : <button type="button" className="btn sm ghost" onClick={closeDraft} aria-label="Save and close"><span aria-hidden="true">←</span><span className="hide-sm">Save and close</span></button>}
        <nav className="steps grow" aria-label="Steps">
          {steps.map((s, i) => (
            <button key={s} type="button" className={step === i + 1 ? 'on' : ''} aria-current={step === i + 1 ? 'step' : undefined} aria-label={`Step ${i + 1}: ${s}`} onClick={() => go(i + 1)}><span className="n">{i + 1}</span><span className={step === i + 1 ? '' : 'hide-sm'}>{s}</span></button>
          ))}
        </nav>
        <span className="muted small hide-sm" role="status">{status}</span>
        {step < 3 ? <button type="button" className="btn primary" onClick={() => go(step + 1)}>Next</button>
          : <button type="button" className="btn primary hide-sm" disabled={submitOff} onClick={submit}>{isTpl ? 'Save template' : correcting ? 'Save changes' : 'Send'}</button>}
      </div>

      {correcting && (
        <div className="ed-banner" role="note">
          <b>This envelope is already out.</b> Change what you need to. Nobody has to start again, and nothing changes until you save.
          {anyLocked && <> {lockedNames} already finished, so the documents and their part are locked.</>}
        </div>
      )}
      {!correcting && state === 'stuck' && stuck && (
        <div className="ed-banner err" role="alert">
          <b>Your latest changes are not saved yet.</b> {stuck.message}{stuck.retry ? ' We will keep trying while you work.' : ''}
          <button type="button" className="btn sm" style={{ marginLeft: 10 }} onClick={() => save().catch(() => {})}>Try now</button>
        </div>
      )}

      {step === 1 && <StepAdd ed={ed} />}
      {step === 2 && <StepFields ed={ed} />}
      {step === 3 && <StepReview ed={ed} problems={problems} busy={busy} changed={changed} error={error} conflict={conflict} closed={closed} result={result} onSubmit={submit} onRestore={restore} onDiscard={discard} />}

      {ask && (
        <Modal title={ask.title} onClose={closeAsk}>
          <p className="muted">{ask.body}</p>
          <div className="actions">
            <button type="button" className="btn" autoFocus onClick={closeAsk}>{ask.no || 'Cancel'}</button>
            <button type="button" className={`btn primary${ask.danger ? ' ed-danger' : ''}`} onClick={() => {
              const yes = ask.onYes;
              closeAsk();
              yes();
            }}>{ask.yes}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
