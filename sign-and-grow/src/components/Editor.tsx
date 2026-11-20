'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, COLORS, Modal, fmtDate, newId, toast } from './ui';
import { useHistory } from './editor/history';
import { useMe } from './AppShell';
import { checkTrouble } from './sender/CheckFields';
import { sendMyselfTrouble } from './editor/SendMyself';
import { finished, fingerprint, freshValues, outcomes, rebase, restoreLocked, signsAgain } from './editor/changes';
import { precheck, uploadFile, fmtSize, MAX_BYTES } from './editor/upload';
import { isPicture, shrinkPhoto } from './editor/photos';
import { PhotoAsk } from './editor/PhotoAsk';
import { StepAdd } from './editor/StepAdd';
import { StepFields } from './editor/StepFields';
import { StepReview } from './editor/StepReview';
import { MAX_DOCS, SIGNS, clamp, plural, who, type Confirm, type Ed, type Upload } from './editor/shared';
import { sendAnywayAsk } from '@/lib/mailnews';
import { stackedFields } from '@/lib/stacked';
import { WordingBanner, type WordingLock } from './templates/WhoCanUse';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (v: any) => typeof v === 'string' && v.length < 255 && EMAIL.test(v.trim());
const listNames = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
// api() turns a dropped connection into "Failed to fetch". Say something a person can act on instead.
const friendly = (e: any) => (e?.status ? e.message : 'We could not reach the server. Check your connection and try again.');

