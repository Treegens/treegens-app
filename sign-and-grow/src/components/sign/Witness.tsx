'use client';
import { useEffect, useId, useState } from 'react';
import { api, toast } from '@/components/ui';
import { StateCard, Sender } from './parts';
import { WHO_MAY_WITNESS, WITNESS_RECORDS } from '@/lib/witness';
import { headingFor } from '@/lib/consentfit';

// A witness for one signer (src/lib/witness.ts), on the signing page. Two people see something here:
//   - the witness: their first screen is their own statement, to tick, or "I was not there" instead. Before the
//     signer has signed, and after they said they were not there, it says where things stand and nothing more.
//   - the signer: who their witness is, a box to name one when the sender left it to them (on the review screen,
//     before Finish), and after Finish what became of the witness, with a way to name another after "not there".
// What the product does and does not do is said next to every choice. It records what the witness states and
// cannot check that they were in the room.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A signer's witnesses, one or two (src/lib/witness.ts WITNESSES_MAX), as GET /sign/:token lists them. */
const witnessesOf = (me: any): any[] => (Array.isArray(me?.witnesses) && me.witnesses.length ? me.witnesses : me?.witness ? [me.witness] : []);
/** "Your witness", or with two "Your first witness" and "Your second witness". */
const placeName = (i: number, total: number): string => (total > 1 ? (i === 0 ? 'Your first witness' : 'Your second witness') : 'Your witness');

/** Whether the witness's own screen takes the place of the usual one: before they ticked, while waiting, after "not there". */
export const witnessFirst = (data: any, stage: string): boolean => {
  const w = data?.recipient?.role === 'witness' ? data.recipient.witness_of : null;
  return !!w && (stage === 'pending' || (stage === 'consent' && !w.said));
};

