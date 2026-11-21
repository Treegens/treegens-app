'use client';
// The top of the consent screen: who asks, the document, who it is from, who it is for, and the sender's own words.
// The screen holds 120 words or fewer before the tick (research/ux-charter.md P7, corrected in research/ux.json
// "ux:check"). Our legal sentences are fixed, so when a long subject, a long name or a message pushes the screen over,
// the least useful words go first, one step at a time, and only as far as needed:
//   1. the person's own email address in the "For" line (it is the address the invitation reached them at),
//   2. the sender's message, folded behind "Read the message" (one tap away, nothing lost),
//   3. "Please sign: ", the app's own default start of a subject, in the heading,
//   4. the "For" line itself (never for a group, and never when the sender handed the link over in person).
// The count is taken once from the screen itself, the way tests/ux/flows.cjs takes it (every word from the top of the
// page down to the tick), and the steps it needs are worked out from that one count (consentFit in
// src/lib/consentfit.ts).
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CONSENT_WORDS, wordsIn } from '@/components/sign/actions';
import { SenderWords } from '@/components/sign/SenderWords';
import { groupFor } from '@/components/sign/GroupNotice';
import { orgOf } from '@/lib/sendername';
import { consentFit, headingFor, splitAsk } from '@/lib/consentfit';

/** A word joiner: the full stop after the address (an inline block) never wraps onto a line of its own. */
const NO_BREAK = '\u2060';

export function ConsentTop({ data, ask, myEmail }: { data: any; ask: string; myEmail: ReactNode }) {
  const env = data.envelope;
  const me = data.recipient;
  const sender = env.sender || {};
  const top = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(0);
  const hasWords = !!(data.message || data.note);
  useLayoutEffect(() => {
    if (level) return;
    const root = top.current;
    const tick = root?.closest('.sg-shell')?.querySelector('input[type=checkbox]');
    if (!root || !tick) return;
    const range = document.createRange();
    range.setStart(document.body, 0);
    range.setEndBefore(tick.closest('label') || tick);
    const part = (k: string) => wordsIn(root.querySelector(`[data-fit="${k}"]`)?.textContent || '');
    const need = consentFit(wordsIn(range.toString()), CONSENT_WORDS, { email: part('email'), words: hasWords ? part('words') : 0, prefix: part('prefix'), forLine: part('for') });
    if (need) setLevel(need);
  }, [level, hasWords, data.message, data.note, env.subject]);

  // A heading for someone who is not asked to sign never starts with the app's "Please sign: " (headingFor).
  const heading = headingFor(env.subject, !!ask);
  const { prefix, rest } = splitAsk(heading);
  const org = orgOf(data.brand?.name, sender.name);
  const group = groupFor(data);
  // Only the plain line may go: a group's name, and the note that the sender handed over the link, always stay.
  const plainFor = !group && !me.link_by_sender;
  return (
    <div ref={top}>
      {ask && <p className="sg-kicker">{ask}</p>}
      <h1 className="serif" id="sg-h1" tabIndex={-1}>{prefix && level < 3 ? <span data-fit="prefix">{prefix}</span> : null}{rest}</h1>
      <p className="sg-from">From <b>{sender.name}</b>{org ? <> at {org}</> : null}, <a href={`mailto:${sender.email}`}>{sender.email}</a></p>
      {/* "Report this request" is in the footer of every screen, so it is not said a second time here. */}
      {/* In person the notice below says whose turn it is, so "For ..." is not said as well. */}
      {me.role !== 'inperson' && !(plainFor && level >= 4) && (
        <p className="muted small sg-for" data-fit={plainFor ? 'for' : undefined}>
          {group || (me.link_by_sender
            ? <>For {me.name}. {sender.name} sent you the link themselves, not by email from us.</>
            : <>For {me.name}{level < 1 ? <span data-fit="email">, {myEmail}</span> : null}{NO_BREAK}.</>)}
        </p>
      )}
      {/* The sender's own words, in full while the screen stays at 120 words before the tick, else one tap away. */}
      <div data-fit="words"><SenderWords sender={sender.name} message={data.message} note={data.note} fold={level >= 2} /></div>
    </div>
  );
}
