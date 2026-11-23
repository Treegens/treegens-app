'use client';
// "How electronic signing works": everything our consent wording says beyond the one sentence next to the tick
// (src/lib/policy.ts, wording 2026-11-23 and later). On the consent screen it is one plain link, closed when the
// screen opens. One tap opens it in place: what kind of signature this is, what is recorded, that some documents need
// more than this, how to get a copy or paper, and how to say no. The words come with the wording's version, the
// version goes back with the agreement, so the record names what the person ticked and what they could open here.
//
// Closed, the words are not on the screen at all, like the account's own terms (OwnTerms.tsx): a screen reader does
// not read them before the tick, and the count of words before the tick (ConsentTop.tsx) is of what is shown.
import { useState } from 'react';
import type { ConsentWording } from '@/lib/policy';

type Words = Pick<ConsentWording, 'details' | 'language'>;

/** The parts, opened: a short heading and its sentences. /help prints the same, always open. */
export function ConsentDetailWords({ wording }: { wording: Words }) {
  return (
    <div className="sg-how-body" lang={wording.language}>
      {wording.details.map((d) => (
        <div key={d.h} className="sg-how-part">
          <b>{d.h}</b>
          {d.lines.map((l, i) => <p key={i}>{l}</p>)}
        </div>
      ))}
    </div>
  );
}

/** The link (under Continue on the consent screen) and, once tapped, the parts under it. Nothing for a wording that prints everything above the tick. */
export function ConsentDetails({ wording }: { wording: Words & Pick<ConsentWording, 'more'> }) {
  const [open, setOpen] = useState(false);
  if (!wording.details.length) return null;
  return (
    <details className="sg-fold sg-how" data-fold open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary lang={wording.language}>{wording.more}</summary>
      {open && <ConsentDetailWords wording={wording} />}
    </details>
  );
}
