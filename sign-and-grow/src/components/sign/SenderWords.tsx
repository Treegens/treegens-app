'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { CONSENT_WORDS, wordsIn } from '@/components/sign/actions';

// The sender's own message and private note on the consent screen. The screen holds 120 words or fewer before the
// tick with every option on (research/ux-charter.md P7, and its correction in research/ux.json "ux:check"). Our own
// words take most of that, so the sender's words are shown in full only while the whole screen stays at or under the
// cap. Otherwise they wait behind one line, "Read the message", one tap away, and nothing of them is lost.
// The count is taken from the screen itself, the way tests/ux/flows.cjs takes it: every word from the top of the
// screen down to the tick, whatever else is on it (a group's note, the in-person notice, a long subject).
export function SenderWords({ sender, message, note }: { sender: string; message?: string | null; note?: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [fold, setFold] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const tick = box.current?.closest('.sg-shell')?.querySelector('input[type=checkbox]');
    if (!tick) return;
    const range = document.createRange();
    range.setStart(document.body, 0);
    range.setEndBefore(tick.closest('label') || tick);
    if (wordsIn(range.toString()) > CONSENT_WORDS) setFold(true);
  }, [message, note]);
  if (!message && !note) return null;
  const words = (
    <>
      {message && <div className="sg-quote"><span className="muted small">Message</span><span dir="auto">{message}</span></div>}
      {note && <div className="notice sg-gap"><b>Private note for you:</b> <span dir="auto">{note}</span></div>}
    </>
  );
  if (!fold) return <div ref={box}>{words}</div>;
  // Closed, the words are not on the screen at all, so a screen reader does not read them out before the tick either.
  return (
    <details className="sg-fold" data-fold open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      {/* Three words, and the sender only in the label a screen reader says: the screen names them once, just above. */}
      <summary aria-label={`Read the ${message ? 'message' : 'note'} from ${sender}`}>{message ? 'Read the message' : 'Read the note'}</summary>
      {open && words}
    </details>
  );
}
