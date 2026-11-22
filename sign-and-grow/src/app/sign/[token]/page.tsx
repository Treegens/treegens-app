'use client';
import { cloneElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, toast, fmtDate } from '@/components/ui';
import { PdfDoc } from '@/components/PdfDoc';
import { HandBack } from '@/components/HandBack';
import { AdoptSignature, type SavedMark } from '@/components/SignaturePad';
import { formatDate, formatDateValue, deviceZone } from '@/lib/dates';
import { consentWording } from '@/lib/policy';
import { NUMBER_HINT } from '@/lib/numbers';
import { twoWaysUnderField } from '@/lib/twoways';
import { Shell, StateCard, Sender, Icon, useMedia, bringIntoView } from '@/components/sign/parts';
import { TreeLine, SignerDone } from '@/components/impact/SignerTrees';
import { PurgedLink } from '@/components/sign/PurgedLink';
import { ReplacedLink, UnknownLink, LoadProblem } from '@/components/sign/deadEnds';
import { PausedLink } from '@/components/sign/Paused';
import { CodeCheck } from '@/components/sign/CodeCheck';
import { MenuDialog, ReportDialog, DeclineDialog, ReassignDialog, SignedFieldDialog, ReviewDialog, FieldSheet, type MenuItem } from '@/components/sign/dialogs';
import { HelpChat } from '@/components/HelpChat';
import { TextView } from '@/components/sign/TextView';
import { PageFields, PageOthers, otherSource, type FieldCtx } from '@/components/sign/TextFields';
import { SharedNotes, sharedSaid, ownAnswers, needsInitials, INITIALS_FIRST, autosaved, LockedShared } from '@/components/sign/SharedNotes';
import { AUTO, TYPED, fieldName, groupKey, isBox, isMulti, buildItems, problemWith, pos, readKept, writeKept } from '@/components/sign/fields';
import { useLiveLogic } from '@/components/sign/logic';
import { keepTitle, accountMarks, tapOnMark, restoreMarks, saveBody, placeFlag, type Marks, type Box, type FlagSide } from '@/components/sign/fields';
// Drawing, Approve and Decline on the page, first and last name, dates from dates, same answer, text style (fieldkinds).
import { kindField, useDrawing } from '@/components/sign/KindFields';
import { spreadLinked, lookCss, lookOf } from '@/lib/fieldkinds';
import { docUrl, allOnScreen, finishProblem, inputLimit, amountHint, lengthHint, boxRuleHint } from '@/components/sign/fields';
import { strikeClass } from '@/lib/strike';
import { pageBoxes } from '@/components/sign/pdfText';
import { NoViewer } from '@/components/sign/NoViewer';
import { isConnectionError, isAlreadyFinished, finishLanded, finishNotSent, finishUnknown, saveNotSent, keepAnswers, readAnswers, dropAnswers, FINISH_RETRY_MS } from '@/components/sign/offline';
import { CANNOT_REACH, sameFieldAgain } from '@/components/sign/stuck';
import { SIGNING_ONLINE } from '@/lib/mobile';
import { PayLink } from '@/components/sign/PayLink';
import { PayNow, PayAhead, PayAfter } from '@/components/sign/PayNow';
import { NoEmailDone, NoEmailWait } from '@/components/sign/NoEmail';
import { moreTimeWords, laterWords } from '@/lib/bysender';
// "Questions and comments": the one way to ask the sender something, and the note before Finish (Comments.tsx).
import { CommentsDialog, OpenQuestion, useMyQuestions } from '@/components/sign/Comments';
import { MailAgain } from '@/components/sign/MailAgain';
import { NextPerson, FormCleared } from '@/components/sign/SharedDevice';
import { CounterDone } from '@/components/sign/CounterDone';
import { CounterCopy, CounterWait } from '@/components/counter/SignParts';
import { witnessFirst, WitnessFirst, WitnessNotice, WitnessName, WitnessAfter } from '@/components/sign/Witness';
import { stepFirst, NameNext } from '@/components/sign/NameNext';
import { changerWords, isStepRole, stepLaterWords } from '@/lib/recipienttypes';
// A document sent to a signing group: what this member's own link is to the group (src/server/groups.ts).
import { GroupAway, GroupConsentNote, HandBackDialog, groupAway, groupDeclineText, groupNoteId } from '@/components/sign/GroupNotice';
// Someone signing for a person who is away, and that person's own link (src/server/delegation.ts).
import { DelegateAway, DelegateConsentNote, delegateAway, delegateNoteId, delegateWaiting } from '@/components/sign/DelegateNotice';
// A stamp field: the signer puts their own stamp on, printed like ink (src/components/stamps, src/server/stamps.ts).
import { StampDialog, sameStampOf } from '@/components/stamps/StampDialog';
import { stampTurn, turnStyle } from '@/lib/stamps';
import { layers } from '@/lib/stacked';
// The page made simpler: Other actions in one order, Finish that signs unless something needs a look, Next that opens.
import { otherActions, bySwitches, lookAgain, nextOpens, nameDiffers, laterAtConsent, laterLabel, reviewTitle, witnessPlaces, GUIDE_NEXT, GUIDE_FINISH, FLAG_MARGIN, type ActionKey } from '@/components/sign/actions';
import { ConsentTop } from '@/components/sign/ConsentTop';
import { SummaryLink } from '@/components/sign/Summary';
import { Supplements, focusAlso, NO_ALSO, type AlsoLeft } from '@/components/sign/Supplements';
import { readTypedName, writeTypedName } from '@/components/sign/typedName';
import { FixName } from '@/components/sign/dialogs';
import { MoreButton, MoreDialog } from '@/components/sign/More';
// Easy reading: the first use of each view goes to the audit trail, and "See this on the page" (sign/readview.ts).
import { noteView, showOnPage, focusEasy, backToPart, partId } from '@/components/sign/readview';
import { NameDialog } from '@/components/sign/NameDialog';
import { yourMoment } from '@/lib/dates';
// The account's own consent text under ours, and "Sign on paper instead" (sign/OwnTerms.tsx, sign/Withdraw.tsx).
import { OwnTermsBlock } from '@/components/sign/OwnTerms';
// Printing it, signing by hand and sending back a photo, when the sender's account offers it (sign/Paper.tsx).
import { PaperChoice, PaperScreen, PaperAskedNote, paperFirst, withPrint } from '@/components/sign/Paper';
import { t } from '@/lib/i18n';
// Inside a frame on the sender's own website: what happened is told to that website alone (sign/frame.ts).
import { frameBody, tellFrame } from '@/components/sign/frame';
import { codeForgottenInFrame, OwnTabLink } from '@/components/sign/FrameTab';
import { FRAME_CODE_LOST } from '@/lib/embed';
// The words of this page in the signer's language, and refusals said from their code (src/lib/signlang.ts).
import { signT, shownError, consentNote, signLangAttr } from '@/lib/signlang';
import { useSignLang, richText } from '@/components/sign/lang';
// An account's "Sign out after N minutes": the link is checked again after a break that long (sign/away.ts).
import { useAwayCheck } from '@/components/sign/away';
import { isPreviewToken, PREVIEW_NOTHING } from '@/lib/preview';
import { PreviewProblem } from '@/components/sign/PreviewProblem';
import { previewT } from '@/components/sign/PreviewBand';
import { doneLine, doneActions } from '@/lib/simplicity';

type Save = 'idle' | 'pending' | 'saving' | 'saved' | 'error';
type Open = '' | 'menu' | 'more' | 'name' | 'decline' | 'reassign' | 'ask' | 'report' | 'review' | 'handback' | 'help' | 'paper';
const SAVE_TEXT: Record<Save, string> = { idle: 'Saves as you go', pending: 'Saving', saving: 'Saving', saved: 'Saved', error: 'Not saved yet' };
const FLAG: Record<string, string> = { signature: 'Sign here', initials: 'Initial here', checkbox: 'Tick here', radio: 'Choose one', dropdown: 'Choose here', attachment: 'Attach here', stamp: 'Stamp here' };
// Phones, and anything else used mainly by touch, get a sheet with a large input instead of typing into the page.
// Typing straight into a small box makes touch browsers zoom in and out.
const TOUCH = '(max-width: 600px), (pointer: coarse)';

