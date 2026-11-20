'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, toast, fmtDate } from '@/components/ui';
import { PdfDoc } from '@/components/PdfDoc';
import { HandBack } from '@/components/HandBack';
import { AdoptSignature, type SavedMark } from '@/components/SignaturePad';
import { formatDate, formatDateValue, deviceZone, momentText } from '@/lib/dates';
import { consentWording } from '@/lib/policy';
import { fmtNum } from '@/lib/impact';
import { NUMBER_HINT } from '@/lib/numbers';
import { Shell, StateCard, Sender, Impact, Icon, useMedia, bringIntoView } from '@/components/sign/parts';
import { ReplacedLink, UnknownLink, LoadProblem } from '@/components/sign/deadEnds';
import { CodeCheck } from '@/components/sign/CodeCheck';
import { MenuDialog, ReportDialog, DeclineDialog, ReassignDialog, SignedFieldDialog, ReviewDialog, FieldSheet, type MenuItem } from '@/components/sign/dialogs';
import { TextView } from '@/components/sign/TextView';
import { PageFields, PageOthers, otherSource, type FieldCtx } from '@/components/sign/TextFields';
import { AUTO, TYPED, fieldName, groupKey, isBox, isMulti, buildItems, problemWith, pos, readKept, writeKept } from '@/components/sign/fields';
import { useLiveLogic } from '@/components/sign/logic';
import { keepTitle, accountMarks, tapOnMark, restoreMarks, saveBody, placeFlag, type Marks, type Box, type FlagSide } from '@/components/sign/fields';
import { docUrl, allOnScreen } from '@/components/sign/fields';
import { useAutoReview } from '@/components/sign/autoReview';
import { strikeClass } from '@/lib/strike';
import { pageBoxes } from '@/components/sign/pdfText';
import { NoViewer } from '@/components/sign/NoViewer';
import { ZoomControl } from '@/components/sign/Zoom';
import { isConnectionError, finishNotSent, saveNotSent, keepAnswers, readAnswers, dropAnswers, FINISH_RETRY_MS } from '@/components/sign/offline';
import { CANNOT_REACH, sameFieldAgain } from '@/components/sign/stuck';
import { SIGNING_ONLINE } from '@/lib/mobile';
import { PayLink } from '@/components/sign/PayLink';
import { NoEmailDone, NoEmailWait } from '@/components/sign/NoEmail';
// "Questions and comments": the one way to ask the sender something, and the note before Finish (Comments.tsx).
import { CommentsDialog, OpenQuestion, useMyQuestions } from '@/components/sign/Comments';
import { MailAgain } from '@/components/sign/MailAgain';
import { witnessFirst, WitnessFirst, WitnessNotice, WitnessName, WitnessAfter } from '@/components/sign/Witness';
// A document sent to a signing group: what this member's own link is to the group (src/server/groups.ts).
import { GroupAway, GroupConsentNote, HandBackDialog, groupAway, groupDeclineText } from '@/components/sign/GroupNotice';