export function WitnessFirst({ data, base, onDone }: { data: any; base: string; onDone: () => void }) {
  const me = data.recipient;
  const w = me.witness_of;
  const env = data.envelope;
  const sender = env.sender || {};
  const [tick, setTick] = useState(false);
  const [away, setAway] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [said, setSaid] = useState(false);
  const ids = useId();

  // Who we told is said as it is: the sender always, the signer only when we have a way to email them (signerTold).
  const told = w.signer_told ? `${w.name} and ${sender.name}` : sender.name;
  if (said || w.absent_at)
    return (
      <StateCard tone="ok" title="Thank you. You said you were not there">
        <p>Nothing was signed in your name. We told {told}{w.signer_told ? `, and ${w.name} can ask the person who was there instead` : `, who can ask the person who was there instead`}. There is nothing more for you to do.</p>
        <Sender env={env} brand={data.brand} lead="Questions? Contact" />
      </StateCard>
    );
  if (!w.signed || !w.statement)
    return (
      <StateCard tone="wait" title={`You are asked to witness ${w.name} sign`}>
        <p>{w.name} has not signed yet. A witness has to be physically with them and watch them sign. Straight after they have, we email you, and this link opens what you are asked to confirm.</p>
        <p className="muted small">{WITNESS_RECORDS}</p>
        <Sender env={env} brand={data.brand} lead="Questions? Contact" />
      </StateCard>
    );

  const go = async () => {
    if (!tick) return setError('Tick the box to make this statement, or choose "I was not there".');
    setBusy(true);
    setError('');
    try {
      await api(`${base}/witness-statement`, { body: { statement: w.statement } });
      onDone();
    } catch (e: any) {
      // The signer signed again since this screen was opened: the statement is shown afresh, unticked.
      if (e?.code === 'changed') (setTick(false), onDone());
      setError(e?.message || 'Something went wrong on our side. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };
  const notThere = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`${base}/not-present`, { body: { note } });
      setSaid(true);
      toast(`Done. We told ${told}.`);
    } catch (e: any) {
      setError(e?.message || 'Something went wrong on our side. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card sg-consent wt-card">
      {/* The same words as above the consent screen that follows (one name for one thing). */}
      <p className="sg-kicker">Asked to witness</p>
      {/* A witness is not asked to sign the document, so the app's own "Please sign: " is not shown (headingFor). */}
      <h1 className="serif" id="sg-h1" tabIndex={-1}>{headingFor(env.subject, true)}</h1>
      <Sender env={env} brand={data.brand} />
      <h2>What you are confirming</h2>
      <p className="wt-note">{w.sender_named ? `${sender.name} named you as the witness of ${w.name}.` : `${w.name} named you as their witness.`} Only go on if you were with them and saw them sign. This is your own statement:</p>
      <blockquote className="wt-statement" id={`${ids}-st`}>{w.statement}</blockquote>
      <label className="wt-tick">
        <input type="checkbox" checked={tick} onChange={(e) => (setTick(e.target.checked), setError(''))} aria-describedby={`${ids}-st ${ids}-rec`} />
        <span>This is true. I make this statement as my own.</span>
      </label>
      <p className="muted small wt-note" id={`${ids}-rec`}>{WITNESS_RECORDS}</p>
      {error && <div className="notice err sg-problem" role="alert">{error}</div>}
      <div className="wt-actions">
        <button type="button" className="btn primary lg" disabled={busy} onClick={go}>{busy ? 'Saving' : 'Continue'}</button>
        <button type="button" className="btn lg" disabled={busy} aria-expanded={away} onClick={() => setAway(!away)}>I was not there</button>
      </div>
      {away && (
        <div className="wt-form">
          <p className="wt-note">Then do not sign as witness. We tell {told} that you were not there, nothing is signed in your name, and {w.name} can name the person who was.</p>
          <label><span>Anything {sender.name} should know <span className="muted">(optional, only {sender.name} sees it)</span></span>
            <textarea dir="auto" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="wt-actions"><button type="button" className="btn lg" disabled={busy} onClick={notThere}>{busy ? 'Sending' : 'Tell them I was not there'}</button></div>
        </div>
      )}
    </div>
  );
}

/** On the document itself: to a signer, who witnesses and what that asks of them; to a witness, what they confirmed. */
export function WitnessNotice({ me }: { me: any }) {
  if (me?.witness_of?.said) return <div className="notice sg-top">You confirmed that you were physically present and saw {me.witness_of.name} sign. Now fill in your witness block and sign it. {WITNESS_RECORDS}</div>;
  const list = witnessesOf(me);
  if (!list.length || list.every((w) => w.state === 'done')) return null;
  if (list.length > 1) {
    const named = list.filter((w) => w.name).map((w) => w.name);
    return (
      <div className="notice warn sg-top">
        <b>This document needs two witnesses.</b> {named.length === 2 ? `Your witnesses are ${named[0]} and ${named[1]}.` : named.length === 1 ? `Your first witness is ${named[0]}. You name the second before you finish.` : 'You name both before you finish.'} Both have to be with you, in the same room, and watch you sign. Straight after you finish, we email each of them a link to confirm that and sign as witness. {WITNESS_RECORDS}
      </div>
    );
  }
  const w = list[0];
  return (
    <div className="notice warn sg-top">
      <b>This document needs a witness.</b> {w.name ? `Your witness is ${w.name}.` : 'You name your witness before you finish.'} They have to be with you, in the same room, and watch you sign. Straight after you finish, we email them a link to confirm that and sign as witness. {WITNESS_RECORDS}
    </div>
  );
}

/**
 * In the step before Finish, for a signer who names their witness: name and address, and the paragraph on who may
 * be a witness. Also after Finish, when the first witness said they were not there. `after` says which.
 */
export function WitnessName({ me, base, onNamed, after = false }: { me: any; base: string; onNamed: () => void; after?: boolean }) {
  const list = witnessesOf(me);
  const whoId = useId();
  // With two places, who may be a witness is said once, above both boxes (like WITNESS_RECORDS once under them).
  const once = list.length > 1 && list.some((w) => w?.may_name);
  return <>{once && <p className="muted small wt-note" id={whoId}>{WHO_MAY_WITNESS}</p>}
    {list.map((w, i) => <OneWitnessName key={w.id || i} w={w} title={placeName(i, list.length)} base={base} onNamed={onNamed} after={after} last={i === list.length - 1} whoId={once ? whoId : undefined} many={list.length > 1} otherOk={list.some((x, j) => j !== i && x?.name && x.state !== 'absent')} />)}</>;
}

/** One witness place: with two, each has its own box, and the name goes to that place only (witness_id). */
// `last`: the line on what GrowSigning records is said once, under the last box, not in each of two.
// `whoId`: the paragraph on who may witness is shown once above both boxes, and this box points to it.
// `many`: two places, so each box's Save is an ordinary button and Finish stays the one main button.
// `otherOk`: the other place has a witness who has not said "not there", so one more is needed, not none.
function OneWitnessName({ w, title, base, onNamed, after, last = true, whoId, many = false, otherOk = false }: { w: any; title: string; base: string; onNamed: () => void; after: boolean; last?: boolean; whoId?: string; many?: boolean; otherOk?: boolean }) {
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ids = useId();
  const open = !!w && w.may_name && (!w.name || w.state === 'absent');
  useEffect(() => setEdit(open), [open]);
  if (!w || (!w.may_name && !w.name)) return null;
  const save = async () => {
    if (name.trim().length < 2 || !EMAIL.test(email.trim())) return setError('Type the full name and the email address of your witness.');
    setBusy(true);
    setError('');
    try {
      await api(`${base}/witness`, { body: { witness_id: w.id, name: name.trim(), email: email.trim() } });
      setEdit(false);
      toast(after ? `Done. We emailed ${name.trim()}.` : `${name.trim()} is your witness. We email them straight after you finish.`);
      onNamed();
    } catch (e: any) {
      setError(e?.message || 'Something went wrong on our side. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`notice ${open ? 'warn' : ''} wt-card`} role="group" aria-labelledby={`${ids}-h`}>
      <h3 id={`${ids}-h`}>{w.state === 'absent' ? `${w.absent_name} said they were not there` : title}</h3>
      {w.state === 'absent' && <p className="wt-note">{otherOk ? 'So your signature still needs one more witness.' : 'So the document is not witnessed yet.'} If someone else was with you and watched you sign, name them here and we email them. If nobody else saw you sign, ask the sender what to do: you may have to sign again with a witness there.</p>}
      {!edit && w.name && w.state !== 'absent' && (
        <p className="wt-who"><b>{w.name}</b> <span className="muted">({w.email})</span>{' '}
          {w.state === 'asked' ? 'has been emailed and is asked to confirm that they saw you sign.' : w.state === 'waiting' ? 'is emailed straight after you finish.' : ''}</p>
      )}
      {!edit && w.may_name && w.name && w.state !== 'absent' && <button type="button" className="btn sm" style={{ minHeight: 44 }} aria-label={title === 'Your witness' ? undefined : `Change ${title.toLowerCase()}`} onClick={() => (setName(w.name), setEmail(w.email), setEdit(true))}>Change witness</button>}
      {edit && (
        <div className="wt-form">
          {!whoId && <p className="muted small wt-note" id={`${ids}-who`}>{WHO_MAY_WITNESS}</p>}
          <div className="row">
            <label><span>Witness&rsquo;s full name</span><input dir="auto" value={name} maxLength={120} autoComplete="off" aria-describedby={whoId || `${ids}-who`} onChange={(e) => (setName(e.target.value), setError(''))} /></label>
            <label><span>Witness&rsquo;s email address</span><input type="email" inputMode="email" value={email} maxLength={254} autoComplete="off" onChange={(e) => (setEmail(e.target.value), setError(''))} /></label>
          </div>
          {error && <div className="notice err sg-problem" role="alert">{error}</div>}
          <div className="wt-actions">
            <button type="button" className={many ? 'btn' : 'btn primary'} style={{ minHeight: 44 }} disabled={busy} onClick={save}>{busy ? 'Saving' : after ? 'Name and email them' : 'Save witness'}</button>
            {w.name && w.state !== 'absent' && <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy} onClick={() => setEdit(false)}>Keep {w.name}</button>}
          </div>
        </div>
      )}
      {last && <p className="muted small wt-note">{WITNESS_RECORDS}</p>}
    </div>
  );
}

/** After the signer's Finish: what became of their witness, and a way to name another one after "not there". */
export function WitnessAfter({ me, base, onNamed }: { me: any; base: string; onNamed: () => void }) {
  const list = witnessesOf(me);
  return <>{list.map((w, i) => <OneWitnessAfter key={w.id || i} w={w} title={placeName(i, list.length)} base={base} onNamed={onNamed} last={i === list.length - 1} many={list.filter((x) => x?.state === 'absent' || (x?.state === 'open' && x.may_name)).length > 1} otherOk={list.some((x, j) => j !== i && x?.name && x.state !== 'absent')} />)}</>;
}

function OneWitnessAfter({ w, title, base, onNamed, last, many, otherOk }: { w: any; title: string; base: string; onNamed: () => void; last: boolean; many: boolean; otherOk: boolean }) {
  if (!w) return null;
  if (w.state === 'absent' || (w.state === 'open' && w.may_name)) return <OneWitnessName w={w} title={title} base={base} onNamed={onNamed} after last={last} many={many} otherOk={otherOk} />;
  return (
    <div className="notice wt-card" role="status">
      <h3>{title}</h3>
      <p className="wt-who">{w.state === 'done' ? <><b>{w.name}</b> confirmed that they saw you sign, and signed as your witness.</> : <><b>{w.name}</b> has been emailed and is asked to confirm that they were with you and saw you sign. We tell you if they say they were not there.</>}</p>
      {last && <p className="muted small wt-note">{WITNESS_RECORDS}</p>}
    </div>
  );
}
