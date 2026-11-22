'use client';
// The words of one comment, on the signing page and on the sender's envelope page. A long one is folded to a few
// lines with a button to read it all, so one person's very long comment never pushes every other conversation (and
// what the page has to say) far down the screen.
import { useState } from 'react';

const FOLD_CHARS = 600, FOLD_LINES = 8;

export function CommentBody({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  if (text.length <= FOLD_CHARS && lines.length <= FOLD_LINES) return <p className="cm-body" dir="auto">{text}</p>;
  return (
    <>
      <p className="cm-body" dir="auto">{open ? text : `${lines.slice(0, FOLD_LINES).join('\n').slice(0, FOLD_CHARS)}...`}</p>
      <button type="button" className="btn sm cm-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Show less' : `Show all ${text.length} characters`}</button>
    </>
  );
}
