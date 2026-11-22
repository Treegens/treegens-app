'use client';
import Link from 'next/link';
import { ROLE_LABEL, fmtDate, api, useLoad, oops } from '../ui';
// The sentence for "none left because some expired" (plain words, no environment).
import { expiredWords } from '@/lib/policy';
import { useMe } from '../AppShell';
import { PRICING, mangrovesFor } from '@/lib/impact';
import { scanWarning } from '@/lib/scans';
import type { Outcome } from './changes';
import { plural, type Ed } from './shared';
import { PaperCheck, EnoughLink } from './PaperCheck';
// The subject and message, the step's one More options (reminders, deadline, dates, payment link) and the saving of this document.
import { SendWords, ReviewMore, SavingBox } from './ReviewParts';
import { PrintCheck } from './PrintCheck';
import { LabelCheck } from './LabelCheck';
import { ChecksCheck } from './ChecksCheck';
import { LogicCheck } from './FieldLogic';
import { CustomFieldsStep } from './CustomFieldsStep';
import { phoneWeight } from '@/lib/phone';
import { isGroupRow, groupLine } from './GroupRecipient';
import { noAddressWords, personLabel } from '@/lib/editorux';
import { isOpenPlace, chooserBefore } from '@/lib/recipienttypes';
import { ConfirmToSend, isConfirmRefusal } from './ConfirmToSend';
// Send later: the button's words once a time is chosen, and a wait before a person (SendLater.tsx).
import { sendLaterLabel, waitNote } from './SendLater';
import { RuleLine } from './RecipientRule';
import { SeeWhatTheySee } from './SeeWhatTheySee';
import { OwnDocsLine } from './OwnDocsChoice';

const TONE: Record<string, string> = { finished: 'completed', sign_again: 'expired', copy_sent: 'completed', unchanged: '', updated: 'sent', new_link: 'expired', held: 'expired', invited: 'sent', waiting: '', removed: 'voided' };

export type ReviewProps = {
  ed: Ed;
  problems: string[];
  busy: boolean;
  changed: boolean;
  /** A message from the server (or about the connection) after a save or send that did not go through. */
  error: string;
  /** People who finished while the sender was editing, when the sender also changed their part. */
  conflict: string[];
  /** Set when the envelope stopped being open while it was being edited. */
  closed: string;
  result: { people: Outcome[]; completes: boolean } | null;
  onSubmit: () => void;
  onRestore: () => void;
  /** Save the changes as they are and ask the people who finished meanwhile to sign again. */
  onSignAgain: () => void;
  onDiscard: () => void;
};