type Save = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
type Open = '' | 'menu' | 'decline' | 'reassign' | 'ask' | 'report' | 'review' | 'handback';
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
  const [adopt, setAdopt] = useState<{ kind: 'signature' | 'initials'; field?: string; saved?: SavedMark | null } | null>(null);
  // Which of the two marks was made or confirmed in this tab. One that only comes from storage (saved with this
  // document on another device, or kept on the signer's account) is shown in the adopt dialog and confirmed there
  // before a tap puts it on the page.
  const [seen, setSeen] = useState({ signature: false, initials: false });
  const [account, setAccount] = useState<Marks>({ signature: null, initials: null });
  // Where the printed lines of the page with the next field sit, so the "Sign here" pointer keeps off them.
  const [printed, setPrinted] = useState<{ key: string; boxes: Box[]; w: number; h: number } | null>(null);
  const [pdfReady, setPdfReady] = useState(0);
  const pdfs = useRef<Record<string, any>>({});
  const [open, setOpen] = useState<Open>('');
  const [signedField, setSignedField] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  // The date field whose picker is open. A date that was picked is otherwise shown the way it will be printed.
  const [dateOpen, setDateOpen] = useState<string | null>(null);
  const [view, setView] = useState<'doc' | 'text'>('doc');
  // The size of the pages: 1, 1.5 or 2 times the width of the screen (Zoom.tsx).
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  const [agree, setAgree] = useState(false);
  const [code, setCode] = useState('');
  const [askedCode, setAskedCode] = useState<'' | 'busy' | 'asked'>('');
  const [formError, setFormError] = useState('');
  const [finishError, setFinishError] = useState('');
  const [finished, setFinished] = useState<any>(null);
  const [save, setSave] = useState<Save>('idle');
  const [muted, setMuted] = useState(false);
  const [muteNote, setMuteNote] = useState<'' | 'done' | 'failed'>('');
  const [moreTime, setMoreTime] = useState<'' | 'busy' | 'asked'>('');
  const [wantCopy, setWantCopy] = useState(false);
  // Set when the sender changed the document while this page was open: the page has loaded the new version and
  // asks the person to look again before they finish.
  const [changedOpen, setChangedOpen] = useState(false);
  // Which file of each document is on this screen right now: the fingerprint of the file whose pages are drawn, or
  // read out in the text view. When the sender replaces a file, the page loads the new one, and Finish does not
  // work until its pages are here. Nobody finishes on pages they were not shown.
  const [onScreen, setOnScreen] = useState<Record<string, string>>({});
  const markShown = useCallback((d: any) => setOnScreen((s) => (s[d.id] === (d.sha256 || '') ? s : { ...s, [d.id]: d.sha256 || '' })), []);
  const touch = useMedia(TOUCH);
  // The content version this page shows. It goes back with consent, every save and Finish, and the server refuses
  // a save or a Finish that comes from an older version than the one on the envelope.
  const version = useRef<number | null>(null);

  const valuesRef = useRef(values);
  valuesRef.current = values;
  const kept = useRef<{ sig: string | null; ini: string | null }>({ sig: null, ini: null });
  kept.current = { sig, ini };
  const seenRef = useRef(seen);
  seenRef.current = seen;
  // The signature and initials the server holds for this person, so autosave sends them only when they changed.
  const savedMarks = useRef<{ sig: string | null; ini: string | null }>({ sig: null, ini: null });
  const lastSaved = useRef('');
  const canSave = useRef(false);
  const rejected = useRef(0);
  const warnedSave = useRef(false);
  // Next that keeps coming back to the same empty field: something on the page may cover it (stuck.ts).
  const nextAgain = useRef(sameFieldAgain()).current;
  // Finish was pressed and did not get through for want of a connection: it is sent again by itself (see complete).
  const [finishPending, setFinishPending] = useState(false);
  const completeRef = useRef<() => void>(() => {});
  const afterClose = useRef<any>(null);
  // The name on the request as this tab last showed it: see load, where marks made under another name are dropped.
  const who = useRef<string | null>(null);
  const stageRef = useRef('loading');
  // This person's questions that nobody has answered yet: mentioned when they press Finish, never in the way of it.
  const questions = useMyQuestions(base, !!data?.fields && open !== 'ask');

  const load = useCallback(async () => {
    try {
      const d = await api(base);
      setProblem(null);
      setData(d);
      version.current = d.version ?? null;
      setMuted((m) => m || !!d.recipient?.muted);
      if (d.fields) {
        // Marks made or confirmed in this tab come first: the ones on screen, or after a reload the tab's own
        // store. Otherwise the ones saved with the document on another device are used, so what was signed there
        // stays signed here. Opening the document never saves anything back: see restoreMarks.
        // A mark belongs to the person who made it. When the name on the request is no longer the one this tab
        // showed last (the sender put somebody else on it), nothing made in this tab is carried over: no signature,
        // no initials, no answer that was not saved yet. Only what the server still holds for the request is used.
        const mine = who.current == null || who.current === d.recipient?.name;
        who.current = d.recipient?.name ?? null;
        const stored = readKept(token, d.recipient?.name);
        const start = restoreMarks(d.fields, d.recipient, { sig: (mine && seenRef.current.signature && kept.current.sig) || stored.sig, ini: (mine && seenRef.current.initials && kept.current.ini) || stored.ini });
        const server = start.values;
        setSig(start.sig);
        setIni(start.ini);
        setSeen(start.seen);
        savedMarks.current = start.saved;
        const unsaved = mine && !!lastSaved.current && JSON.stringify(valuesRef.current) !== lastSaved.current;
        // Answers not saved yet are kept, but only for fields that still exist: the sender may have taken one away.
        // After a reload, answers this tab had not got through to the server yet come back from its own storage.
        const tabKept = mine && !unsaved ? readAnswers(token, d.recipient?.name, Object.keys(server)) : null;
        setValues((prev) => (unsaved ? { ...server, ...Object.fromEntries(Object.entries(prev).filter(([id]) => id in server)) } : tabKept ? { ...server, ...tabKept } : server));
        lastSaved.current = start.baseline;
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

  // Someone who is signed in gets the signature saved on their own account offered, as a choice in the adopt dialog
  // that they have to confirm. It is never put on the page by itself, and it is only offered when the account has
  // this person's name as well as their address: two people can share an address. Never in person: that device
  // belongs to the host. See accountMarks and tapOnMark.
  useEffect(() => {
    if (!data?.recipient || data.recipient.role === 'inperson' || !data.fields) return setAccount({ signature: null, initials: null });
    let on = true;
    api('/me').then((m) => on && setAccount(accountMarks(m.user, data.recipient))).catch(() => {});
    return () => {
      on = false;
    };
  }, [data?.recipient?.email, data?.recipient?.name, data?.recipient?.role, !!data?.fields]); // eslint-disable-line react-hooks/exhaustive-deps

  // The browser tab names the document, so it can be found again among other tabs, and keeps that name when the
  // framework writes the site's own title into the head again: see keepTitle.
  useEffect(() => keepTitle(data?.envelope?.subject), [data?.envelope?.subject]);

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
  const allShown = allOnScreen(data?.documents, onScreen);
  // "Only show when" and formulas, live: hidden fields are left out, a calculated one holds its result (logic.ts).
  const ownFields: any[] = useMemo(() => data?.fields || [], [data?.fields]);
  const otherFields: any[] = useMemo(() => data?.others || [], [data?.others]);
  const logic = useLiveLogic(ownFields, otherFields, values, setValues);
  const fields: any[] = logic.fields;
  // A witness signs too, in a block of their own, after a statement of their own (sign/Witness.tsx).
  const acts = me?.role === 'signer' || me?.role === 'inperson' || me?.role === 'witness';
  const closed = !!env && (env.status === 'voided' || env.status === 'declined' || env.status === 'expired' || me.status === 'declined');
  const iAmDone = !!finished || me?.status === 'completed';
  // A closed or not-yet-ready document says so straight away, before anyone is asked for an access code.
  // `wantCopy`: someone who signed a document that was closed later asks for their copy, and it is behind an access
  // code that this browser has not been given (or no longer remembers). Then the code is asked for after all.
  const stage = handedTo ? 'handed' : !data ? (problem ? 'problem' : 'loading') : closed && !(wantCopy && data.locked) ? 'closed' : me.status === 'pending' ? 'pending' : data.locked ? 'locked' : iAmDone ? 'done' : !me.consented ? 'consent' : 'sign';
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
  // A required field that just appeared comes first, so Next goes to it (useLiveLogic).
  const nextField = (logic.appeared && left.find((i) => i.fields.some((f: any) => f.id === logic.appeared))?.first) || left[0]?.first;
  // Today's date where this person is: the date of signing is the calendar day in their own time zone.
  const dateText = formatDate(new Date(), env?.date_format, deviceZone());
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
    // The adopted signature and initials are saved with the answers, so another device or tab gets them back. They
    // are sent when they changed, not with every keystroke. From a closing page they only go along when the whole
    // request stays small: a request the browser finishes on its own has a size limit, and one that is too big
    // would lose the answers with it.
    let body = saveBody(valuesRef.current, version.current, kept.current, savedMarks.current);
    if (leaving && JSON.stringify(body).length > 60_000) body = saveBody(valuesRef.current, version.current, savedMarks.current, savedMarks.current);
    const marks = { sig: body.signature_png, ini: body.initials_png };
    if (json === lastSaved.current && !marks.sig && !marks.ini) return true;
    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' as const };
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
      if (!res.ok) throw Object.assign(new Error(), { status: res.status, code: (await res.json().catch(() => ({}))).code });
      lastSaved.current = json;
      savedMarks.current = { sig: marks.sig || savedMarks.current.sig, ini: marks.ini || savedMarks.current.ini };
      rejected.current = 0;
      warnedSave.current = false;
      setSave(JSON.stringify(valuesRef.current) === json ? 'saved' : 'pending');
      return true;
    } catch (e: any) {
      if (!canSave.current) return true;
      // The sender changed the document while it was open here. Nothing was saved over the new version: load it,
      // keep what was typed for the fields that are still there, and say so.
      if (e?.code === 'changed') {
        // The last step before sending ("Finish and send") is closed too: it must never be taken on top of a
        // document that changed underneath it. The person sees the notice and the new pages first.
        setOpen((o) => (o === 'review' ? '' : o));
        setChangedOpen(true);
        setSave('idle');
        load();
        window.scrollTo({ top: 0 });
        return false;
      }
      // The document changed underneath us (voided, corrected, finished elsewhere): show what is true now.
      if (e?.status >= 400 && e.status < 500 && e.status !== 429 && rejected.current++ < 2) {
        setSave('idle');
        load();
      } else {
        // Said once until a save gets through again, never from inside a state update (React may run those twice).
        // Not over an open dialog: the last step says it in its own words, and the next try after it closes says it.
        if (!warnedSave.current && !document.documentElement.classList.contains('sg-locked')) {
          toast(isConnectionError(e) ? saveNotSent(navigator.onLine !== false) : 'We could not save just now. We will keep trying, and nothing is lost while this page stays open.', true);
          warnedSave.current = true;
        }
        setSave('error');
      }
      return false;
    }
  }, [base, load]);

  const valuesJson = JSON.stringify(values);
  useEffect(() => {
    // A new signature or new initials count as a change to save, also when no field changed with them.
    const newMarks = (!!sig && sig !== savedMarks.current.sig) || (!!ini && ini !== savedMarks.current.ini);
    if (stage !== 'sign' || !canSave.current || (valuesJson === lastSaved.current && !newMarks)) return;
    setSave((s) => (s === 'error' ? s : 'pending'));
    const t = setTimeout(() => flush(), 1500);
    return () => clearTimeout(t);
  }, [valuesJson, sig, ini, stage, flush]);
  useEffect(() => {
    if (save !== 'error') return;
    const t = setInterval(() => flush(), 8000);
    // And at once when the device says it is back online.
    const back = () => flush();
    window.addEventListener('online', back);
    return () => (clearInterval(t), window.removeEventListener('online', back));
  }, [save, flush]);
  // Answers that have not reached the server yet are kept in the tab as well, so a reload does not lose them. Once the
  // server has them, or the page is done with them, they are cleared (offline.ts).
  useEffect(() => {
    if (stage === 'sign' && acts) return valuesJson !== lastSaved.current ? keepAnswers(token, data?.recipient?.name, values) : dropAnswers(token);
    if (stage === 'done' || stage === 'closed' || stage === 'handed') dropAnswers(token);
  }, [valuesJson, save, stage, acts, token]); // eslint-disable-line react-hooks/exhaustive-deps
  // A Finish that did not get through is sent again when the device says it is back online, and every few seconds
  // while it says it is online anyway (a weak signal, or our server was briefly out of reach). Only while the last
  // step is still open: someone who went back to change something is not finished behind their back.
  completeRef.current = complete;
  useEffect(() => {
    if (!finishPending || busy || stage !== 'sign' || (open !== 'review' && data?.recipient?.role !== 'viewer')) return;
    const again = () => completeRef.current();
    const t = setInterval(() => navigator.onLine !== false && again(), FINISH_RETRY_MS);
    window.addEventListener('online', again);
    return () => (clearInterval(t), window.removeEventListener('online', again));
  }, [finishPending, busy, stage, open, data?.recipient?.role]);
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

  // The adopted signature lives in this tab until the document is finished, so a reload does not lose it. Only a
  // mark made or confirmed here is kept that way: one that came from storage still has to be confirmed after a reload.
  useEffect(() => {
    if (stage === 'sign' && acts) writeKept(token, seen.signature ? sig : null, seen.initials ? ini : null, data?.recipient?.name);
  }, [sig, ini, seen, stage, acts, token, data?.recipient?.name]);

  // The "Sign here" pointer must not sit on the words of the page. They are read from the document that is already
  // drawn (nothing is downloaded again), for the page that holds the next field, together with the size of that
  // page on this screen. Where the pointer then goes is decided by placeFlag, further down.
  const flagKey = nextField && view === 'doc' && stage === 'sign' ? `${nextField.document_id}:${nextField.page}:${nextField.id}` : '';
  useEffect(() => {
    if (!flagKey || !nextField) return;
    let live = true;
    const read = () => {
      const pdf = pdfs.current[nextField.document_id];
      const el = document.getElementById(`f-${nextField.id}`)?.closest('.pdfpage');
      if (!pdf || !el) return;
      pageBoxes(pdf, nextField.page).then((boxes) => live && setPrinted({ key: flagKey, boxes, w: el.clientWidth, h: el.clientHeight })).catch(() => {});
    };
    read();
    window.addEventListener('resize', read);
    return () => {
      live = false;
      window.removeEventListener('resize', read);
    };
  }, [flagKey, pdfReady, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Moving around ------------------------------------------------------------------------------
  const usesSheet =(f: any) => touch && view === 'doc' && (TYPED.includes(f.type) || f.type === 'dropdown');

  function goTo(f: any) {
    const el = document.getElementById(`${view === 'text' ? 't' : 'f'}-${f.id}`);
    // When the pages cannot be shown on this device at all (NoViewer), waiting will not help: say so.
    if (!el) return toast(document.querySelector('.sg-noview') ? 'The document cannot be shown on this device, so its fields cannot be reached here. The notice above the pages says what you can do.' : 'The document is still loading. Try again in a moment.', !!document.querySelector('.sg-noview'));
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
    // A mark made or confirmed in this tab goes straight on. A stored one is shown in the dialog first.
    const tap = tapOnMark({ current: kind === 'signature' ? sig : ini, seen: seen[kind], account: account[kind] });
    if (tap.apply) set(f.id, '1');
    else setAdopt({ kind, field: f.id, saved: tap.offer });
  }
  /** "Change my signature": make a new one, with the one on the person's own account offered when it is another. */
  function changeMark(kind: 'signature' | 'initials') {
    const current = kind === 'signature' ? sig : ini;
    setAdopt({ kind, saved: tapOnMark({ current: seen[kind] ? null : current, seen: false, account: account[kind] === current ? null : account[kind] }).offer });
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

  // Said instead of finishing while the pages of the document, as it is now, are not on the screen yet.
  const NOT_SHOWN = 'The document is still loading. You can finish as soon as its pages are on your screen.';

  // The first time nothing required is left, "Check before you finish" opens by itself (see autoReview.ts).
  useAutoReview(stage === 'sign' && acts && required.length > 0 && left.length === 0 && allShown && !sheet && !adopt && !open && !signedField && !changedOpen && !busy
    && !ordered.some((f) => problemWith(f, values[f.id] || '')), pressFinish);

  function pressFinish() {
    if (!allShown) return toast(NOT_SHOWN, true);
    if (me.role === 'viewer') return complete();
    const wrong = acts && ordered.find((f) => problemWith(f, values[f.id] || ''));
    if (wrong) {
      // On a phone the field opens in its sheet, which says what is wrong right under the input.
      if (!usesSheet(wrong)) toast(`${fieldName(wrong)} needs another look. ${problemWith(wrong, values[wrong.id])}`, true);
      return goTo(wrong);
    }
    setFinishError('');
    setFinishPending(false);
    setOpen('review');
  }

  async function complete() {
    // The server refuses a Finish from an older version. This is the other half: the version this page sends is only
    // ever one whose pages it has drawn.
    if (!allShown) return (setOpen(''), toast(NOT_SHOWN, true));
    setBusy(true);
    setFinishError('');
    try {
      const r = await api(`${base}/complete`, { body: { values, signature_png: sig, initials_png: ini, version: version.current, tz: deviceZone() } });
      canSave.current = false;
      writeKept(token, null, null);
      dropAnswers(token);
      setFinishPending(false);
      setOpen('');
      setFinished(r);
    } catch (e: any) {
      const msg = e?.message || 'Something went wrong on our side.';
      if (isConnectionError(e)) {
        // It never reached us, so nothing was signed. Say that, keep everything as it is, and send it again by itself
        // when the connection is back (the effect next to autosave). Never the browser's own "Failed to fetch".
        const said = finishNotSent(navigator.onLine !== false, me.role === 'approver' ? 'Approve and send' : 'Finish and send');
        setFinishPending(true);
        if (open === 'review') setFinishError(said);
        else toast(said, true);
      } else if (e?.code === 'changed') {
        // Nothing was signed. Show the document as it is now, with the answers that still have a field, and ask
        // for another look before finishing.
        setOpen('');
        setChangedOpen(true);
        await load();
        window.scrollTo({ top: 0 });
      } else if (/no longer open|already finished|not your turn/i.test(msg)) {
        setOpen('');
        toast(msg, true);
        await load();
      } else if (open === 'review') setFinishError(e?.status >= 500 ? `${msg} Nothing was signed. Try again in a moment.` : `${msg} Go back, put it right, then finish again.`);
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

  // On the locked screen: never given the code, or the code is frozen. One click tells the sender, no code needed.
  async function askForCode() {
    setAskedCode('busy');
    try {
      await api(`${base}/ask-code`, { method: 'POST' });
      setAskedCode('asked');
    } catch (e: any) {
      setAskedCode('');
      toast(e?.status === 429 ? `You have already asked today. You can also email ${env.sender.email} directly.` : `${e?.message || 'We could not send that.'} You can also email ${env.sender.email} directly.`, true);
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
  // MailAgain: they marked our email as spam, so we email them nothing more about this, and only they can undo it.
  const notice = <><MailAgain base={base} stopped={!!me.mail_stopped} />{muteNote === 'done' ? (
    <div className="notice sg-top" role="status">
      <b>Reminders are off.</b> We will not send you any more reminder emails about this document.{stillOpen ? ` You can still ${acts ? 'sign' : 'open'} it here whenever you are ready.` : ''}
    </div>
  ) : muteNote === 'failed' ? (
    <div className="notice warn sg-top" role="alert">We could not turn off reminders just now. <button type="button" className="sg-link" onClick={() => mute(true)}>Try again</button></div>
  ) : null}</>;
  const dialogs = (
    <>
      {open === 'report' && <ReportDialog base={base} sender={sender} onClose={() => setOpen('')} />}
      {open === 'ask' && <CommentsDialog base={base} sender={sender} documents={data.documents || []} onClose={() => setOpen('')} />}
      {open === 'decline' && <DeclineDialog base={base} sender={sender} note={groupDeclineText(data)} title={me.role === 'approver' ? 'Decline to approve' : 'Decline to sign'} onClose={() => setOpen('')} onDone={() => { canSave.current = false; writeKept(token, null, null); setOpen(''); load(); }} />}
      {open === 'reassign' && <ReassignDialog base={base} sender={sender} onClose={() => setOpen('')} onDone={(name) => { canSave.current = false; writeKept(token, null, null); setOpen(''); setHandedTo(name); }} />}
      {open === 'handback' && <HandBackDialog base={base} data={data} onClose={() => setOpen('')} onDone={() => { canSave.current = false; writeKept(token, null, null); setOpen(''); toast(`Handed back to ${me.group?.name}. Nothing you filled in was kept.`); load(); }} />}
    </>
  );

  // A colleague in the group has the document, or the sender took this person out of the group: who has it, and
  // the one thing left to do here, which is to ask the sender (sign/GroupNotice.tsx).
  if (groupAway(data) && stage !== 'locked')
    return (
      <Shell data={data} footer={report}>
        {notice}
        <GroupAway data={data} base={base} />
        {dialogs}
      </Shell>
    );

  if (stage === 'locked') {
    // The sender asked for a one-time code, by email or by text message, before the document opens. Until it is
    // typed, the server tells this page nothing about the document, so the bar above shows no title either.
    if (data.needs === 'code' && data.check)
      return (
        <Shell data={data} footer={report}>
          {notice}
          <CodeCheck base={base} check={data.check} env={env} brand={data.brand} onOpen={load} />
          {dialogs}
        </Shell>
      );
    const askSender = askedCode === 'asked'
      ? <div className="notice sg-confirmed" role="status"><b>Done. We asked {sender.name}.</b> They will give you the code themselves, by phone or message. It never comes in an email from us.</div>
      : <button type="button" className="btn" disabled={askedCode === 'busy'} onClick={askForCode}>{askedCode === 'busy' ? 'Asking' : 'Ask the sender'}</button>;
    // Too many wrong tries: no code opens it now, so no box to type one into. Say what happened and who can fix it.
    if (data.code_frozen)
      return (
        <Shell data={data} footer={report}>
          {notice}
          <StateCard tone="warn" title="This access code is frozen">
            <p>The code for this document was entered wrongly too many times, so it no longer opens the document. That keeps a code from being guessed. Nothing you filled in is lost.</p>
            <p>{sender.name} has been told and can set a new code. Ask them for the new one, then open your link again.</p>
            {askSender}
            <Sender env={env} brand={data.brand} />
          </StateCard>
          {dialogs}
        </Shell>
      );
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
            // The server says what happened in full: a wrong code and how many tries are left, a short wait after
            // several wrong tries from this device, or a code that is frozen now (the screen above, after a reload).
            // The one answer that names neither a time nor a person is the general limit on how often a link may
            // be tried from one connection, which is counted over ten minutes. Said here with both.
            const vague = err?.status === 429 && !/minute/i.test(err?.message || '');
            setFormError(vague ? `This link was tried too often in a short time, so we are not taking codes from this connection for now. Wait 10 minutes, then try again. If you do not have the code, ask ${sender.name} for it: ${sender.email}. Nothing you filled in is lost.`
              : err?.message || `Something went wrong on our side. Try again in a minute. If it keeps happening, ask ${sender.name} for help: ${sender.email}.`);
            if (err?.status === 423) await load();
          } finally {
            setBusy(false);
          }
        }}>
          <div className="sg-state-icon lock"><Icon name="lock" size={26} /></div>
          <h1 className="serif" id="sg-h1" tabIndex={-1}>Enter your access code</h1>
          <p>{sender.name} protected this document with a code and will have given it to you separately. It is not in the email from us.</p>
          {data.code_next && <p className="muted">After that there is one more check: we send you a one-time code, and you type it in on the next screen.</p>}
          <label className="f"><span>Access code</span><input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={!!formError} /></label>
          {formError && <div className="notice err sg-problem" role="alert">{formError}</div>}
          <button className="btn primary lg" disabled={busy}>{busy ? 'Opening' : 'Open document'}</button>
          <p className="muted small sg-after">Do not have a code? {sender.name} chose it and is the only one who can give it to you.</p>
          <div style={{ marginTop: 10 }}>{askSender}</div>
          <Sender env={env} brand={data.brand} />
        </form>
        {dialogs}
      </Shell>
    );
  }

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
              <p>The deadline{env.expires_at ? ` was ${momentText(env.expires_at, deviceZone())}` : ' has passed'}. Nothing is lost: {sender.name} can open it again and you carry on from where you were.</p>
              {me.status !== 'completed' && me.status !== 'declined' && me.role !== 'cc' && (moreTime === 'asked' ? (
                <div className="notice sg-confirmed" role="status"><b>Done. We asked {sender.name} for more time.</b> You will get an email as soon as the document is open again.</div>
              ) : (
                <button type="button" className="btn primary lg" disabled={moreTime === 'busy'} onClick={askForTime}>{moreTime === 'busy' ? 'Asking' : `Ask ${sender.name} for more time`}</button>
              ))}
            </>
          )}
          {/* What someone signed stays theirs to download, also after the document was closed. The copy says on its
              first page that it was not completed by everyone, and why. */}
          {/* The same holds for someone who signed, was asked to sign again because the sender changed the document,
              and had not done so when it was closed (signed_before): the copy is the document as they signed it. */}
          {(me.status === 'completed' || me.signed_before) && me.role !== 'cc' && (
            <>
              {me.status === 'completed'
                ? <p>You {acts ? 'signed' : me.role === 'approver' ? 'approved' : 'viewed'} this before it was closed, and you can still download a copy of that. Its first page says that the document was not completed by everyone, so nobody takes it for a finished agreement.</p>
                : <p>You {acts ? 'signed' : me.role === 'approver' ? 'approved' : 'viewed'} this on {fmtDate(me.signed_before, true)}. After that, {sender.name} changed the document and asked you to {acts ? 'sign' : me.role === 'approver' ? 'approve' : 'confirm'} again, and it was closed before you did. You can still download {me.earlier_copy ? `the document as you ${acts ? 'signed' : me.role === 'approver' ? 'approved' : 'viewed'} it` : 'a copy of the document as it stood when it was closed'}. Its first page says what happened, so nobody takes it for a finished agreement.</p>}
              <div className="row wrap sg-actions">
                {data.locked
                  ? <button type="button" className="btn lg" onClick={() => setWantCopy(true)}><Icon name="lock" /> {data.needs === 'code' ? 'Type a one-time code to download it' : 'Enter your access code to download it'}</button>
                  : <a className="btn lg" href={downloadUrl}><Icon name="download" /> Download what you {acts ? 'signed' : me.role === 'approver' ? 'approved' : 'viewed'}</a>}
              </div>
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
          {/* In person, the device is not the signer's: the first thing the done screen says is to hand it back. */}
          {inPerson && <HandBack signer={me.name} sender={sender.name} envelopeId={env.id} />}
          <StateCard tone="ok" title={title}>
            {/* No address for someone whose link the sender passed on: nothing is emailed, so nothing is promised. */}
            {me.link_by_sender ? <NoEmailDone sender={sender.name} allDone={allDone} /> : <p>
              {allDone
                ? inPerson ? `The completed document, with its certificate, has been emailed to ${sender.name}. Download your own copy here.` : <>A copy has been emailed to {myEmail}. It includes a certificate with the full record of who signed and when.</>
                : inPerson ? `${sender.name} will get the completed document by email once everyone has finished. You can download it as it stands now.` : <>Others still need to finish. We will email the completed document to {myEmail} as soon as they have.</>}
            </p>}
            <div className="row wrap sg-actions">
              <a className="btn primary lg" href={`${downloadUrl}?inline=1`} target="_blank" rel="noreferrer"><Icon name="eye" /> {allDone ? 'View completed document' : 'View document so far'}<span className="sg-vh"> (opens in a new tab)</span></a>
              <a className="btn lg" href={downloadUrl}><Icon name="download" /> Download PDF</a>
            </div>
          </StateCard>
          {/* The sender's own payment page, when they set one and may: only after Finish (src/components/sign/PayLink.tsx). */}
          {/* A signer with a witness: what became of them, and another one after "I was not there" (sign/Witness.tsx). */}
          <WitnessAfter me={me} base={base} onNamed={load} />
          {acts && <PayLink base={base} />}
          {env.next_person && (
            <StateCard tone="wait" title="Is this a shared device?">
              <p>Your copy is on its way to {myEmail}, so you do not need this screen any more. Press the button before you hand the device on: it clears this page and opens an empty form for the next person.</p>
              <div className="row wrap sg-actions"><a className="btn primary lg" href={`/f/${env.next_person}`}>Done. Start a new form for the next person</a></div>
            </StateCard>
          )}
          <Impact impact={finished?.impact || env.impact} />
        </div>
        {dialogs}
      </Shell>
    );
  }

  // A witness's own first screen: their statement, or "I was not there". Also while they wait for the signer, and
  // after they said they were not there (sign/Witness.tsx).
  if (witnessFirst(data, stage))
    return (
      <Shell data={data} footer={report} helpInNewTab>
        {notice}
        <WitnessFirst data={data} base={base} onDone={load} />
        {dialogs}
      </Shell>
    );

  if (stage === 'pending')
    return (
      <Shell data={data} footer={report}>
        {notice}
        <StateCard tone="wait" title="It is not your turn yet">
          {me.link_by_sender ? <NoEmailWait sender={sender.name} /> : <p>Others need to finish first. We will email {myEmail} as soon as the document is ready for you. There is nothing to do until then.</p>}
          {/* Someone who signed, and is asked to sign again after a change, waits here for their turn. What they
              signed the first time is still theirs to download meanwhile. */}
          {me.signed_before && me.earlier_copy && !data.locked && (
            <>
              <p>You {acts ? 'signed' : me.role === 'approver' ? 'approved' : 'viewed'} this on {fmtDate(me.signed_before, true)}. After that, {sender.name} changed the document, so you will be asked to {acts ? 'sign' : me.role === 'approver' ? 'approve' : 'confirm'} again when it is your turn. What you {acts ? 'signed' : me.role === 'approver' ? 'approved' : 'viewed'} then is kept on record, and you can download it.</p>
              <div className="row wrap sg-actions"><a className="btn lg" href={`${downloadUrl}?earlier=1`}><Icon name="download" /> Download what you {acts ? 'signed' : me.role === 'approver' ? 'approved' : 'viewed'}</a></div>
            </>
          )}
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
    { key: 'ask', label: 'Questions and comments', hint: `Ask ${sender.name} about the document, or read what was written. It signs nothing.`, icon: 'mail', onClick: go('ask') },
    { key: 'download', label: 'Download the document', icon: 'download', href: downloadUrl, download: true },
    { key: 'print', label: 'View or print the document', hint: 'Opens in a new tab.', icon: 'eye', href: `${downloadUrl}?inline=1` },
    ...(stage === 'sign' && acts && (sig || ini) ? [{ key: 'sig', label: 'Change my signature', icon: 'pen', onClick: () => { setOpen(''); changeMark(sig ? 'signature' : 'initials'); } }] : []),
    ...(env.expires_at ? [{ key: 'time', label: `Ask ${sender.name} for more time`, hint: moreTime === 'asked' ? 'Asked. They will be in touch by email.' : `The deadline is ${momentText(env.expires_at, deviceZone())}.`, icon: 'clock', onClick: async () => { if (moreTime !== 'asked' && (await askForTime())) toast(`We asked ${sender.name} for more time. They will be in touch by email.`); } }] : []),
    // The one who took on a group's document can hand it back to the group, and passes it to nobody outside it.
    ...(me.group?.can_hand_back ? [{ key: 'handback', label: `Hand back to ${me.group.name}`, hint: 'If a colleague should do it instead. What you filled in is not kept.', icon: 'link', onClick: go('handback') }] : []),
    ...((me.role === 'signer' || me.role === 'approver') && !me.group ? [{ key: 'reassign', label: 'Assign to someone else', hint: 'If you are not the right person to sign.', icon: 'link', onClick: go('reassign') }] : []),
    ...(!muted && me.role !== 'inperson' ? [{ key: 'mute', label: 'Stop reminder emails', hint: 'For this document only.', icon: 'stop', onClick: () => { setOpen(''); mute(); } }] : []),
    // A witness does not close the document for the people who sign it: "I was not there" is theirs (sign/Witness.tsx).
    ...(me.role === 'witness' ? [{ key: 'absent', label: 'I was not there', hint: `Signs nothing, and tells ${me.witness_of?.name || 'the signer'} and ${sender.name}.`, icon: 'stop', onClick: async () => { setOpen(''); try { await api(`${base}/not-present`, { body: {} }); toast(`Done. We told ${me.witness_of?.name || 'the signer'} and ${sender.name}.`); load(); } catch (e: any) { toast(e?.message || 'Something went wrong on our side. Try again in a moment.', true); } } }] : []),
    ...(me.role !== 'viewer' && me.role !== 'cc' && me.role !== 'witness' ? [{ key: 'decline', label: declineLabel, hint: 'Closes the document for everyone.', icon: 'stop', danger: true, onClick: go('decline') }] : []),
  ];
  const other = <button type="button" className="btn sm sg-other" aria-haspopup="dialog" onClick={go('menu')}>Other actions</button>;
  const menuDialog = open === 'menu' && <MenuDialog items={menu} onClose={() => setOpen('')} />;

  if (stage === 'consent') {
    const ask = me.role === 'approver' ? 'You have been asked to approve' : me.role === 'viewer' ? 'You have been asked to read' : me.role === 'witness' ? 'You have been asked to sign as a witness' : 'You have been asked to sign';
    const wording = consentWording(sender.name, acts);
    return (
      <Shell data={data} bar={other} footer={report} helpInNewTab>
        {notice}
        <div className="card sg-consent">
          <p className="sg-kicker">{ask}</p>
          <h1 className="serif" id="sg-h1" tabIndex={-1}>{env.subject}</h1>
          <Sender env={env} brand={data.brand} />
          <p className="muted small">{me.link_by_sender ? <>This is for {me.name}. {sender.name} sent you the link themselves, not by email from us.</> : <>This was sent to {me.name} ({myEmail}).</>} Not expecting it? Do not sign. You can <button type="button" className="sg-link" onClick={go('report')}>report this request</button>.</p>
          {data.message && <div className="sg-quote"><span className="muted small">Message from {sender.name}</span>{data.message}</div>}
          {data.note && <div className="notice sg-gap"><b>Private note for you:</b> {data.note}</div>}
          {me.role === 'inperson' && <div className="notice warn sg-gap">In-person signing. Hand this device to <b>{me.name}</b> now. {SIGNING_ONLINE}</div>}
          <div className="row wrap sg-actions">
            <a className="btn" href={downloadUrl}><Icon name="download" /> Download</a>
            <a className="btn" href={`${downloadUrl}?inline=1`} target="_blank" rel="noreferrer"><Icon name="eye" /> View or print<span className="sg-vh"> (opens in a new tab)</span></a>
          </div>
          <hr className="sg-rule" />
          <h2>Electronic records and signatures</h2>
          {/* The words come from src/lib/policy.ts with a version, and the version goes back with the agreement, so the
              audit trail says which wording this person was shown. */}
          <div id="sg-legal">
            <p className="muted sg-legal">{wording.legal}</p>
            <p className="muted sg-legal">{wording.practical}</p>
          </div>
          <GroupConsentNote data={data} />
          <label className="check sg-agree">
            <input type="checkbox" checked={agree} onChange={(e) => (setAgree(e.target.checked), setFormError(''))} aria-describedby={formError ? 'sg-legal sg-agree-err' : 'sg-legal'} /> <span>{wording.agree}</span>
          </label>
          {formError && <div id="sg-agree-err" className="notice err sg-problem" role="alert">{formError}</div>}
          <button type="button" className="btn primary lg sg-continue" disabled={busy} onClick={async () => {
            if (!agree) return setFormError('Tick the box above to agree, then choose Continue.');
            setBusy(true);
            try {
              await api(`${base}/consent`, { body: { version: version.current, wording: wording.version, tz: deviceZone() } });
              await load();
            } catch (e: any) {
              // A colleague in the group took it on a moment earlier: the page then says who (GroupNotice.tsx).
              if (e?.code === 'taken') return void load();
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
    ? <button type="button" className={`btn go${big ? ' sg-big' : ''}`} onClick={() => (nextAgain(nextField.id) && view === 'doc' && toast(CANNOT_REACH), goTo(nextField))}>Next</button>
    : <button type="button" className={`btn go finish${big ? ' sg-big' : ''}`} disabled={busy || !allShown} aria-describedby={allShown ? undefined : 'sg-guide'} onClick={pressFinish}>{finishLabel}</button>;
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
    // How the answer reads on the page: a picked date in the format the sender chose for this envelope.
    const shown = f.type === 'date' ? formatDateValue(value, env.date_format) : value;
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
    if (AUTO.includes(f.type)) return <div key={f.id} {...common} title="Added for you"><span className="sg-val" dir="auto">{f.type === 'full_name' ? me.name : f.type === 'email' ? me.email : dateText}</span></div>;
    if (f.readonly) return <div key={f.id} {...common} title={f.calc_note}><span className="sg-val" dir="auto">{isBox(f) ? (f.value === '1' ? '✓' : '') : f.type === 'date' ? formatDateValue(f.value, env.date_format) : f.value}</span>{f.calc_note && <span className="sg-vh">{f.calc_note}</span>}</div>;
    // Tick boxes and radio buttons are the browser's own controls, drawn in the place the page gives them. So the
    // keyboard works as everywhere else (Space ticks, the arrow keys move through a group of radio buttons) and a
    // screen reader says what they are, whether they are on, and which group a radio button belongs to.
    if (f.type === 'checkbox')
      return (
        <label key={f.id} {...common}>
          <input type="checkbox" className="sg-vh" checked={!!value} aria-label={`${name}${need}`} aria-required={!!f.required} onChange={(e) => set(f.id, e.target.checked ? '1' : '')} />
          {value && <Icon name="check" />}
        </label>
      );
    if (f.type === 'radio') {
      const group = fields.filter((x) => x.type === 'radio' && !x.readonly && groupKey(x) === groupKey(f));
      return (
        <label key={f.id} {...common} style={{ ...pos(f), borderRadius: '50%' }}>
          <input type="radio" className="sg-vh" name={`f-${groupKey(f)}`} checked={!!value} aria-label={f.label || `Option ${group.indexOf(f) + 1} of ${group.length}`} onChange={() => pickRadio(f)} />
          {value && <span className="sg-dot" />}
        </label>
      );
    }
    if (f.type === 'attachment')
      return (
        <label key={f.id} {...common}>
          <input type="file" className="sg-vh" aria-label={`${name}${need}. ${value ? 'A file is attached. Choose another to replace it' : 'Choose a PDF, PNG or JPEG'}`} accept="application/pdf,image/png,image/jpeg" onChange={(e) => (attach(f, e.target.files?.[0]), (e.target.value = ''))} />
          <span className="cta"><Icon name={value ? 'check' : 'clip'} size={14} /> {uploading === f.id ? 'Uploading' : value ? 'Attached' : name}</span>
        </label>
      );
    if (usesSheet(f))
      return (
        <button key={f.id} type="button" {...common} onClick={() => goTo(f)} aria-label={`${name}${need}. ${value ? `Your answer: ${shown}` : 'Empty'}. Opens a box to type in`}>
          <span className={`sg-val${value ? '' : ' ph'}`} dir="auto">{shown || name + (f.required ? ' *' : '')}</span>
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
    // A date that has been picked is shown the way it will be printed, in the format the sender chose, not in the
    // browser's own. Going to the field (a click, Tab or Next) brings the date picker back.
    if (f.type === 'date' && value && dateOpen !== f.id)
      return (
        <button key={f.id} type="button" {...common} onFocus={() => setDateOpen(f.id)} onClick={() => setDateOpen(f.id)} aria-label={`${name}${need}. Your answer: ${shown}. Change it`}>
          <span className="sg-val">{shown}</span>
        </button>
      );
    // dir="auto": the direction comes from what is typed, so right-to-left text starts at the right edge of its box.
    const shared = { dir: 'auto' as const, 'aria-label': name, 'aria-required': !!f.required, 'aria-invalid': wrong, placeholder: name + (f.required ? ' *' : ''), value, title: wrong ? problemWith(f, value) : f.type === 'number' ? NUMBER_HINT : undefined };
    return (
      <div key={f.id} {...common}>
        {isMulti(f)
          ? <textarea {...shared} onChange={(e) => set(f.id, e.target.value)} />
          : <input {...shared} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} onChange={(e) => set(f.id, e.target.value)}
              {...(f.type === 'date' ? { autoFocus: dateOpen === f.id, onFocus: () => setDateOpen(f.id), onBlur: () => setDateOpen(null) } : {})} />}
      </div>
    );
  };

  // The pointer goes above the field, or else below it or beside it: wherever it covers none of the page's own words
  // and no other field (see placeFlag). Until the words of the page have been read, and on a scan, which has none to
  // read, only the other fields count.
  const flagSide: FlagSide = !nextField ? 'above' : (() => {
    const p = printed?.key === flagKey ? printed : null;
    const others = [...data.others, ...fields].filter((g: any) => g.id !== nextField.id && g.document_id === nextField.document_id && g.page === nextField.page);
    return placeFlag(nextField, p ? { w: 104 / p.w, h: 27 / p.h } : { w: 0.3, h: 0.045 }, p ? { x: 10 / p.w, y: 8 / p.h } : { x: 0.025, y: 0.012 }, [...(p?.boxes || []), ...others]);
  })();
  const flagAt = (f: any) => (flagSide === 'right' ? { left: `${(f.x + f.w) * 100}%`, top: `${(f.y + f.h / 2) * 100}%` }
    : flagSide === 'left' ? { left: `${f.x * 100}%`, top: `${(f.y + f.h / 2) * 100}%` }
    : { left: `min(${f.x * 100}%, calc(100% - 8.5em))`, top: `${(f.y + (flagSide === 'below' ? f.h : 0)) * 100}%` });

  // This person's fields on one page. Radio buttons that belong together are wrapped as one group with its name, so
  // a screen reader announces the group. The wrapper takes no room: every field places itself on the page.
  const pageFields = (docId: string, page: number) => {
    const here = fields.filter((f) => f.document_id === docId && f.page === page);
    const grouped = (f: any) => f.type === 'radio' && !f.readonly;
    return (
      <>
        {here.filter((f) => !grouped(f)).map(docField)}
        {[...new Set(here.filter(grouped).map(groupKey))].map((key) => {
          const members = here.filter((f) => grouped(f) && groupKey(f) === key);
          return <div key={key} role="radiogroup" aria-label={members[0].group_name || 'Choose one'} aria-required={members.some((m) => m.required)}>{members.map(docField)}</div>;
        })}
      </>
    );
  };

  const overlay = (docId: string) => (page: number) => (
    <>
      {/* Everything already on the page that is not this person's to fill in: the sender's own wording, whoever it
          is assigned to, and what people who have finished put there. */}
      {data.others.filter((f: any) => f.document_id === docId && f.page === page).map((f: any) => (
        <div key={f.id} dir="auto" className={`field other${isBox(f) ? ' box' : ''}${strikeClass(f)}`} style={pos(f)} title={otherSource(f, sender.name)}>
          {f.image ? <img src={f.image} alt="Signature of another signer" /> : isBox(f) ? (f.value === '1' ? '✓' : '') : f.value}
        </div>
      ))}
      {pageFields(docId, page)}
      {nextField && nextField.document_id === docId && nextField.page === page && !sheet && (
        <span className={`sg-flag ${flagSide}`} aria-hidden="true" style={flagAt(nextField)}>
          {FLAG[nextField.type] || 'Fill in here'}
        </span>
      )}
    </>
  );

  const ctx: FieldCtx = { me, values, sig, ini, dateText, dateFormat: env.date_format, ordered, uploading, filled, set, pickRadio, clickSig, attach };
  const signed = byId(signedField);
  const sheetField = byId(sheet);
  const sheetTarget = sheetField && nextAfter(sheetField.id);

  return (
    <Shell data={data} bar={bar} bottom={bottom} footer={report} titleIsHeading live={live} helpInNewTab>
      {notice}
      {/* A field that appears or goes because of an answer is said to a screen reader (useLiveLogic). */}
      <p className="sg-vh" role="status" aria-live="polite">{logic.said}</p>
      {changedOpen && (
        <div className="notice warn sg-top" role="alert">
          <b>{sender.name} changed this document while you had it open.</b> Nothing was signed. What you filled in is still here wherever its field still exists. Look at the document again before you finish.
          {data.changed ? ` What changed: ${data.changed}` : ''}{' '}
          {/* The pages below are the changed ones once they have loaded. Until then there is nothing to have looked at. */}
          {allShown ? <button type="button" className="sg-link" onClick={() => setChangedOpen(false)}>I have looked</button> : <span role="status">The changed pages are loading. You can finish once they are on your screen.</span>}
        </div>
      )}
      {me.signed_before && !changedOpen && (
        <div className="notice warn sg-top" role="status">
          <b>{sender.name} changed this document after you {acts ? 'signed' : me.role === 'approver' ? 'approved' : 'viewed'} it on {fmtDate(me.signed_before, true)}.</b> What you did then no longer counts, and it is kept on record together with the change.
          Look at the document again and {acts ? 'sign' : me.role === 'approver' ? 'approve' : 'confirm'} again if you agree. Your earlier answers are still filled in for you to check.
          {data.changed ? ` What changed: ${data.changed}` : ''}{' '}
          {/* What they signed the first time is kept exactly as it was, and is theirs to download. */}
          {me.earlier_copy && <a className="sg-link" href={`${downloadUrl}?earlier=1`}>Download the document as you {acts ? 'signed' : me.role === 'approver' ? 'approved' : 'viewed'} it the first time</a>}
        </div>
      )}
      {me.role === 'inperson' && <div className="notice warn sg-top">In-person signing for <b>{me.name}</b>. Hand them the device now. {SIGNING_ONLINE}</div>}
      <WitnessNotice me={me} />{/* who witnesses, or what the witness confirmed (sign/Witness.tsx) */}
      <p className="sg-guide" id="sg-guide">
        {!acts ? (me.role === 'approver' ? 'Read the document, then choose Approve. To say no, choose Decline to approve from Other actions.' : 'Read the document, then choose Mark as viewed.')
          : hasNext ? <>Choose <b>Next</b> and we take you to each place that needs you, one at a time.</>
          : <>Everything needed is filled in. Choose <b>Finish</b> to check it and send.</>}
        {/* Finish is switched off until the pages of the document, as it is now, are on the screen. Said here, so a
            button that does nothing is never the only sign of it. */}
        {!allShown && !hasNext && <> The document is still loading: you can {acts ? 'finish' : me.role === 'approver' ? 'approve' : 'confirm'} as soon as its pages are on your screen. If they do not appear, reload this page.</>}
      </p>
      {/* Said once, before the pages, to someone who cannot see them: the Document view shows each page as a picture. */}
      {view === 'doc' && <p className="sg-vh">The pages below are shown as pictures, with your fields placed on them. To have the whole document read as text, with the same fields as an ordinary form, choose Text view, the next button.</p>}
      <div className="sg-tools">
        <div className="sg-seg" role="group" aria-label="How to read the document">
          <button type="button" aria-pressed={view === 'doc'} onClick={() => chooseView('doc')}>Document</button>
          <button type="button" aria-pressed={view === 'text'} onClick={() => chooseView('text')}>Text view</button>
        </div>
        {view === 'doc' && <ZoomControl zoom={zoom} onZoom={setZoom} />}
        <a className="btn" href={downloadUrl}><Icon name="download" /> Download</a>
        <button type="button" className="btn" aria-haspopup="dialog" onClick={go('ask')}><Icon name="mail" /> Questions and comments</button>
      </div>

      {view === 'doc' ? (
        <div className={`stack sg-doc sg-pan${zoom > 1 ? ' zoomed' : ''}`}>
          {data.documents.map((d: any) => (
            <div key={d.id}>
              {data.documents.length > 1 && <h2 className="sg-docname">{d.name}</h2>}
              {/* The address and the key carry the fingerprint of the file. A file the sender replaced is fetched and
                  drawn afresh, and onShown says when its first page is really on the screen. */}
              <PdfDoc key={d.sha256 || d.id} url={docUrl(base, d)} zoom={zoom} overlay={overlay(d.id)} onShown={() => markShown(d)} onDocument={(pdf) => { pdfs.current[d.id] = pdf; setPdfReady((n) => n + 1); }}
                failed={(why, retry) => <NoViewer why={why} retry={retry} sender={sender.name} downloadUrl={downloadUrl} onAsk={go('ask')} />} />
            </div>
          ))}
        </div>
      ) : (
        <TextView documents={data.documents} urlFor={(id) => docUrl(base, data.documents.find((d: any) => d.id === id) || { id })} onShown={markShown} senderName={sender.name} onAsk={go('ask')}
          fields={(docId, page, near) => <PageFields docId={docId} page={page} c={ctx} near={near} />}
          others={(docId, page, near) => <PageOthers others={data.others.filter((f: any) => f.document_id === docId && f.page === page)} senderName={sender.name} near={near} />} />
      )}
      <p className="muted small center sg-envelope">Envelope {env.id}{env.expires_at ? ` · open until ${momentText(env.expires_at, deviceZone())}` : ''} · Signing on screen saves about {fmtNum(env.impact.sheets)} sheets of paper.</p>

      {sheetField && (
        <FieldSheet field={sheetField} dateFormat={env.date_format} value={values[sheetField.id] || ''} onChange={(v) => set(sheetField.id, v)} onDone={() => setSheet(null)} onNext={sheetTarget ? () => sheetNext(sheetField.id) : undefined} />
      )}
      {signed && (
        <SignedFieldDialog kind={signed.type} image={(signed.type === 'signature' ? sig : ini) || ''} onClose={() => setSignedField(null)}
          onClear={() => { set(signed.id, ''); setSignedField(null); }}
          onChange={() => { setSignedField(null); changeMark(signed.type); }} />
      )}
      {menuDialog}
      {dialogs}
      {open === 'review' && (
        <ReviewDialog me={me} sender={sender} items={items} sig={sig} ini={ini} approving={me.role === 'approver'} busy={busy} error={finishError}
          note={<>{questions > 0 ? <OpenQuestion sender={sender.name} onShow={go('ask')} /> : null}<WitnessName me={me} base={base} onNamed={load} /></>}
          usesSig={fields.some((f) => f.type === 'signature' && filled(f))} usesIni={fields.some((f) => f.type === 'initials' && filled(f))}
          onChangeSig={changeMark} onBack={() => setOpen('')} onFinish={complete}
          printCheck={() => api(`${base}/print-check`, { body: { values } })}
          onRename={async (name) => {
            // A name that reads like a different person's is not changed: the sender is asked instead, and the
            // answer says so in words. Those words are handed back to be shown under the name.
            const r = await api(`${base}/name`, { body: { name } });
            if (r?.applied === false) return String(r.message || 'We did not change it, and asked the sender instead.');
            // A new spelling is a newer version of the envelope. This page made the change and shows it, so it
            // carries on with that version. Anyone else who has the page open is asked to look again.
            if (r?.version != null) version.current = r.version;
            who.current = r?.name || name; // the same person under a corrected spelling: their marks in this tab stay
            setData((d: any) => (d ? { ...d, version: r?.version ?? d.version, recipient: { ...d.recipient, name: r?.name || name } } : d));
            return '';
          }} />
      )}
      {adopt && (
        <AdoptSignature kind={adopt.kind} name={me.name} saved={adopt.saved} onClose={() => setAdopt(null)}
          onDone={(png) => {
            if (adopt.kind === 'signature') setSig(png);
            else setIni(png);
            // Made, or looked at and confirmed, in this tab: from here on a tap puts it on a field directly.
            setSeen((s) => ({ ...s, [adopt.kind]: true }));
            if (adopt.field) set(adopt.field, '1');
            setAdopt(null);
          }} />
      )}
    </Shell>
  );
}