export default function SignPage() {
  const { token } = useParams<{ token: string }>();
  // A sender's "See what each person sees" talks to /preview/..., where nothing is recorded or sent (PreviewBand.tsx).
  const base = isPreviewToken(token) ? `/preview/${token}` : `/sign/${token}`;
  const [data, setData] = useState<any>(null);
  const [problem, setProblem] = useState<{ status: number; message: string; code?: string; day?: string } | null>(null);
  const [handedTo, setHandedTo] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [sig, setSig] = useState<string | null>(null);
  const [ini, setIni] = useState<string | null>(null);
  // How the signature and initials were made here, for the certificate (src/lib/switches.ts howText).
  const hows = useRef<{ signature_how?: string; initials_how?: string }>({});
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
  // The stamp field whose dialog is open (StampDialog).
  const [stampFor, setStampFor] = useState<string | null>(null);
  // How far the page turns each stamp put on in this visit (its natural tilt): from the answer that put it on.
  const [turns, setTurns] = useState<Record<string, number>>({});
  const [sheet, setSheet] = useState<string | null>(null);
  // The date field whose picker is open. A date that was picked is otherwise shown the way it will be printed.
  const [dateOpen, setDateOpen] = useState<string | null>(null);
  const [view, setView] = useState<'doc' | 'text'>('doc');
  // Easy reading (sign/readview.ts): the part a person left with "See this on the page", to come back to, and the
  // views that really were on the screen, for the audit trail.
  const [back, setBack] = useState<{ doc: string; id: string } | null>(null);
  const [seenIn, setSeenIn] = useState<{ page?: boolean; easy?: boolean }>({});
  const sawIn = useCallback((v: 'page' | 'easy') => setSeenIn((s) => (s[v] ? s : { ...s, [v]: true })), []);
  // The size of the pages: 1, 1.5 or 2 times the width of the screen (Zoom.tsx).
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  const [agree, setAgree] = useState(false);
  // Agreed on this visit: an account that asks every time the link is opened shows the consent screen until then.
  const [agreedHere, setAgreedHere] = useState(false);
  const [code, setCode] = useState('');
  const [askedCode, setAskedCode] = useState<'' | 'busy' | 'asked'>('');
  const [formError, setFormError] = useState('');
  const [finishError, setFinishError] = useState('');
  // A number refused at Finish because it reads two ways (src/lib/twoways.ts): said under that field until it is retyped.
  const [askAgain, setAskAgain] = useState<{ id: string; value: string; text: string } | null>(null);
  const [finished, setFinished] = useState<any>(null);
  const [save, setSave] = useState<Save>('idle');
  const [muted, setMuted] = useState(false);
  // 'code': the "stop reminders" link was followed to a document behind a one-time code, which is asked for first.
  const [muteNote, setMuteNote] = useState<'' | 'done' | 'failed' | 'code'>('');
  // A Finish that waits for a payment ("pay before finishing", sign/PayNow.tsx): the Pay screen instead of the document.
  const [payWait, setPayWait] = useState(false);
  const waitPay = useCallback(() => setPayWait(true), []);
  const [moreTime, setMoreTime] = useState<'' | 'busy' | 'asked'>('');
  // After "Finish later": where the way back is, with "Stop reminder emails" next to it (it left Other actions).
  const [later, setLater] = useState('');
  // The name typed for the signature, when it was typed: one that is not the name on the document is a name to fix.
  const [typedName, setTypedName] = useState<string | null>(null);
  // Kept in the tab with the signature itself, so a reload does not lose the "Check your name" step (typedName.ts).
  useEffect(() => setTypedName(readTypedName(token)), [token]);
  // What the check of the characters found when Finish was pressed, or that it could not be made: said in the step.
  const [checkFailed, setCheckFailed] = useState(false);
  const [wantCopy, setWantCopy] = useState(false);
  // Set when the sender changed the document while this page was open: the page has loaded the new version and
  // asks the person to look again before they finish.
  // true: the sender changed the document. Text: what else changed under the screen, in the server's words.
  const [changedOpen, setChangedOpen] = useState<boolean | string>(false);
  // Which file of each document is on this screen right now: the fingerprint of the file whose pages are drawn, or
  // read out in the text view. When the sender replaces a file, the page loads the new one, and Finish does not
  // work until its pages are here. Nobody finishes on pages they were not shown.
  const [onScreen, setOnScreen] = useState<Record<string, string>>({});
  const markShown = useCallback((d: any) => setOnScreen((s) => (s[d.id] === (d.sha256 || '') ? s : { ...s, [d.id]: d.sha256 || '' })), []);
  const touch = useMedia(TOUCH);
  // The content version this page shows. It goes back with consent, every save and Finish, and the server refuses
  // a save or a Finish that comes from an older version than the one on the envelope.
  const version = useRef<number | null>(null);
  // The entries of Other actions as this screen shows them, for the buttons under a Help answer (HelpChat.tsx).
  const helpActs = useRef<MenuItem[]>([]);

  const valuesRef = useRef(values);
  // The fields as last loaded, for the autosave (a change that asks others to sign again waits for Finish).
  const heldFields = useRef<any[]>([]);
  heldFields.current = data?.fields || [];
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
  const questions = useMyQuestions(base, !!data?.fields && open !== 'ask' && !delegateWaiting(data), open === 'review');

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
        setValues((prev) => (unsaved ? { ...server, ...ownAnswers(d.fields, Object.fromEntries(Object.entries(prev).filter(([id]) => id in server))) } : tabKept ? { ...server, ...ownAnswers(d.fields, tabKept) } : server));
        lastSaved.current = start.baseline;
      }
    } catch (e: any) {
      const status = e?.status || 0;
      if (status === 404 || status === 410) setData(null);
      setProblem({ status, message: e?.message || 'Something went wrong on our side.', code: e?.code, day: e?.data?.deleted_on });
    }
  }, [base, token]);
  useEffect(() => {
    load();
  }, [load]);
  // Paused by its sender while this page was open: load again, so the paused card shows (src/server/timing.ts).
  useEffect(() => {
    window.addEventListener('sg:paused', load);
    return () => window.removeEventListener('sg:paused', load);
  }, [load]);
  // The language of this page: the header menu's choice in this tab, else the server's (src/components/sign/lang.tsx).
  const lang = useSignLang(data);
  const T = (key: string, vars?: Record<string, string | number>) => signT(lang, key, vars);
  const awayLine = useAwayCheck(base, data?.away_minutes, data?.language?.locale, { status: data?.envelope?.status, version: data?.version, done: data?.recipient?.status === 'completed' }, load);

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
      // Remembered for this link only: on a shared computer the next person's document opens on its pages.
      if (localStorage.getItem(`sg:view:${base}`) === 'text') setView('text');
    } catch {
      /* no storage: start in the document view */
    }
  }, [base]);
  function chooseView(v: 'doc' | 'text') {
    setView(v);
    // Into Easy reading the focus follows: back to the part left for "See this on the page", or to its banner.
    if (v === 'text') {
      if (back) backToPart(back.id);
      else focusEasy();
      setBack(null);
    }
    try {
      localStorage.setItem(`sg:view:${base}`, v);
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
      if (e?.code === 'code_first') return void (fromEmail ? setMuteNote('code') : toast(e.message, true));
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
  // Behind a one-time code the reminders stop once the code is typed (POST /sign/:token/mute asks for it first).
  useEffect(() => {
    if (muteNote === 'code' && data && !data.locked) mute(true);
  }, [muteNote, data, mute]);

  const me = data?.recipient;
  const env = data?.envelope;
  const allShown = allOnScreen(data?.documents, onScreen);
  // "Only show when" and formulas, live: hidden fields are left out, a calculated one holds its result (logic.ts).
  const ownFields: any[] = useMemo(() => data?.fields || [], [data?.fields]);
  // Formulas count other people's fields exactly as the server does: the ones it gives in formula_inputs.
  const otherFields: any[] = useMemo(() => data?.formula_inputs || data?.others || [], [data?.formula_inputs, data?.others]);
  const logic = useLiveLogic(ownFields, otherFields, values, setValues);
  const fields: any[] = logic.fields;
  // Of two fields that overlap, the smaller is drawn on top, so both can be tapped (layers in src/lib/stacked.ts).
  const layered = useMemo(() => layers(fields), [fields]);
  // A witness signs too, in a block of their own, after a statement of their own (sign/Witness.tsx).
  const acts = me?.role === 'signer' || me?.role === 'inperson' || me?.role === 'witness';
  const closed = !!env && (env.status === 'voided' || env.status === 'declined' || env.status === 'expired' || me.status === 'declined');
  const iAmDone = !!finished || me?.status === 'completed';
  // A closed or not-yet-ready document says so straight away, before anyone is asked for an access code.
  // `wantCopy`: someone who signed a document that was closed later asks for their copy, and it is behind an access
  // code that this browser has not been given (or no longer remembers). Then the code is asked for after all.
  const stage = handedTo ? 'handed' : !data ? (problem ? 'problem' : 'loading') : closed && !(wantCopy && data.locked) ? 'closed' : env?.paused && !iAmDone ? 'paused' : me.status === 'pending' ? 'pending' : data.locked ? 'locked' : iAmDone ? 'done' : data.preview && agreedHere ? 'sign' : !me.consented || (data.own_terms?.each_visit && !agreedHere) ? 'consent' : 'sign';
  canSave.current = stage === 'sign' && acts && fields.length > 0;
  // The first use of the pages and of Easy reading, for the audit trail and the certificate (sign/readview.ts).
  useEffect(() => {
    // Only once that view really was on the screen: the pages drawn, or the words of Easy reading read.
    if (stage !== 'sign' || data?.preview) return;
    if (seenIn.page) noteView(base, 'page');
    if (seenIn.easy) noteView(base, 'easy');
  }, [stage, seenIn, base, data?.preview]);

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

  // Typing in a field fills the fields that share its answer too (spreadLinked in src/lib/fieldkinds.ts).
  // A field anyone can fill in that asks for initials on a change asks for them first (sign/SharedNotes.tsx).
  const set = useCallback((id: string, v: string) => (needsInitials(ownFields, id, ini) ? (toast(INITIALS_FIRST), changeMark('initials')) : setValues((s) => spreadLinked(ownFields, s, id, v))), [ownFields, ini]); // eslint-disable-line react-hooks/exhaustive-deps
  const drawing = useDrawing(set);
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
    // A change to a field anyone can fill in that asks others to sign again is not autosaved: it goes with Finish (SharedNotes.tsx).
    let body: any = { ...saveBody(valuesRef.current, version.current, kept.current, savedMarks.current), ...hows.current };
    if (leaving && JSON.stringify(body).length > 60_000) body = saveBody(valuesRef.current, version.current, savedMarks.current, savedMarks.current);
    body.values = autosaved(heldFields.current, body.values);
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
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw Object.assign(new Error(j.error || ''), { status: res.status, code: j.code, why: j.why });
      }
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
        // The last step before sending (the check at Finish) is closed too: it must never be taken on top of a
        // document that changed underneath it. The person sees the notice and the new pages first.
        setOpen((o) => (o === 'review' ? '' : o));
        // Someone else changed a field anyone can fill in: the server's own words say who and what (collab.ts).
        setChangedOpen(e?.why === 'shared' && e.message ? e.message : true);
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

  /** Whether Next opens this field as well as going to it: a signature, initials or stamp still to be made (actions.ts). */
  function opensOnNext(f: any) {
    const kind = f.type as 'signature' | 'initials';
    const ready = (kind === 'signature' || kind === 'initials') && tapOnMark({ current: kind === 'signature' ? sig : ini, seen: seen[kind], account: account[kind] }).apply;
    return nextOpens(f, filled(f), ready);
  }
  function goTo(f: any, open = false) {
    // Next opens what a tap would only have opened anyway: the signature dialog, or the stamp. It goes there first.
    if (open && opensOnNext(f)) {
      const at = document.getElementById(`${view === 'text' ? 't' : 'f'}-${f.id}`);
      if (at) bringIntoView(at, 0.42);
      return f.type === 'stamp' ? setStampFor(f.id) : clickSig(f);
    }
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
    if (sheet || adopt || open || signedField || stampFor || !afterClose.current) return;
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

  // Nothing required is left: Finish glows once where it is. No dialog opens by itself (research/ux-charter.md, P9).
  // Files given to read that still have to be opened or ticked count as places left (sign/Supplements.tsx).
  const [also, setAlso] = useState<AlsoLeft>(NO_ALSO);
  const ready = stage === 'sign' && acts && required.length > 0 && left.length === 0 && also.left === 0 && allShown;

  async function pressFinish() {
    if (!allShown) return toast(NOT_SHOWN, true);
    if (me.role === 'viewer') return complete();
    // A field that needs another look, or a group of tick boxes whose rule is not met (src/lib/fieldrules.ts).
    const stop = acts ? finishProblem(ordered, values, env.date_format) : null;
    if (stop) {
      const wrong = stop.field;
      // On a phone the field opens in its sheet, which says what is wrong right under the input.
      if (!usesSheet(wrong)) toast(`${wrong.type === 'checkbox' && wrong.group_name ? wrong.group_name : fieldName(wrong)} needs another look. ${stop.text}`, true);
      return goTo(wrong);
    }
    setFinishError('');
    setFinishPending(false);
    // "Check before you finish" opens only when something needs another look (actions.ts): an unanswered question, a
    // witness to name, a typed signature under another name, or characters the signed PDF cannot print. Otherwise
    // Finish signs and sends at once, the way its words on the page say.
    setCheckFailed(false);
    if (lookAgain({ questions, witness: me.witness, typedName: sig ? typedName : null, name: me.name }).length) return setOpen('review');
    setBusy(true);
    // A check that could not be made is not a check that found nothing: the step opens and says so, and the person
    // decides. Nothing is signed behind a warning they were never shown.
    const unprintable = await api(`${base}/print-check`, { body: { values } }).then((r: any) => r?.problems?.length || 0, () => -1);
    setBusy(false);
    if (unprintable < 0) setCheckFailed(true);
    if (unprintable) return setOpen('review');
    complete();
  }

  async function complete() {
    // A preview signs nothing: Finish says so and the page stays as it is.
    if (data?.preview) return (setOpen(''), toast(PREVIEW_NOTHING));
    // The server refuses a Finish from an older version. This is the other half: the version this page sends is only
    // ever one whose pages it has drawn.
    if (!allShown) return (setOpen(''), toast(NOT_SHOWN, true));
    setBusy(true);
    setFinishError('');
    // Offline before anything is sent: only then is it known that nothing reached us (offline.ts).
    const offline = navigator.onLine === false;
    const finish = me.role === 'approver' ? 'Approve' : 'Finish';
    // What the page does once the server has this person's part, however that became known.
    const landed = (r?: any) => (canSave.current = false, writeKept(token, null, null), writeTypedName(token, null), dropAnswers(token), setFinishPending(false), setOpen(''), tellFrame('signing_complete'), r && setFinished(r));
    try {
      landed(await api(`${base}/complete`, { body: { values, signature_png: sig, initials_png: ini, ...hows.current, version: version.current, inputs: data?.inputs ?? null, tz: deviceZone(), sign_again: true, ...frameBody() } }));
    } catch (e: any) {
      const msg = e?.message || 'Something went wrong on our side.';
      // Said in "Check before you finish", opened for it when Finish went straight through: the message stays next to
      // the button, and a Finish that did not get through is sent again from there (see the effect by autosave).
      const say = (said: string) => (me.role !== 'viewer' ? (setOpen('review'), setFinishError(said)) : toast(said, true));
      if (e?.code === 'pay_first') {
        // Nothing is signed yet: the Pay screen, and the part completes once Stripe confirms (sign/PayNow.tsx).
        setOpen('');
        setPayWait(true);
        window.scrollTo({ top: 0 });
      } else if (isAlreadyFinished(e)) {
        // Sent again after a Finish that went through without its answer reaching us: done, not a mistake.
        landed();
        if (!finishPending) toast('You had already finished this document, so nothing more was sent.');
        await load();
      } else if (e?.code === 'number_two_ways' && fields.some((f: any) => f.id === e?.data?.field_id)) {
        // Said under the field itself, which is opened, not in the dialog away from it.
        const f = fields.find((x: any) => x.id === e.data.field_id);
        setAskAgain({ id: f.id, value: values[f.id] || '', text: twoWaysUnderField(msg) });
        if (view === 'text') toast(msg, true);
        afterClose.current = f;
        setOpen('');
      } else if (e?.code === 'sign_way_off') {
        // The ways to make a signature are fewer than this page was loaded with: it offers only those from now on.
        if (Array.isArray(e?.data?.ways)) setData((d: any) => (d ? { ...d, switches: { ...(d.switches || {}), ways: e.data.ways } } : d));
        hows.current = {};
        say(msg);
      } else if (e?.code === 'form_waits') {
        // A public form with no signature free: the server's own sentence says what happens next. Not sent again.
        setFinishPending(false);
        say(msg);
      } else if (isConnectionError(e) || e?.status >= 500) {
        // No answer, or an error from our side that may have come after the signature was recorded: ask the server
        // before saying anything, and never say "nothing was signed" without knowing it. Tried again by itself when
        // the connection is back (the effect next to autosave). Never the browser's own "Failed to fetch".
        const now = offline ? 'open' : await finishLanded(() => api(base));
        if (now === 'done') return void (landed(), await load());
        setFinishPending(isConnectionError(e) || now === 'unknown');
        say(now === 'unknown' ? finishUnknown(navigator.onLine !== false, finish) : isConnectionError(e) ? finishNotSent(!offline, finish) : `${msg} Nothing was signed. Try again in a moment.`);
      } else if (e?.code === 'changed') {
        // Nothing was signed. Show the document as it is now, with the answers that still have a field, and ask
        // for another look before finishing. Someone else who finished meanwhile is said in the server's own words
        // ("why": "inputs"): it was not the sender, and the total worked out for this person changed with it.
        setOpen('');
        setChangedOpen(e?.data?.why === 'inputs' || e?.data?.why === 'shared' ? msg : true);
        await load();
        window.scrollTo({ top: 0 });
      } else if (e?.code === 'supplements_missing') {
        // A file given to read still has to be opened or ticked (the file was replaced meanwhile, say): the list is
        // loaded again from the server and says it in place, above the document, with no toast over it.
        setOpen('');
        await load();
        requestAnimationFrame(focusAlso);
      } else if (/no longer open|not your turn/i.test(msg)) {
        setOpen('');
        toast(msg, true);
        await load();
      } else if (me.role !== 'viewer') say(`${msg} Go back, put it right, then finish again.`);
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
    // The sender's retention rule or their own request purged it (src/server/records.ts).
    if (isPreviewToken(token)) return <PreviewProblem message={problem.message} />;
    if (problem.code === 'purged') return <PurgedLink day={problem.day} />;
    if (problem.code === 'counter_id_first') return <CounterWait message={problem.message} onRetry={load} />;
    if (problem.code === 'kept_copy') return <Shell><StateCard tone="ok" title="You passed this on"><p>{problem.message}</p></StateCard></Shell>;
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
  const notice = <><MailAgain base={base} stopped={!!me.mail_stopped} why={me.mail_stopped_why} />{awayLine && <div className="notice sg-top" role="status">{awayLine}</div>}{muteNote === 'done' ? (
    <div className="notice sg-top" role="status">
      <b>Reminders are off.</b> We will not send you any more reminder emails about this document.{stillOpen ? ` You can still ${acts ? 'sign' : 'open'} it here whenever you are ready.` : ''}
    </div>
  ) : muteNote === 'code' ? (
    <div className="notice sg-top" role="status"><b>Reminders stop once the code is typed.</b> {sender.name} asked us to check who opens this document, so the code below comes first. We stop the reminder emails straight after.</div>
  ) : muteNote === 'failed' ? (
    <div className="notice warn sg-top" role="alert">We could not turn off reminders just now. <button type="button" className="sg-link" onClick={() => mute(true)}>Try again</button></div>
  ) : null}</>;
  // "Fix my name", wherever it is offered: on the name on the document, in Pass to someone else, in the check at Finish.
  const rename = async (name: string) => {
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
  };
  const dialogs = (
    <>
      {open === 'report' && <ReportDialog base={base} sender={sender} onClose={() => setOpen('')} />}
      {/* The help chat opens from Help in the top bar, never floating over Finish or the fields (components/HelpChat.tsx). */}
      {open === 'help' && <HelpChat screen="signing" link={token} code={data.help_code} who={me.role !== 'inperson' && me.email ? { name: me.name, email: me.email } : null} actions={() => helpActs.current} onClose={() => setOpen('')} />}
      {open === 'ask' && <CommentsDialog base={base} sender={sender} documents={data.documents || []} onClose={() => setOpen('')} />}
      {drawing.dialog}
      {open === 'decline' && <DeclineDialog base={base} sender={sender} note={groupDeclineText(data)} title={me.role === 'approver' ? 'Decline to approve' : isStepRole(me.role) ? 'Decline' : 'Decline to sign'} onClose={() => setOpen('')} onDone={() => { canSave.current = false; writeKept(token, null, null); setOpen(''); tellFrame('declined'); load(); }} />}
      {/* With signing on paper offered, the print and send steps too (sign/Paper.tsx); otherwise by post only (Withdraw.tsx). */}
      {open === 'paper' && <PaperChoice base={base} ps={me.paper_sign} byPost={!!data.own_terms} sender={sender} lang={data.language?.locale || 'en'} note={groupDeclineText(data)} onClose={() => setOpen('')} onDone={() => { canSave.current = false; writeKept(token, null, null); setOpen(''); load(); }} onSent={() => { setOpen(''); load(); }} />}
      {open === 'name' && <NameDialog name={me.name} approving={me.role === 'approver'} onRename={rename} onClose={() => setOpen('')} />}
      {open === 'reassign' && <ReassignDialog base={base} sender={sender} fixName={<FixName name={me.name} onRename={rename} />} onClose={() => setOpen('')} onDone={(name) => { canSave.current = false; writeKept(token, null, null); setOpen(''); setHandedTo(name); }} />}
      {open === 'handback' && <HandBackDialog base={base} data={data} onClose={() => setOpen('')} onDone={() => { canSave.current = false; writeKept(token, null, null); setOpen(''); toast(`Handed back to ${me.group?.name}. Nothing you filled in was kept.`); load(); }} />}
    </>
  );

  // A colleague in the group has the document, or the sender took this person out of the group: who has it, and
  // the one thing left to do here, which is to ask the sender (sign/GroupNotice.tsx).
  if (delegateAway(data) && stage !== 'locked')
    return (
      <Shell data={data} footer={report}>
        {notice}
        <DelegateAway data={data} />
        {dialogs}
      </Shell>
    );

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
            if (await codeForgottenInFrame(base)) return setFormError(FRAME_CODE_LOST);
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
          {formError === FRAME_CODE_LOST && <OwnTabLink />}
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
        <StateCard tone={expired ? 'warn' : mine && me.asked_paper && !voided ? 'mail' : 'stop'} title={voided ? `${sender.name} cancelled this document` : expired ? (env.form_cleared ? 'This form was cleared before it was finished' : 'This signing request has expired') : mine ? (me.asked_paper ? t(data.language?.locale, 'sign.paper.closed_title') : 'You declined this document') : 'This document was declined'}>
          {voided && <p>It was voided, so there is nothing for you to sign and nothing more to do.{env.void_reason ? '' : ` Contact ${sender.name} if you have questions.`}</p>}
          {voided && env.void_reason && <p className="sg-quote"><span className="muted small">Their reason</span>{env.void_reason}</p>}
          {!voided && !expired && <p>{mine && me.asked_paper ? t(data.language?.locale, 'sign.paper.closed_body', { sender: sender.name }) : mine ? `We told ${sender.name}. The document is closed and there is nothing more for you to do. Changed your mind? Ask them to send it again.` : 'One of the people asked to sign said no, so the document is closed. There is nothing more for you to do.'}</p>}
          {expired && env.form_cleared && <FormCleared slug={env.start_again} />}
          {expired && !env.form_cleared && (
            <>
              <p>The deadline{env.expires_at ? ` was ${yourMoment(env.expires_at, deviceZone())}` : ' has passed'}. {env.removed ? `${sender.name} has since removed this document from their list, so it cannot be opened again from here. If you still need to sign it, ask them to send it again.` : `Nothing is lost: ${sender.name} can open it again and you carry on from where you were.`}</p>
              {!env.removed && me.status !== 'completed' && me.status !== 'declined' && me.role !== 'cc' && (moreTime === 'asked' ? (
                <div className="notice sg-confirmed" role="status"><b>Done. We asked {sender.name} for more time.</b> {moreTimeWords(sender.name, !!me.link_by_sender).open}</div>
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
        {/* "Pay after finishing": the Pay screen first, with Not now going on to Done (sign/PayNow.tsx). */}
        <PayAfter base={base} token={token} on={acts}>
        <div className="stack">
          {/* In person, the device is not the signer's: the first thing the done screen says is to hand it back. */}
          {/* On the screen facing the person at a service counter there is no account to hand back: CounterDone below. */}
          {!env.counter?.screen && <>{inPerson && <HandBack signer={me.name} sender={sender.name} envelopeId={env.id} />}</>}
          <StateCard tone="ok" title={title}>
            {/* No address for someone whose link the sender passed on: nothing is emailed, so nothing is promised. */}
            {/* At a service counter the copy goes by email only: the link used there is closed (CounterCopy). */}
            {env.counter && inPerson && <CounterCopy allDone={allDone} />}
            {!(env.counter && inPerson) && <>{me.link_by_sender ? <NoEmailDone sender={sender.name} allDone={allDone} /> : <p style={{ overflowWrap: 'anywhere' }}>
              {doneLine({ allDone, inPerson, sender: sender.name, email: me.email })}
            </p>}</>}
            {/* Download is the one main button (charter 2.6); opening it in the browser is the plain second one (simplicity.ts). */}
            {!(env.counter && inPerson) && <div className="row wrap sg-actions">
              {doneActions(allDone).map((a) => a.key === 'download'
                ? <a key={a.key} className="btn primary lg" href={downloadUrl}><Icon name="download" /> {a.label}</a>
                : <a key={a.key} className="btn lg" href={`${downloadUrl}?inline=1`} target="_blank" rel="noreferrer"><Icon name="eye" /> {a.label}<span className="sg-vh"> (opens in a new tab)</span></a>)}
            </div>}
          </StateCard>
          {/* On the screen facing the person at a service counter: hand it back, then Next person (counter.ts). */}
          {env.counter?.screen && <CounterDone />}
          {/* Trees and paper: the picture the first time someone signs, one small card after that (impact/SignerTrees.tsx). */}
          {/* Not for someone who printed it to sign on paper: they did use paper (sign/Paper.tsx). */}
          {!env.counter?.screen && me.paper_sign?.state !== 'accepted' && <SignerDone base={base} impact={finished?.impact || env.impact} />}
          {/* The sender's own payment page, when they set one and may: only after Finish (src/components/sign/PayLink.tsx). */}
          {/* A signer with a witness: what became of them, and another one after "I was not there" (sign/Witness.tsx). */}
          <WitnessAfter me={me} base={base} onNamed={load} />
          {acts && <PayLink base={base} />}
          {env.next_person && <NextPerson slug={env.next_person} email={myEmail} />}
        </div>
        </PayAfter>
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

  // Paused by its sender (sign/Paused.tsx, src/server/timing.ts).
  if (stage === 'paused') return <PausedLink data={data} footer={report} notice={notice} dialogs={dialogs} />;
  if (stage === 'pending')
    return (
      <Shell data={data} footer={report}>
        {notice}
        <StateCard tone="wait" title="It is not your turn yet">
          {/* Someone who changes the document waits after their own change: who signs again first, and why (agents.ts). */}
          {me.step_wait ? <p>{me.step_wait.again.join(', ')} {me.step_wait.again.length === 1 ? 'is' : 'are'} asked to sign again first, because of your change. We will email {myEmail} when it is your turn, and you finish then.</p>
            : me.link_by_sender ? <NoEmailWait sender={sender.name} /> : <p>Others need to finish first. We will email {myEmail} as soon as the document is ready for you. There is nothing to do until then.</p>}
          {/* Someone who signed, and is asked to sign again after a change, waits here for their turn. What they
              signed the first time is still theirs to download meanwhile. */}
          {me.signed_before && me.earlier_copy && !data.locked && (
            <>
              <p>You {acts ? 'signed' : me.role === 'approver' ? 'approved' : 'viewed'} this on {fmtDate(me.signed_before, true)}. After that, {changerWords(me.changed_by, sender.name, !!me.changed_by_signer)} changed the document, so you will be asked to {acts ? 'sign' : me.role === 'approver' ? 'approve' : 'confirm'} again when it is your turn. What you {acts ? 'signed' : me.role === 'approver' ? 'approved' : 'viewed'} then is kept on record, and you can download it.</p>
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
  const declineLabel = me.role === 'approver' ? 'Decline to approve' : isStepRole(me.role) ? 'Decline' : 'Decline to sign';
  // One list in one order, no descriptions, never more than six (src/components/sign/actions.ts). Gone from it, not
  // from the page: Download and the view (the toolbar's More, sign/More.tsx), Help (the top bar's own button), "Change
  // my signature" (tap the signature itself) and "Stop reminder emails" (the note after Finish later, and every
  // reminder). "Fix my name" is behind a tap on the name where the document prints it (sign/NameDialog.tsx), in
  // "Pass to someone else", and in "Check before you finish" when that opens.
  const finishLater = async () => {
    const ok = await flush();
    setOpen('');
    if (!ok) return;
    tellFrame('saved');
    // Someone who changes the document or chooses people saves only when they finish: the note says so (NameNext.tsx).
    setLater(stage === 'consent' ? laterAtConsent(!!me.link_by_sender) : isStepRole(me.role) ? stepLaterWords(!!me.link_by_sender) : laterWords(!!me.link_by_sender));
    window.scrollTo({ top: 0 });
  };
  const absent = async () => {
    setOpen('');
    try {
      await api(`${base}/not-present`, { body: {} });
      toast(`Done. We told ${me.witness_of?.name || 'the signer'} and ${sender.name}.`);
      load();
    } catch (e: any) {
      toast(e?.message || 'Something went wrong on our side. Try again in a moment.', true);
    }
  };
  const ACTION: Record<ActionKey, MenuItem> = {
    later: { key: 'later', label: 'Finish later', icon: 'clock', onClick: finishLater },
    time: { key: 'time', label: moreTime === 'asked' ? `Asked ${sender.name} for more time` : `Ask ${sender.name} for more time`, icon: 'clock', onClick: async () => { if (moreTime === 'asked' || (await askForTime())) toast(moreTimeWords(sender.name, !!me.link_by_sender).say); } },
    handback: { key: 'handback', label: `Hand back to ${me.group?.name}`, icon: 'link', onClick: go('handback') },
    reassign: { key: 'reassign', label: 'Pass to someone else', icon: 'link', onClick: go('reassign') },
    ask: { key: 'ask', label: 'Questions and comments', icon: 'mail', onClick: go('ask') },
    paper: { key: 'paper', label: 'Sign on paper instead', icon: 'pen', onClick: go('paper') },
    decline: { key: 'decline', label: declineLabel, icon: 'stop', danger: true, onClick: go('decline') },
    // A witness does not close the document for the people who sign it: "I was not there" is theirs (sign/Witness.tsx).
    absent: { key: 'absent', label: 'I was not there', icon: 'stop', onClick: absent },
    help: { key: 'help', label: 'Help', icon: 'mail', onClick: go('help') },
  };
  // Someone asked only to read has nothing to finish: for them the same entry is "Read it later".
  ACTION.later.label = laterLabel(me.role);
  const menu: MenuItem[] = bySwitches(withPrint(otherActions(me, { stage, deadline: !!env.expires_at, paper: !!data.own_terms }), me.paper_sign, () => otherActions(me, { stage, deadline: !!env.expires_at, paper: true })), data.switches).map((k) => ACTION[k]);
  helpActs.current = [...menu.filter((m) => m.key !== 'help'), { key: 'menu', label: 'Other actions', onClick: go('menu') }];
  const other = <button type="button" className="btn sm sg-other" aria-haspopup="dialog" onClick={go('menu')}>Other actions</button>;
  const menuDialog = open === 'menu' && <MenuDialog items={menu} onClose={() => setOpen('')} when={env.expires_at ? `Open until ${yourMoment(env.expires_at, deviceZone())}.` : undefined} back="Back" />;
  // Help is one button in the top bar (charter 2.6), so neither Other actions nor the footer carries a second one.
  // A witness keeps Help in their own short list (sign/actions.ts) and the footer link.
  const headHelp = me.role === 'witness' ? undefined : go('help');
  // After Finish later: the way back, and the one place on the page to stop reminder emails. Someone with no address
  // gets no reminder emails, so there is nothing for them to stop.
  const laterNote = later && (
    <div className="notice sg-top" role="status">
      <b>{later}</b>
      <div className="sg-later-stop">
        {!muted && me.role !== 'inperson' && !me.link_by_sender && <button type="button" className="sg-link" onClick={() => mute()}>Stop reminder emails</button>}
      </div>
    </div>
  );

  // Someone who changes the envelope on their turn and does not sign: their own screen (sign/NameNext.tsx), with
  // the same Other actions as every signer screen (charter 2.6).
  // Signed on paper and waiting for the sender to check, or asked to sign on paper only (sign/Paper.tsx).
  const paperScreen = paperFirst(me.paper_sign, stage);
  // The sender asked for the photos again: their reason where the person lands, with one button to the steps.
  const paperNote = <PaperAskedNote ps={me.paper_sign} sender={sender} lang={data.language?.locale || 'en'} onOpen={go('paper')} />;
  if (paperScreen) {
    // Other actions works here too: while the scan waits only a question or declining means anything.
    const paperMenu = menu.filter((m) => (paperScreen === 'waiting' ? m.key === 'ask' || m.key === 'decline' : m.key !== 'paper' || !!data.own_terms));
    return (
      <Shell data={data} bar={other} footer={report} plainBar onHelp={headHelp}>
        {notice}
        <PaperScreen kind={paperScreen} base={base} ps={me.paper_sign} sender={sender} email={me.link_by_sender ? null : me.email} subject={env.subject} lang={data.language?.locale || 'en'} onSent={load} />
        {menuDialog && cloneElement(menuDialog, { items: paperMenu })}
        {dialogs}
      </Shell>
    );
  }

  if (stepFirst(data, stage))
    return (
      <Shell data={data} bar={other} footer={report} helpInNewTab plainBar onHelp={headHelp}>
        {notice}
        {laterNote}
        <NameNext data={data} base={base} downloadUrl={downloadUrl} onDone={load} />
        {menuDialog}
        {dialogs}
      </Shell>
    );

  if (stage === 'consent') {
    // Who it is for when it is not a signature: a signer reads "sign" in the words under the tick.
    // Three words at most: the screen holds 120 words before the tick, and our own text takes most of them.
    const ask = me.role === 'approver' ? T('sign.consent.ask_approve') : me.role === 'viewer' ? T('sign.consent.ask_read') : me.role === 'witness' ? T('sign.consent.ask_witness') : '';
    // In the page's language where a person has checked that wording, else English with one sentence saying why (note).
    const wording = consentWording(sender.name, acts, undefined, lang);
    return (
      <Shell data={data} bar={other} footer={report} helpInNewTab plainBar onHelp={headHelp}>
        {notice}
        {laterNote}
        {paperNote}
        <div className="card sg-consent">
          {/* Who asks, the document, from and for whom, the sender's words; kept to 120 words before the tick. The
              sender is named once, with the account's name only when it says more ("at Acme Ltd"). */}
          <ConsentTop data={data} ask={ask} myEmail={myEmail} />
          {/* In person: whose turn it is. The line about the connection is said on the document, where it matters. */}
          {/* Not on the person's own counter screen: they already hold it (counter.ts). */}
          {me.role === 'inperson' && !env.counter?.screen && <div className="notice warn sg-gap">{richText(lang, 'sign.consent.hand_over', { name: <b>{me.name}</b> })}</div>}
          {/* One way to read it first: the PDF in a new tab, where it can be saved or printed. */}
          <p className="sg-read"><a className="btn" href={`${downloadUrl}?inline=1`} target="_blank" rel="noreferrer" aria-label={T('sign.consent.download_label')}><Icon name="download" /> {T('sign.consent.download')}</a></p>
          {/* The words come from src/lib/policy.ts with a version, and the version goes back with the agreement, so the
              audit trail says which wording this person was shown. */}
          <div id="sg-legal" lang={wording.language}>
            {consentNote(lang, wording.note) && <p className="muted sg-legal" lang={signLangAttr(lang)}>{consentNote(lang, wording.note)}</p>}
            <p className="muted sg-legal">{wording.legal}</p>
            <p className="muted sg-legal">{wording.practical}</p>
          </div>
          {/* The account's own consent text, under ours: in full while the screen stays at 120 words, else one tap away. */}
          {data.own_terms && <OwnTermsBlock key={data.own_terms.id} own={data.own_terms} lang={data.language?.locale || 'en'} paper={menu.some((m) => m.key === 'paper')} />}
          <label className="check sg-agree">
            <input type="checkbox" checked={agree} onChange={(e) => (setAgree(e.target.checked), setFormError(''))} aria-describedby={formError ? 'sg-legal sg-agree-err' : 'sg-legal'} /> <span lang={wording.language}>{wording.agree}</span>
          </label>
          {/* A group's member: what Continue does for the group, right above it (GroupNotice.tsx). */}
          <GroupConsentNote data={data} />
          <DelegateConsentNote data={data} />
          {formError && <div id="sg-agree-err" className="notice err sg-problem" role="alert">{formError}</div>}
          <button type="button" className="btn primary lg sg-continue" disabled={busy} aria-describedby={groupNoteId(data) || delegateNoteId(data)} onClick={async () => {
            if (!agree) return setFormError(T('sign.consent.tick_first'));
            setBusy(true);
            try {
              // "own": which version of the account's own text this screen showed, so the record names those words.
              await api(`${base}/consent`, { body: { version: version.current, wording: wording.version, language: wording.language, page_language: lang, tz: deviceZone(), own: data.own_terms?.id } });
              setAgreedHere(true);
              // The note from "Finish later" was about coming back. They stayed, so it is not said over the document.
              setLater('');
              await load();
            } catch (e: any) {
              // A colleague in the group took it on a moment earlier: the page then says who (GroupNotice.tsx).
              if (e?.code === 'taken') return void load();
              // The account saved a new text while this screen was open: the new one is shown, to read and tick again.
              if (e?.code === 'terms') return void (setAgree(false), setFormError(e.message), load());
              setFormError(T('sign.error.try_again', { said: shownError(lang, e, 'sign.error.ours') }));
            } finally {
              setBusy(false);
            }
          }}>{T('sign.consent.continue')}</button>
        </div>
        {menuDialog}
        {dialogs}
      </Shell>
    );
  }

  // ---- The document -----------------------------------------------------------------------------------

  const finishLabel = me.role === 'approver' ? 'Approve' : me.role === 'viewer' ? 'Mark as viewed' : 'Finish';
  const fieldsNext = acts && left.length > 0;
  // Next also goes to a file given to read that is still to open or tick, once no field is left.
  const hasNext = fieldsNext || also.left > 0;
  const toDo = required.length + also.total, stillLeft = left.length + also.left;
  const count = !acts ? '' : !toDo ? 'Nothing is required' : stillLeft ? `${stillLeft} of ${toDo} left` : 'Ready to finish';
  const mainButton = (big: boolean) => hasNext
    // Next goes to the field and opens it. "Cannot reach this field?" only for a field Next does not open itself.
    ? <button type="button" className={`btn go${big ? ' sg-big' : ''}`} onClick={() => !fieldsNext ? focusAlso() : (nextAgain(nextField.id) && view === 'doc' && !opensOnNext(nextField) && toast(CANNOT_REACH), goTo(nextField, true))}>Next</button>
    : <button type="button" className={`btn go finish${big ? ' sg-big' : ''}${ready ? ' sg-ready' : ''}`} disabled={busy || !allShown} aria-describedby={allShown ? undefined : 'sg-guide'} onClick={pressFinish}>{finishLabel}</button>;
  const done = toDo - stillLeft;
  const saveText = data?.preview ? previewT('preview.save') : SAVE_TEXT[save];
  const bar = (
    <>
      {acts && (
        <div className="sg-count sg-wide">
          {toDo > 0 && <div className="progress" aria-hidden="true"><i style={{ width: `${(done / toDo) * 100}%` }} /></div>}
          <div><b>{count}</b><span aria-hidden="true"> · {saveText}</span></div>
        </div>
      )}
      <span className="sg-wide"><MoreButton open={open === 'more'} onOpen={go('more')} /></span>
      {other}
      {/* One tree line next to Finish, for someone who signs with a paid signature (impact/SignerTrees.tsx). */}
      <span className="sg-wide"><TreeLine base={base} show={acts && !hasNext} /></span>
      <span className="sg-wide">{mainButton(false)}</span>
    </>
  );
  const bottom = (
    <>
      {acts && <div className="sg-bottom-info"><b>{count}</b><span aria-hidden="true">{saveText}</span></div>}
      <MoreButton open={open === 'more'} onOpen={go('more')} className="btn sg-morebtn" />
      <TreeLine base={base} show={acts && !hasNext} />
      {mainButton(true)}
    </>
  );
  // A preview keeps what is typed in this tab only: it never says Saved (src/server/preview.ts).
  const live = data?.preview ? '' : save === 'saved' ? 'Saved' : save === 'error' ? 'Not saved yet. We will keep trying.' : '';

  const docField = (f: any) => {
    const ok = filled(f);
    const auto = AUTO.includes(f.type) || f.readonly;
    const value = values[f.id] || '';
    // How the answer reads on the page: a picked date in the format the sender chose for this envelope.
    const shown = f.type === 'date' ? formatDateValue(value, env.date_format) : value;
    const wrong = !auto && !!problemWith(f, value, env.date_format);
    const cls = `field fill sg-f${auto || ok ? ' done' : ''}${f.id === nextField?.id ? ' next' : ''}${isBox(f) ? ' box' : ''}${wrong ? ' bad' : ''}${auto ? ' sg-auto' : ''}`;
    const common = { id: `f-${f.id}`, className: cls, style: { ...pos(f), zIndex: layered.get(f.id) } };
    // The sender's text style for this field: font, colour and bold (src/lib/fieldkinds.ts).
    Object.assign(common.style, lookCss(lookOf(f.look), data?.brand?.brand_color));
    const name = fieldName(f);
    const need = f.required ? ', required' : ', optional';
    const kind = kindField(f, { common, name, need, value, values, fields, role: me.role, dateFormat: env.date_format, sheet: usesSheet(f), openSheet: (x) => goTo(x), set, onDraw: drawing.open, onApprove: pressFinish, onDecline: go('decline') });
    if (kind) return kind;

    // A stamp field: what is pressed is here, the stamp itself is printed in the page's ink layer under it (inkLayer).
    if (f.type === 'stamp')
      return (
        <button key={f.id} type="button" {...common} className={`${cls} stamp`} onClick={() => setStampFor(f.id)} aria-label={ok ? `${name}: your stamp is on the page. Change it or take it off` : `${name}${need}. Put your stamp here`}>
          {!ok && <span className="cta"><Icon name="check" size={14} /> Stamp</span>}
        </button>
      );
    if (f.type === 'signature' || f.type === 'initials') {
      const word = f.type === 'signature' ? 'signature' : 'initials';
      return (
        <button key={f.id} type="button" {...common} onClick={() => clickSig(f)} aria-label={ok ? `Your ${word}. Change or clear it` : `${name}${need}. ${FLAG[f.type]}`}>
          {ok ? <img src={(f.type === 'signature' ? sig : ini) || ''} alt="" /> : <span className="cta"><Icon name="pen" size={14} /> {f.type === 'signature' ? 'Sign' : 'Initial'}</span>}
        </button>
      );
    }
    // The person's own name: a tap on it says which name the document is for, with "Fix my name" (sign/NameDialog.tsx).
    if (f.type === 'full_name' && me.role !== 'viewer')
      return <button key={f.id} type="button" {...common} title="Added for you" aria-haspopup="dialog" onClick={go('name')} aria-label={`Your name, added for you: ${me.name}. Fix its spelling`}><span className="sg-val" dir="auto">{me.name}</span></button>;
    if (AUTO.includes(f.type)) return <div key={f.id} {...common} title="Added for you"><span className="sg-val" dir="auto">{f.type === 'full_name' ? me.name : f.type === 'email' ? me.email : dateText}</span></div>;
    // A field anyone could fill in that someone's Finish has closed: what it says and why (SharedNotes.tsx).
    if (f.readonly && f.locked_by?.length) return <LockedShared key={f.id} f={f} common={common} box={isBox(f)} shown={isBox(f) ? (f.value === '1' ? '1' : '') : f.value || ''} />;
    if (f.readonly) return <div key={f.id} {...common} title={f.calc_note}><span className="sg-val" dir="auto">{isBox(f) ? (f.value === '1' ? '✓' : '') : f.type === 'date' ? formatDateValue(f.value, env.date_format) : f.value}</span>{f.calc_note && <span className="sg-vh">{f.calc_note}</span>}</div>;
    // Tick boxes and radio buttons are the browser's own controls, drawn in the place the page gives them. So the
    // keyboard works as everywhere else (Space ticks, the arrow keys move through a group of radio buttons) and a
    // screen reader says what they are, whether they are on, and which group a radio button belongs to.
    if (f.type === 'checkbox')
      return (
        <label key={f.id} {...common}>
          <input type="checkbox" className="sg-vh" checked={!!value} aria-label={`${name}${need}${sharedSaid(f)}${boxRuleHint(f, fields) ? `. ${boxRuleHint(f, fields)}` : ''}`} aria-required={!!f.required} onChange={(e) => set(f.id, e.target.checked ? '1' : '')} />
          {value && <Icon name="check" />}
        </label>
      );
    if (f.type === 'radio') {
      const group = fields.filter((x) => x.type === 'radio' && !x.readonly && groupKey(x) === groupKey(f));
      return (
        <label key={f.id} {...common} style={{ ...common.style, borderRadius: '50%' }}>
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
        <button key={f.id} type="button" {...common} onClick={() => goTo(f)} aria-label={`${name}${need}${sharedSaid(f)}. ${value ? `Your answer: ${shown}` : 'Empty'}. Opens a box to type in`}>
          <span className={`sg-val${value ? '' : ' ph'}`} dir="auto">{shown || name + (f.required ? ' *' : '')}</span>
        </button>
      );
    if (f.type === 'dropdown')
      return (
        <div key={f.id} {...common}>
          <select aria-label={name + sharedSaid(f)} aria-required={!!f.required} value={value} onChange={(e) => set(f.id, e.target.value)}>
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
    // A character limit is said under the box while the person is in it (sign.css .sg-doc-count), so typing that stops is never a mystery.
    const count = lengthHint(f, value);
    const again = askAgain && askAgain.id === f.id && askAgain.value === value ? askAgain.text : '';
    const shared = { dir: 'auto' as const, 'aria-label': name + sharedSaid(f), 'aria-required': !!f.required, 'aria-invalid': wrong || !!again, 'aria-describedby': [count && `f-${f.id}-count`, again && `f-${f.id}-again`].filter(Boolean).join(' ') || undefined, placeholder: name + (f.required ? ' *' : ''), value, maxLength: inputLimit(f), title: wrong ? problemWith(f, value, env.date_format) : f.type === 'number' ? amountHint(f) || NUMBER_HINT : undefined };
    return (
      <div key={f.id} {...common}>
        {isMulti(f)
          ? <textarea {...shared} onChange={(e) => set(f.id, e.target.value)} />
          : <input {...shared} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} onChange={(e) => set(f.id, e.target.value)}
              {...(f.type === 'date' ? { autoFocus: dateOpen === f.id, onFocus: () => setDateOpen(f.id), onBlur: () => setDateOpen(null) } : {})} />}
        {count && <span id={`f-${f.id}-count`} className="sg-doc-count" aria-live="polite">{count}</span>}
        {again && <span id={`f-${f.id}-again`} className="sg-doc-again" role="alert">{again}</span>}
      </div>
    );
  };

  // The pointer goes above the field, or else below it or beside it: wherever it covers none of the page's own words
  // and no other field (see placeFlag). Until the words of the page have been read, and on a scan, which has none to
  // read, only the other fields count.
  const flagSide: FlagSide = !nextField ? 'above' : (() => {
    const p = printed?.key === flagKey ? printed : null;
    const others = [...data.others, ...fields].filter((g: any) => g.id !== nextField.id && g.document_id === nextField.document_id && g.page === nextField.page);
    // Room is kept around the printed words too (FLAG_MARGIN in actions.ts), so the pointer never stands right beside a label.
    return placeFlag(nextField, p ? { w: 104 / p.w, h: 27 / p.h } : { w: 0.3, h: 0.045 }, p ? { x: 10 / p.w, y: 8 / p.h } : { x: 0.025, y: 0.012 }, [...(p?.boxes || []), ...others],
      p ? { x: FLAG_MARGIN.x / p.w, y: FLAG_MARGIN.y / p.h } : undefined);
  })();
  const flagAt = (f: any) => (flagSide === 'right' ? { left: `${(f.x + f.w) * 100}%`, top: `${(f.y + f.h / 2) * 100}%` }
    : flagSide === 'left' ? { left: `${f.x * 100}%`, top: `${(f.y + f.h / 2) * 100}%` }
    : { left: `min(${f.x * 100}%, calc(100% - 8.5em))`, top: `${(f.y + (flagSide === 'below' ? f.h : 0)) * 100}%` });

  // This person's fields on one page. Radio buttons that belong together are wrapped as one group with its name, so
  // a screen reader announces the group. The wrapper takes no room: every field places itself on the page.
  const pageFields = (docId: string, page: number) => {
    const here = fields.filter((f) => f.document_id === docId && f.page === page);
    const grouped = (f: any) => f.type === 'radio' && !f.readonly;
    // The page is said when the focus comes into it (Next or Tab), so a screen reader names the page of each field.
    return (
      <div role="group" aria-label={`Page ${page + 1}`}>
        {here.filter((f) => !grouped(f)).map(docField)}
        {[...new Set(here.filter(grouped).map(groupKey))].map((key) => {
          const members = here.filter((f) => grouped(f) && groupKey(f) === key);
          return <div key={key} role="radiogroup" aria-label={members[0].group_name || 'Choose one'} aria-required={members.some((m) => m.required)}>{members.map(docField)}</div>;
        })}
      </div>
    );
  };

  const overlay = (docId: string) => (page: number) => (
    <>
      {/* Everything already on the page that is not this person's to fill in: the sender's own wording, whoever it
          is assigned to, and what people who have finished put there. */}
      {data.others.filter((f: any) => f.document_id === docId && f.page === page && f.type !== 'stamp').map((f: any) => (
        <div key={f.id} dir="auto" className={`field other${isBox(f) ? ' box' : ''}${strikeClass(f)}`} style={pos(f)} title={otherSource(f, sender.name)}>
          {f.image ? <img src={f.image} alt="Signature of another signer" /> : isBox(f) ? (f.value === '1' ? '✓' : '') : f.value}
        </div>
      ))}
      {pageFields(docId, page)}
      <SharedNotes fields={fields.filter((f: any) => f.document_id === docId && f.page === page)} />
      {nextField && nextField.document_id === docId && nextField.page === page && !sheet && (
        <span className={`sg-flag ${flagSide}`} aria-hidden="true" style={flagAt(nextField)}>
          {boxRuleHint(nextField, fields, true) || FLAG[nextField.type] || 'Fill in here'}
        </span>
      )}
    </>
  );

  // Stamps, printed like ink into the drawn page (the ink layer of PdfDoc): this person's own, the sender's, and those
  // of people who have finished. The same picture, place and blend as in the signed PDF (stamps.css, pdf.ts).
  const stampUrl = (f: any): string | null => (values[f.id] ? `/api${base}/stamp-image/${values[f.id]}` : null);
  // Each is turned by its natural tilt about its middle, as the signed PDF turns it.
  const inkLayer = (docId: string) => (page: number) => {
    const here = [...data.others.filter((f: any) => f.type === 'stamp' && f.image).map((f: any) => ({ f, src: f.image as string, turn: stampTurn(f.turn) })),
      ...fields.filter((f) => f.type === 'stamp' && stampUrl(f)).map((f) => ({ f, src: stampUrl(f)!, turn: turns[f.id] ?? stampTurn(f.stamp_meta) }))].filter(({ f }) => f.document_id === docId && f.page === page);
    // eslint-disable-next-line @next/next/no-img-element
    return here.length ? here.map(({ f, src, turn }) => <span key={f.id} className="st-print" style={pos(f)}><img src={src} alt="" style={turnStyle(turn)} /></span>) : null;
  };

  const ctx: FieldCtx = { me, values, sig, ini, dateText, dateFormat: env.date_format, ordered, uploading, filled, set, pickRadio, clickSig, attach, clickStamp: (f: any) => setStampFor(f.id), stampUrl };
  const signed = byId(signedField);
  const stampField = byId(stampFor);
  const sheetField = byId(sheet);
  const sheetTarget = sheetField && nextAfter(sheetField.id);

  // Pay, for a document that asks for a payment before finishing: after the last signature, before Done. The usual
  // header stays (Other actions, with Decline, and Help), so not paying is never a dead end.
  if (payWait && acts) return <Shell data={data} bar={other} footer={report} helpInNewTab onHelp={headHelp}>{notice}<PayNow base={base} token={token} onBack={() => setPayWait(false)} onDone={load} />{menuDialog}{dialogs}</Shell>;

  return (
    <Shell data={data} bar={bar} bottom={bottom} footer={report} titleIsHeading live={live} helpInNewTab onHelp={headHelp}>
      {notice}
      {/* A field that appears or goes because of an answer is said to a screen reader (useLiveLogic). */}
      <p className="sg-vh" role="status" aria-live="polite">{logic.said}</p>
      {changedOpen && (
        <div className="notice warn sg-top" role="alert">
          {typeof changedOpen === 'string' ? <b>{changedOpen}</b> : <><b>{sender.name} changed this document while you had it open.</b> Nothing was signed. What you filled in is still here wherever its field still exists. Look at the document again before you finish.
          {data.changed ? ` What changed: ${data.changed}` : ''}</>}{' '}
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
      {acts && <PayAhead base={base} onWaiting={waitPay} />}{/* a payment this document asks for, said before signing (sign/PayNow.tsx) */}
      <p className="sg-guide" id="sg-guide">
        {also.left > 0 && !fieldsNext ? also.guide
          : !acts ? (me.role === 'approver' ? 'Read the document, then choose Approve. To say no, choose Decline to approve from Other actions.' : 'Read the document, then choose Mark as viewed.')
          : hasNext ? GUIDE_NEXT
          : GUIDE_FINISH}
        {/* Finish is switched off until the pages of the document, as it is now, are on the screen. Said here, so a
            button that does nothing is never the only sign of it. */}
        {!allShown && !hasNext && <> The document is still loading: you can {acts ? 'finish' : me.role === 'approver' ? 'approve' : 'confirm'} as soon as its pages are on your screen. If they do not appear, reload this page.</>}
      </p>
      {laterNote}
      {paperNote}
      {/* The view, the size of the pages and Download are in the toolbar's More (sign/More.tsx), and Questions and
          comments in Other actions, so the pages start near the top of a phone. Someone on a keyboard or a screen reader meets the text view right here, before the
          pages, which are pictures: this button shows itself when it has the focus, like the skip link. */}
      {/* "Also for you": files given to read with the document, only when the sender gave some (sign/Supplements.tsx). */}
      <Supplements base={base} list={data.supplements} canTick={me.role !== 'witness' && me.role !== 'cc' && me.status !== 'completed'} finish={finishLabel} onLeft={setAlso} />
      {/* "Summary (written by AI, check it)": only when the sender switched it on (sign/Summary.tsx). */}
      <SummaryLink base={base} offered={!!data.ai_summary} many={data.documents.length > 1} />
      {view === 'doc' && <button type="button" className="sg-skip sg-skip-text" onClick={() => chooseView('text')}>{T('sign.read.skip')}</button>}

      {view === 'doc' ? (
        <div className={`stack sg-doc sg-pan${zoom > 1 ? ' zoomed' : ''}`}>
          {data.documents.map((d: any) => (
            <div key={d.id} data-doc={d.id}>
              {back?.doc === d.id && <p className="sg-flow-back"><button type="button" className="btn sm" onClick={() => chooseView('text')}>{T('sign.read.back')}</button></p>}
              {data.documents.length > 1 && <h2 className="sg-docname">{d.name}</h2>}
              {/* The address and the key carry the fingerprint of the file. A file the sender replaced is fetched and
                  drawn afresh, and onShown says when its first page is really on the screen. */}
              <PdfDoc key={d.sha256 || d.id} url={docUrl(base, d)} zoom={zoom} overlay={overlay(d.id)} ink={inkLayer(d.id)} onShown={() => (markShown(d), sawIn('page'))} onDocument={(pdf) => { pdfs.current[d.id] = pdf; setPdfReady((n) => n + 1); }}
                failed={(why, retry, said) => <NoViewer why={why} retry={retry} said={said} sender={sender.name} downloadUrl={downloadUrl} onAsk={go('ask')} />} />
            </div>
          ))}
        </div>
      ) : (
        <TextView documents={data.documents} urlFor={(id) => docUrl(base, data.documents.find((d: any) => d.id === id) || { id })} ocrUrl={`/api${base}/ocr`} onShown={(d) => (markShown(d), sawIn('easy'))} senderName={sender.name} onAsk={go('ask')}
          fields={(docId, page, near, ids) => <PageFields docId={docId} page={page} c={ctx} near={ids ? (f: any) => (f.type === 'radio' ? near(f) : '') : near} only={ids} title={ids ? T('sign.read.here') : undefined} />}
          mine={(docId, page) => ctx.ordered.filter((f: any) => f.document_id === docId && f.page === page)}
          onSee={(docId, page, y, part) => (setBack({ doc: docId, id: partId(docId, page, part) }), chooseView('doc'), showOnPage(docId, page, y))}
          others={(docId, page, near) => <PageOthers others={data.others.filter((f: any) => f.document_id === docId && f.page === page)} senderName={sender.name} near={near} />} />
      )}
      {/* No impact figure here: one tree line at most, by Finish, and the Done screen (research/ux.json, "ux:check"). */}
      {/* No internal number either: a signer who writes to us is known by the code in their email (help_code). */}
      {env.expires_at && <p className="muted small center sg-envelope">Open until {yourMoment(env.expires_at, deviceZone())}</p>}

      {sheetField && (
        <FieldSheet field={sheetField} dateFormat={env.date_format} value={values[sheetField.id] || ''} again={askAgain && askAgain.id === sheetField.id && askAgain.value === (values[sheetField.id] || '') ? askAgain.text : ''} onChange={(v) => set(sheetField.id, v)} onDone={() => setSheet(null)} onNext={sheetTarget ? () => sheetNext(sheetField.id) : undefined} />
      )}
      {signed && (
        <SignedFieldDialog kind={signed.type} image={(signed.type === 'signature' ? sig : ini) || ''} onClose={() => setSignedField(null)}
          onClear={() => { set(signed.id, ''); setSignedField(null); }}
          onChange={() => { setSignedField(null); changeMark(signed.type); }} />
      )}
      {menuDialog}
      {open === 'more' && <MoreDialog view={view} onView={chooseView} zoom={zoom} onZoom={setZoom} downloadUrl={downloadUrl} onClose={() => setOpen('')} />}
      {dialogs}
      {open === 'review' && (
        <ReviewDialog me={me} sender={sender} items={items} sig={sig} ini={ini} approving={me.role === 'approver'} busy={busy} error={finishError}
          note={<>{!!sig && nameDiffers(typedName, me.name) && <div className="notice warn sg-problem" role="status"><b>Check your name.</b> Your typed signature reads <bdi>{typedName}</bdi>, and this document is for <bdi>{me.name}</bdi>. If your name is spelled wrong on the document, choose Fix my name above. If the signature is what you want, finish as it is.</div>}
            {questions > 0 ? <OpenQuestion sender={sender.name} onShow={go('ask')} /> : null}<WitnessName me={me} base={base} onNamed={load} /></>}
          usesSig={fields.some((f) => f.type === 'signature' && filled(f))} usesIni={fields.some((f) => f.type === 'initials' && filled(f))}
          onChangeSig={changeMark} onBack={() => setOpen('')} onFinish={complete}
          printCheck={() => api(`${base}/print-check`, { body: { values } })}
          title={finishError ? undefined : reviewTitle(lookAgain({ questions, witness: me.witness, typedName: sig ? typedName : null, name: me.name }), me.role === 'approver', witnessPlaces(me)) === 'Check before you finish' ? undefined : reviewTitle(lookAgain({ questions, witness: me.witness, typedName: sig ? typedName : null, name: me.name }), me.role === 'approver', witnessPlaces(me))}
          checkFailed={checkFailed}
          onRename={rename} />
      )}
      {adopt && (
        <AdoptSignature kind={adopt.kind} name={me.name} saved={adopt.saved} ways={data.switches?.ways} onClose={() => setAdopt(null)}
          onDone={(png, typed, how) => {
            if (how) hows.current = { ...hows.current, [adopt.kind === 'signature' ? 'signature_how' : 'initials_how']: how };
            // A typed signature under another name than the one on the document: looked at once more at Finish.
            if (adopt.kind === 'signature') (setSig(png), setTypedName(typed ?? null), writeTypedName(token, typed));
            else setIni(png);
            // Made, or looked at and confirmed, in this tab: from here on a tap puts it on a field directly.
            setSeen((s) => ({ ...s, [adopt.kind]: true }));
            if (adopt.field) set(adopt.field, '1');
            setAdopt(null);
          }} />
      )}
      {stampField && (
        <StampDialog base={base} field={stampField} version={version.current} same={sameStampOf(fields, stampField, stampUrl, turns)} current={stampUrl(stampField) ? { image_url: stampUrl(stampField)!, turn: turns[stampField.id] ?? stampTurn(stampField.stamp_meta) } : null}
          onClose={() => setStampFor(null)}
          onChanged={() => { setStampFor(null); setChangedOpen(true); load(); }}
          onPut={(r) => {
            // Kept on the server at once, so "Finish later" and another device have it too.
            set(stampField.id, r.value);
            setTurns((t) => ({ ...t, [stampField.id]: stampTurn(r.turn) }));
            const next = nextAfter(stampField.id);
            setStampFor(null);
            toast('Your stamp is on the page.');
            if (next) afterClose.current = next;
          }}
          onTakeOff={async () => {
            await api(`${base}/stamp/${stampField.id}`, { method: 'DELETE' });
            set(stampField.id, '');
            setStampFor(null);
            toast(stampField.required ? 'Your stamp was taken off. This stamp is required, so put one on again before you finish.' : 'Your stamp was taken off.');
          }} />
      )}
    </Shell>
  );
}