export function Editor({ id }: { id: string }) {
  const router = useRouter();
  const me = useMe();
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
  // The files a sender chose, while they are asked whether the pictures among them are one document.
  const [photoAsk, setPhotoAsk] = useState<File[] | null>(null);
  // A field the review step wants shown in step 2 (a field without a label, see LabelCheck).
  const [jump, setJump] = useState<string | null>(null);
  // Set when someone else saved this envelope after it was opened here, so saving now would wipe their work.
  // `how` says what the newer version was when it was not a save from an editor: a quick correction of one person, a
  // signer passing the document on or fixing their name, or sending ("passed this document on to Mary Deputy").
  const [stale, setStale] = useState<{ by: string; at: string; how?: string } | null>(null);
  // The edit_version this editor's copy is based on. It goes with every save, and the server refuses a save that
  // comes from an older copy than the one it holds.
  const loaded = useRef<number | null>(null);
  const saving = useRef<Promise<any>>(Promise.resolve());
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
      // A template can be changed by the person it belongs to, by admins and by whoever its rule lets change it (the
      // server says which in access.may_change and refuses everyone else). A member who opens a template they may
      // not change is not shown an editor whose every save fails: they are taken to the template's page, which
      // offers to use it or to make a copy of their own.
      if (e.kind === 'template' && (e.access ? e.access.may_change === false : me.role === 'member' && e.sender_id !== me.user.id)) {
        // A copy of a locked template is locked too (tplroles.ts), so a copy is not offered as a way to change it.
        toast(e.access?.locked ? `This template belongs to ${e.access.owner}, and its wording is locked. You can use it as it is. To change it, ask ${e.access.owner} or an admin of your team.`
          : 'This template belongs to a colleague, so only they or an admin of your team can change it. You can use it as it is, or make your own copy and change that.');
        return router.replace(`/app/envelopes/${id}`);
      }
      loaded.current = e.edit_version ?? null;
      leaving.current = false;
      setStale(null);
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
    recipients: list.map((r) => ({ id: r.id, role: r.role, role_name: r.role_name, name: r.name, email: correcting || !r.email || validEmail(r.email) ? r.email : '', routing_order: r.routing_order, access_code: r.access_code, note: r.note,
      // The check before the document opens, and the signing link by text message (see sender/CheckFields.tsx).
      verify: r.verify || 'none', phone: r.phone || '', text_link: !!r.text_link,
      // "I will send the link myself": a name and no address, for envelopes only (editor/SendMyself.tsx).
      link_by_sender: !isTpl && !!r.link_by_sender })),
    fields: flds,
  });
  latest.current = env && body();
  live.current = { docs, rcps };

  const dirty = useCallback(() => setState('dirty'), []);
  const save = useCallback(() => {
    // One save at a time, each sent with the version the one before it came back with. Two at once would look to
    // the server like two editors, and the second would be turned down as out of date.
    const one = async () => {
      if (!latest.current) return;
      setState('saving');
      try {
        const r = await api(`/envelopes/${id}`, { method: 'PUT', body: { ...latest.current, ...(loaded.current != null ? { edit_version: loaded.current } : {}) } });
        loaded.current = r.envelope?.edit_version ?? loaded.current;
        setStuck(null);
        setState((s) => (s === 'saving' ? 'saved' : s));
      } catch (e: any) {
        // Someone else saved since this copy was loaded. Nothing was written over their work: ask what to do.
        if (e?.code === 'stale') setStale({ by: e.data?.edited_by || 'Someone', at: e.data?.edited_at || '', how: e.data?.edited_how || '' });
        // Connection trouble and server hiccups are retried quietly. Anything else waits for the next change.
        setStuck((p) => ({ message: friendly(e), retry: !e?.status || e.status >= 500, tries: (p?.tries || 0) + 1 }));
        setState((s) => (s === 'saving' ? 'stuck' : s));
        throw e;
      }
    };
    const next = saving.current.catch(() => {}).then(one);
    saving.current = next;
    return next;
  }, [id]);
  useEffect(() => {
    // Nothing is saved by itself while the question about someone else's newer version is open.
    if (!env || correcting || stale) return;
    if (state === 'dirty') {
      const t = setTimeout(() => save().catch(() => {}), 1200);
      return () => clearTimeout(t);
    }
    if (state === 'stuck' && stuck?.retry) {
      const t = setTimeout(() => save().catch(() => {}), Math.min(30000, 2000 * 2 ** stuck.tries));
      return () => clearTimeout(t);
    }
  }, [state, stuck, env, docs, rcps, fields.value, save, correcting, stale]);

  // ---- People who have finished ----------------------------------------------------------------------------------
  // Their own row and their own fields stay as they are in this editor. Everything else on the pages (a file, a
  // note, a field for someone who has not signed yet) can still be changed, but saving such a change means asking
  // the people who finished to sign again, and that is asked out loud before anything is saved.

  const lockedIds = useMemo(() => new Set<string>(correcting && base ? finished(base.recipients).map((r: any) => r.id) : []), [correcting, base]);
  const anyLocked = lockedIds.size > 0;
  const lockedNames = listNames(rcps.filter((r) => lockedIds.has(r.id)).map(who));
  // The fields a finished person signed stay put in this editor. A field added for them here is new, and free to move.
  const signedFields = useMemo(() => new Set<string>(correcting && base ? base.fields.filter((f: any) => f.recipient_id && lockedIds.has(f.recipient_id)).map((f: any) => f.id) : []), [correcting, base, lockedIds]);
  // Started from a template whose wording is locked for this person (src/server/tplroles.ts): every field stays where
  // it is, and the steps show the documents, the roles and the message as locked, so nobody types and is refused.
  const wording: WordingLock | null = env?.wording_lock || null;
  const isLockedField = useCallback((f: any) => signedFields.has(f.id) || !!wording, [signedFields, wording]);

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

  // Several pictures chosen at once are most often the pages of one paper document. `oneDocument` is the sender's
  // answer to that question (see PhotoAsk); until it is given, nothing is uploaded.
  function addFiles(list: FileList | File[] | null, oneDocument?: boolean) {
    if (!list?.length) return;
    const files = Array.from(list);
    if (oneDocument === undefined && files.filter((f) => isPicture(f) && !precheck(f, true)).length > 1) {
      opener.current = document.activeElement as HTMLElement | null;
      return setPhotoAsk(files);
    }
    // The pictures of one document travel together, and the document takes the place of the first of them.
    const pics = oneDocument ? files.filter((f) => isPicture(f) && !precheck(f, true)) : [];
    const groups = files.flatMap((f) => (!pics.includes(f) ? [[f]] : f === pics[0] ? [pics] : []));
    let room = MAX_DOCS - live.current.docs.length - uploads.filter((u) => u.state !== 'error').length;
    for (const group of groups) {
      const key = newId('up');
      const name = group.length > 1 ? `${group[0].name} and ${plural(group.length - 1, 'more picture')}` : group[0].name;
      const sizeOf = (l: File[]) => l.reduce((n, f) => n + f.size, 0);
      // A picture is made smaller before it leaves, so whether it is too large is only known after that.
      const problem = precheck(group[0], isPicture(group[0])) || (room <= 0 ? `An envelope can hold up to ${MAX_DOCS} documents. Remove one to add this file.` : '');
      if (problem) {
        setUploads((u) => [...u, { key, name, size: sizeOf(group), progress: 0, state: 'error', error: problem }]);
        continue;
      }
      room--;
      setUploads((u) => [...u, { key, name, size: sizeOf(group), progress: 0, state: 'waiting' }]);
      const patch = (p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
      // One at a time, in the order they were chosen, so the documents end up in that order too.
      queue.current = queue.current.then(async () => {
        try {
          if (group.some(isPicture)) patch({ state: 'preparing' });
          const ready: File[] = [];
          for (const one of group) ready.push(await shrinkPhoto(one));
          if (sizeOf(ready) > MAX_BYTES) throw new Error(ready.length > 1 ? `Together these pictures are ${fmtSize(sizeOf(ready))}, and one document can be up to 25 MB. Choose fewer pictures at a time and add the rest as a second document.` : precheck(ready[0]));
          patch({ state: 'uploading', size: sizeOf(ready) });
          const f = await uploadFile(ready.length > 1 ? ready : ready[0], (n) => patch(n >= 1 ? { progress: 1, state: 'checking' } : { progress: n }));
          setUploads((u) => u.filter((x) => x.key !== key));
          setDocs((d) => [...d, { id: newId('doc'), file_id: f.id, name: f.name, pages: f.pages, page_sizes: f.page_sizes, is_scan: f.is_scan, scan_pages: f.scan_pages, size: f.size }]);
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
    const problem = precheck(file, isPicture(file));
    if (problem) return toast(problem, true);
    try {
      toast('Uploading the new file…');
      // A photo is made smaller first, as when it is added (see photos.ts).
      const ready = await shrinkPhoto(file);
      if (precheck(ready)) return toast(precheck(ready), true);
      const f = await uploadFile(ready, () => {});
      setDocs((l) => l.map((x) => (x.id === did ? { ...x, file_id: f.id, pages: f.pages, page_sizes: f.page_sizes, is_scan: f.is_scan, scan_pages: f.scan_pages, size: f.size } : x)));
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
      // Someone whose link the sender sends themselves needs a name and no address (editor/SendMyself.tsx).
      if (!isTpl && r.link_by_sender) {
        const no = sendMyselfTrouble(r, name, fields.value);
        if (no) p.push(no);
      } else if (!isTpl && (!r.name.trim() || !validEmail(r.email))) p.push(`${name} needs a name and a valid email.`);
      if (isTpl && !r.role_name?.trim() && !r.email) p.push('Give every open recipient a role name, such as "Client".');
      if (isTpl && r.email && !validEmail(r.email)) p.push(`${name} needs a valid email, or leave it empty to fill in later.`);
      if (SIGNS(r) && !fields.value.some((f) => f.recipient_id === r.id)) p.push(`${name} has no fields to sign yet.`);
      // An access code that is set or changed needs a few characters, or it is guessed in a minute. The server
      // refuses a shorter one too. A code that was already on an envelope before this rule may stay as it is.
      const ac = (r.access_code || '').trim();
      const was = correcting && base ? base.recipients.find((x: any) => x.id === r.id)?.access_code : null;
      if (ac && ac.length < 4 && ac !== was) p.push(`The access code for ${name} needs at least 4 characters. Make it longer, or leave it empty for no code.`);
      // A check by text message needs a number we can text, on a server that sends texts. The server refuses the same.
      const check = checkTrouble(r, !!me.text_messages, name, isTpl && !r.email);
      if (check) p.push(check);
    }
    if (!isTpl && rcps.length > 0 && !rcps.some((r) => r.role !== 'cc')) p.push('Add at least one recipient who signs, approves or views.');
    // Two fields of one person on top of each other: on a phone only the top one can be tapped. The server refuses it too.
    p.push(...stackedFields(fields.value, rcps, docs));
    return [...new Set(p)];
  }, [docs, rcps, fields.value, isTpl, correcting, base, me.text_messages]);

  const mine = { ordered: env?.ordered, date_format: env?.date_format, documents: docs, recipients: rcps, fields: fields.value };
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

  // `anyway` is true only when the sender answered "Send anyway" below. A click hands in its event, which is not true.
  async function send(anyway?: unknown) {
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
      try {
        await api(`/envelopes/${id}/send`, { method: 'POST', body: { send_anyway: anyway === true } });
      } catch (e: any) {
        // An address on it bounced before (src/lib/mailnews.ts). Nothing went out: the sender sees which address and
        // why, and decides. It is never refused for good.
        if (e?.code !== 'bounced_address' || anyway === true) throw e;
        const q = sendAnywayAsk(e.data?.bounced || []);
        return confirm({ title: q.title, body: q.body, yes: 'Send anyway', no: 'Go back and check', onYes: () => void send(true) });
      }
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

  // The plain question behind every change that touches what someone already signed. Nothing is saved until the
  // sender has answered it.
  function askSignAgain(names: string[]) {
    const all = listNames(names.length ? names : ['Someone']);
    const signedAll = names.every((n) => SIGNS(rcps.find((r) => who(r) === n) || { role: 'signer' }));
    confirm({
      title: `${all} already ${signedAll ? 'signed' : 'finished'}`,
      body: `Saving this means ${all} ${names.length > 1 ? 'have' : 'has'} to ${signedAll ? 'sign' : 'look at the document and finish'} again. They get an email that says what changed. What they ${signedAll ? 'signed' : 'did'} the first time stays on record, and it is not counted as another signature.`,
      yes: `Ask ${all} to ${signedAll ? 'sign' : 'finish'} again`, no: 'Go back', onYes: () => saveCorrection(true),
    });
  }

  // `again` is the sender's answer to that question: save, and ask the people who finished to sign again.
  async function saveCorrection(again = false) {
    setBusy(true);
    setError('');
    try {
      const cur = await catchUp();
      if (!cur.ok && !again) return;
      // Asked here when this editor can already see it. The server asks the same thing (409) when it cannot.
      const now = serverCopy.current;
      const names = again || !now ? [] : signsAgain(now, { ordered: env.ordered, date_format: env.date_format, documents: docs, recipients: cur.recipients, fields: cur.fields } as any).map(who);
      if (names.length) return askSignAgain(names);
      await api(`/envelopes/${id}`, { method: 'PUT', body: { ...body(cur.recipients, cur.fields), expire_days: undefined, ...(again ? { resign: true } : {}), ...(loaded.current != null ? { edit_version: loaded.current } : {}) } });
      toast(again ? 'Changes saved. The people who had finished are asked to sign again.' : 'Changes saved. Nobody had to start again.');
      leave(`/app/envelopes/${id}`);
    } catch (e: any) {
      if (e?.code === 'sign_again') return askSignAgain(e.data?.sign_again || []);
      if (e?.code === 'stale') return setStale({ by: e.data?.edited_by || 'Someone', at: e.data?.edited_at || '', how: e.data?.edited_how || '' });
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
    setEnv((e: any) => ({ ...e, date_format: serverCopy.current.date_format }));
    setConflict([]);
    setError('');
    toast('The documents and fields are back as they were signed.');
  }

  // Someone else saved a newer version. Either take theirs, or keep this one as a separate copy. Nothing is lost.
  function loadTheirs() {
    leaving.current = true;
    window.location.reload();
  }
  async function keepMineAsCopy() {
    setBusy(true);
    try {
      const made = await api('/envelopes', { body: { ...body(), kind: env.kind, subject: `${env.subject || 'Untitled'} (my copy)` } });
      toast('Your version is saved as a separate copy.');
      setStale(null);
      leave(`/app/${isTpl ? 'templates' : 'envelopes'}/${made.envelope.id}/edit`);
    } catch (e) {
      toast(friendly(e), true);
    } finally {
      setBusy(false);
    }
  }

  if (!env) return <div className="muted center" style={{ padding: 80 }} role="status">Loading…</div>;

  const ed: Ed = {
    env, base, isTpl, correcting, lockedIds, lockedNames, anyLocked, isLockedField, wording, docs, rcps, fields, contacts, uploads, color,
    patchEnv, addFiles, dismissUpload: (key) => setUploads((u) => u.filter((x) => x.key !== key)), renameDoc, removeDoc, replaceDoc, moveDoc, addRcp, patchRcp, removeRcp,
    setFields, undo, redo, modalOpen: !!ask || !!photoAsk, go,
    showField: (fid) => (setJump(fid), void go(2)), jump, clearJump: () => setJump(null),
  };
  // Closing the question about pictures hands focus back to the upload box it came from.
  const closePhotoAsk = () => {
    setPhotoAsk(null);
    const el = opener.current;
    setTimeout(() => el?.isConnected && el.focus(), 0);
  };
  // Wrapped so a click never arrives as the answer to "ask them to sign again". Only that question says yes.
  const submit = correcting ? () => saveCorrection() : send;
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
        {/* Help opens beside the editor, so nothing that is being worked on is left behind. */}
        <a className="btn sm ghost" href="/help?topic=sending#sending" target="_blank" rel="noreferrer" aria-label="Help (opens in a new tab)"><span className="ed-only-sm" aria-hidden="true">?</span><span className="hide-sm">Help</span></a>
        {step < 3 ? <button type="button" className="btn primary" onClick={() => go(step + 1)}>Next</button>
          : <button type="button" className="btn primary hide-sm" disabled={submitOff} onClick={submit}>{isTpl ? 'Save template' : correcting ? 'Save changes' : 'Send'}</button>}
      </div>

      {wording && <WordingBanner lock={wording} />}
      {correcting && (
        <div className="ed-banner" role="note">
          <b>This envelope is already out.</b> Change what you need to. Nobody has to start again, and nothing changes until you save.
          {anyLocked && <> {lockedNames} already finished. If you change a document, a note or a field now, they have to sign again, and you are asked before anything is saved.</>}
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
      {step === 3 && <StepReview ed={ed} problems={problems} busy={busy} changed={changed} error={error} conflict={conflict} closed={closed} result={result} onSubmit={submit} onRestore={restore} onSignAgain={() => saveCorrection(true)} onDiscard={discard} />}

      {stale && (
        <Modal title={stale.how ? `This ${isTpl ? 'template' : 'envelope'} changed after you opened it` : `${stale.by} saved a newer version`} onClose={() => setStale(null)}>
          {/* The newer version is not always a save from an editor. When it was something else (a quick correction,
              a signer passing the document on or fixing their name, sending), the dialog says what it was. */}
          <p className="muted">
            {stale.how
              ? <>{stale.by} {stale.how}{stale.at ? ` on ${fmtDate(stale.at, true)}` : ''}, after you opened it here. Your changes were not saved, so that is not undone and nothing is lost.</>
              : <>{stale.by} saved this {isTpl ? 'template' : correcting ? 'envelope' : 'draft'}{stale.at ? ` on ${fmtDate(stale.at, true)}` : ''}, after you opened it here. That may have been you, in another tab or window.
                Your changes were not saved over theirs, so nothing is lost.</>}
          </p>
          <p className="muted">
            {correcting
              ? `Load ${stale.how ? 'it as it is now' : 'their version'} to carry on from what is saved, then make your changes again. Go back if you first want to note down what you changed.`
              : `Load ${stale.how ? 'it as it is now' : 'their version'} to carry on from what is saved, or keep what you have here as a separate copy and sort it out later.`}
          </p>
          <div className="actions">
            <button type="button" className="btn" autoFocus onClick={() => setStale(null)}>Go back</button>
            {!correcting && <button type="button" className="btn" disabled={busy} onClick={keepMineAsCopy}>Keep mine as a copy</button>}
            <button type="button" className="btn primary" onClick={loadTheirs}>{stale.how ? 'Load it as it is now' : 'Load their version'}</button>
          </div>
        </Modal>
      )}

      {photoAsk && <PhotoAsk files={photoAsk} onClose={closePhotoAsk} onPick={(files, one) => (closePhotoAsk(), addFiles(files, one))} />}

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