// What this envelope costs in signatures, said before sending rather than after. One signature is held for each
// person who signs (not the sender signing their own document) and is only used when they actually sign.
function SignatureCost({ rcps, correcting }: { rcps: any[]; correcting: boolean }) {
  const me = useMe();
  const [b] = useLoad(() => api('/billing'));
  const s = b?.signatures;
  if (!s) return null; // payments are not connected, so nothing is counted
  const mine = me.user.email.toLowerCase();
  // Signing in person is someone else signing on your device, so it always needs one, whatever address was typed.
  // Free means you, signing under your own name at your own address. A client entered under your address is not you.
  const same = (x: string, y: string) => (x || '').trim().replace(/\s+/g, ' ').toLowerCase() === (y || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const signers = rcps.filter((r) => r.role === 'inperson' || (r.role === 'signer' && !((r.email || '').trim().toLowerCase() === mine && same(r.name, me.user.name))));
  // When correcting, signers who were already asked are already held; only new ones need another signature.
  const need = signers.filter((r) => !correcting || !r.status).length;
  const have = Math.max(0, s.available);
  const each = (n: number) => `${n} signature${n === 1 ? '' : 's'}`;
  if (need === 0)
    return <div className="notice">{correcting ? 'No new signers were added. If a change turns someone into a signer, or points your own signature at somebody else, that is checked when you save.' : 'This document uses none of your signatures. Signing your own documents, approving, viewing and copies are always free.'}</div>;
  if (need > have) {
    // Out of signatures: say so before the Send button does, and put every way forward on the table.
    const short = need - have;
    const admin = me.role !== 'member';
    const next = b.free_next_at || b.renews_at;
    const pay = (path: string, body?: any) => api(path, { method: 'POST', body }).then((r) => { window.location.href = r.url; }).catch(oops);
    return (
      <div className="notice warn" role="alert">
        <b>This needs {each(need)} and you have {have} ready.</b> {b.renewal_pending ? `Your new month's ${PRICING.monthlySignatures} arrive when the renewal payment goes through, usually within the hour. ` : have === 0 && expiredWords(b.last_expiry) ? `${expiredWords(b.last_expiry)} ` : ''}Nothing is charged unless you choose it, and your work here is saved. You can:
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {b.plan === 'grove'
            ? <li><b>Top up {each(short)} for ${short * PRICING.topUpUsd}.</b> One payment, nothing recurring, and it plants {mangrovesFor(short * PRICING.topUpUsd)} mangrove trees.{!admin && ' An owner or admin of your team can do this on the Plan page.'}</li>
            : <li><b>Start the monthly plan:</b> ${PRICING.monthlyUsd} a month for {PRICING.monthlySignatures} signatures, month to month, and every dollar plants {PRICING.treesPerUsd} mangrove trees.{!admin && ' An owner or admin of your team can do this on the Plan page.'}</li>}
          {s.held > 0 && <li><b>Free some up.</b> {each(s.held)} {s.held === 1 ? 'is' : 'are'} held for people who have not signed yet. Cancelling a document you no longer need (Cancel the request, in More on its page) gives its signatures back at once, unless their own date has passed (then they expire instead).</li>}
          {next && !b.renewal_pending && Date.parse(next) > Date.now() && b.plan === 'grove' && <li><b>Wait.</b> The next {each(PRICING.monthlySignatures)} arrive on {fmtDate(next)}.</li>}
          <li><b>Send to fewer people now.</b> Signing your own copy, approvers, viewers and copies are always free.</li>
        </ul>
        <div className="row wrap" style={{ marginTop: 10 }}>
          {admin && b.enabled && b.plan === 'grove' && <button type="button" className="btn sm primary" onClick={() => pay('/billing/topup', { quantity: short })}>Pay ${short * PRICING.topUpUsd} and add {each(short)}</button>}
          {admin && b.enabled && b.plan !== 'grove' && <button type="button" className="btn sm primary" onClick={() => pay('/billing/checkout')}>Start the plan for ${PRICING.monthlyUsd} a month</button>}
          <Link href="/app/settings?tab=billing" className="btn sm">Open the Plan page</Link>
        </div>
      </div>
    );
  }
  // Enough are left: nothing to decide here, so nothing is said (research/ux-notes.json "expiry"). The count is under
  // the account name and on Home, and the rules are on the Plan page.
  return null;
}

// Two people on one envelope with the same address: allowed (couples often share one), but worth saying.
function SharedInbox({ rcps }: { rcps: any[] }) {
  const byEmail = new Map<string, string[]>();
  for (const r of rcps) {
    const e = (r.email || '').trim().toLowerCase();
    if (e && r.role !== 'cc') byEmail.set(e, [...(byEmail.get(e) || []), r.name || 'Someone without a name yet']);
  }
  const shared = [...byEmail.entries()].filter(([, names]) => names.length > 1);
  if (!shared.length) return null;
  return (
    <div className="notice warn">
      {shared.map(([email, names]) => <div key={email}><b>{names.join(' and ')} share {email}.</b></div>)}
      Each of them gets a separate email that says who it is for, with their own link and their own fields. Anyone who can read that inbox can open both, so give each person their own access code (step 1, More) if it matters who signs which.
    </div>
  );
}

// Step 3: one last look. For a draft that means "send"; for an envelope that is already out it spells out what
// saving will do to each person before anything happens.
export function StepReview({ ed, problems, busy, changed, error, conflict, closed, result, onSubmit, onRestore, onSignAgain, onDiscard }: ReviewProps) {
  const { env, isTpl, correcting, docs } = ed;
  // The empty row of step 1 that nobody typed into is not a person on the document (Editor.tsx isIdle).
  const rcps = ed.rcps.filter((r) => !ed.isIdle(r));
  const fields = ed.fields.value;
  const pages = docs.reduce((n, d) => n + d.pages, 0);
  const sorted = [...rcps].sort((a, b) => (env.ordered ? a.routing_order - b.routing_order : 0));
  const blocked = busy || problems.length > 0 || !!closed || conflict.length > 0 || (correcting && !changed);
  const label = isTpl ? 'Save template' : correcting ? (busy ? 'Saving…' : 'Save changes') : busy ? (ed.signNow ? 'Opening…' : 'Sending…') : ed.signNow ? 'Sign now' : sendLaterLabel(ed) || 'Send';

  return (
    <div className="main stack ed-narrow ed-review">
      {closed && (
        <div className="notice err" role="alert">
          <b>This document is {closed} now, so it can no longer be changed.</b> Nothing you did here was sent. <Link href={`/app/envelopes/${env.id}`}>Go to the document</Link> to see where it stands.
        </div>
      )}
      {conflict.length > 0 && (
        <div className="notice err" role="alert">
          <b>{conflict.join(' and ')} finished while you were editing.</b> Some of your changes touch what they signed, so nothing was saved. Your changes are still here. Put the files and fields back as they were signed and keep the rest of your changes, or save everything and ask {conflict.join(' and ')} to sign again.
          <div className="row wrap" style={{ marginTop: 10 }}>
            <button type="button" className="btn sm" onClick={onRestore}>Put the files and fields back</button>
            <button type="button" className="btn sm" disabled={busy || problems.length > 0} onClick={onSignAgain}>Save and ask {conflict.join(' and ')} to sign again</button>
          </div>
        </div>
      )}
      {/* An address that is not confirmed yet: the code box is here, where Send is (ConfirmToSend.tsx). */}
      {!isTpl && !correcting && !closed && <ConfirmToSend refused={isConfirmRefusal(error)} button={ed.signNow ? 'Sign now' : 'Send'} />}
      {error && !closed && !isConfirmRefusal(error) && <div className="notice err" role="alert"><b>{correcting ? 'Not saved yet.' : isTpl ? 'Not saved yet.' : 'Not sent yet.'}</b> {error} Your changes are still here.</div>}
      {problems.length > 0 && <div className="notice warn"><b>Almost there.</b><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
      {!isTpl && !closed && rcps.length > 0 && <SignatureCost rcps={rcps} correcting={correcting} />}
      {!isTpl && <SharedInbox rcps={rcps} />}
      {/* Said once more before it goes out: a document that is a picture cannot be read out to someone who needs that. */}
      {docs.filter((d) => scanWarning(d)).map((d) => (
        <div key={d.id} className="notice warn"><b>{d.name || 'A file'}:</b> {scanWarning(d)} <button type="button" className="btn sm" style={{ marginLeft: 6 }} onClick={() => ed.go(1)}>Go to the files</button></div>
      ))}
      {/* A file large enough to be slow on a phone (src/lib/phone.ts). It warns and never blocks. */}
      {!closed && docs.filter((d) => phoneWeight(d)).map((d) => (
        <div key={`phone-${d.id}`} className="notice warn"><b>{d.name || 'A file'}:</b> {phoneWeight(d)} <button type="button" className="btn sm" style={{ marginLeft: 6 }} onClick={() => ed.go(1)}>Go to the files</button></div>
      ))}
      {/* Fields a screen reader can only name by their type, each with a way to the box where the label is typed. */}
      {!closed && <LabelCheck ed={ed} />}
      {!closed && <LogicCheck ed={ed} />}
      {!closed && <ChecksCheck ed={ed} />}
      {/* The check before sending: a word that often means paper, a witness or a notary. It warns and never blocks. */}
      {!closed && <PrintCheck subject={env.subject || ''} docs={docs} rcps={rcps} fields={fields} />}
      {!closed && <PaperCheck envelopeId={env.id} subject={env.subject || ''} docs={docs} sending={!isTpl && !correcting} />}

      {closed && <div className="card"><h2>{env.subject || '(no subject)'}</h2></div>}
      {/* One link above Who gets it: the signing page as these people will see it, in a new tab (SeeWhatTheySee.tsx). */}
      {!closed && <SeeWhatTheySee ed={ed} people={sorted} changed={changed} />}
      {correcting && result ? (
        <div className="card">
          <h2>What happens when you save</h2>
          <p className="muted small" style={{ margin: '4px 0 12px' }}>
            {!changed ? 'You have not changed anything yet. Go back to make a change, or leave with Discard changes.'
              : result.people.some((p) => p.kind === 'sign_again') ? 'This touches what someone already signed, so they would have to sign again. You are asked before it is saved. Here is what each person will notice.'
              : 'Nobody has to start again. Here is what each person will notice.'}
          </p>
          <ul className="ed-people">
            {result.people.map((p) => (
              <li key={p.id} className={p.kind === 'removed' ? 'gone' : ''}>
                <span className="dot" style={{ background: p.kind === 'removed' ? '#9aa39d' : ed.color(p.id) }} />
                <div className="grow">
                  <div className="row wrap" style={{ gap: 8, rowGap: 2 }}><b className="ed-break">{p.name}</b><span className={`badge ${TONE[p.kind]}`}>{p.badge}</span></div>
                  <div className="muted small ed-break">{p.email || (isGroupRow(rcps.find((x) => x.id === p.id)) ? 'A group: every member has their own email' : 'No email yet')} · {ROLE_LABEL[p.role]}</div>
                  <div className="small" style={{ marginTop: 3 }}>{p.text}</div>
                </div>
              </li>
            ))}
          </ul>
          {result.completes && <div className="notice warn" style={{ marginTop: 12 }}>Everyone who is left has already finished, so saving completes this document and sends the signed copy to everyone.</div>}
        </div>
      ) : (
        <div className="card">
          <h2 style={{ marginBottom: 4 }}>{isTpl ? 'Roles' : 'Who gets it'}</h2>
          <p className="muted small" style={{ margin: 0 }}>{plural(docs.length, 'file')}, {plural(pages, 'page')}{docs.some((d) => d.supplemental) ? <span data-feature="ds-supplements"> ({docs.filter((d) => d.supplemental).length} to read, not sign)</span> : null} · {env.ordered ? 'signed in order' : 'everyone at once'}</p>
          <ul className="ed-people">
            {sorted.map((r) => {
              const n = fields.filter((f) => f.recipient_id === r.id).length;
              return (
                <li key={r.id}>
                  {!!env.ordered && <span className="badge num" aria-label={`Signing order ${r.routing_order}`}>{r.routing_order}</span>}
                  <span className="dot" style={{ background: ed.color(r.id) }} />
                  <div className="grow">
                    <b className="ed-break">{personLabel(r, ed.rcps.indexOf(r))}</b>
                    <div className="muted small ed-break">{isGroupRow(r) && !r.claimed_by ? groupLine(r) : r.email || noAddressWords(r, isTpl, isOpenPlace(r, ed.rcps, !!env.ordered) ? chooserBefore(r, ed.rcps, !!env.ordered)?.name || '' : null)}</div>
                    <div className="small" style={{ marginTop: 3 }}>{ROLE_LABEL[r.role]}{r.access_code ? ' · access code' : ''}{r.verify === 'sms_code' ? ' · code by text message' : r.verify === 'email_code' ? ' · code by email' : ''}{r.text_link ? ' · link also by text' : ''}{r.whatsapp ? ' · link also by WhatsApp' : ''}{n ? ` · ${plural(n, 'field')}` : ''}{waitNote(ed, r) ? ` · ${waitNote(ed, r)}` : ''}</div>
                    {/* A set "Only when..." is one line under its person (RecipientRule.tsx). */}
                    <RuleLine ed={ed} r={r} />
                    {/* With "Each person sees only their files" on: which files this person gets (OwnDocsChoice.tsx). */}
                    <OwnDocsLine ed={ed} r={r} />
                  </div>
                </li>
              );
            })}
            {!sorted.length && <li className="muted small">Nobody yet.</li>}
          </ul>
        </div>
      )}

      {/* Charter 2.3 order (STEP3_ORDER in src/lib/simplicity.ts): who gets it first, then the email they get, typed
          right above the Send button. The account's own references (a case number) go with the title they belong to. */}
      {!closed && <SendWords ed={ed} />}
      {/* Absent when the account has none (CustomFieldsStep.tsx). */}
      {!closed && <CustomFieldsStep ed={ed} />}
      {/* Reminders, the deadline, how dates are written and a payment link: asked once, here, and closed until asked for. */}
      <ReviewMore ed={ed} closed={!!closed} />

      {!isTpl && !correcting && pages > 0 && <SavingBox pages={pages} people={rcps.length} envelopeId={env.id} />}

      <div className="row wrap ed-actions">
        {correcting && <button type="button" className="btn ghost" onClick={onDiscard}>Discard changes</button>}
        <span className="grow" />
        <button type="button" className="btn" onClick={() => ed.go(2)}>Back</button>
        <button type="button" className="btn primary lg" disabled={blocked} onClick={onSubmit}>{label}</button>
      </div>
      {correcting && !changed && !closed && <p className="muted small" style={{ textAlign: 'right' }}>Save changes turns on once you change something.</p>}
      {!isTpl && !correcting && <EnoughLink />}
    </div>
  );
}
