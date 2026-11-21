'use client';
// "Removed Ana Silva. Undo": said in the People card, right under the list, after a person without fields was removed
// with the cross (a person with fields is asked about first). The keyboard lands on Undo, since the cross it was on is
// gone, so one Enter brings them back with everything typed for them. The line goes with the next removal, when Undo
// is pressed, or when the step is left.
import { useEffect, useRef } from 'react';
import { personInSentence } from '@/lib/editorux';
import { MAX_RECIPIENTS, type Ed } from './shared';

export function RemovedLine({ ed }: { ed: Ed }) {
  const undo = useRef<HTMLButtonElement>(null);
  const gone = ed.removed;
  useEffect(() => {
    if (gone) undo.current?.focus();
  }, [gone]);
  // Bringing them back must not go past the most people one document can have.
  if (!gone || ed.rcps.length >= MAX_RECIPIENTS) return null;
  return (
    <p className="small ed-removed" role="status" data-ed-removed style={{ margin: '10px 0 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span>Removed {personInSentence(gone.r)}.</span>
      <button ref={undo} type="button" className="btn sm ghost" style={{ minHeight: 44 }} onClick={ed.undoRemove}>Undo</button>
    </p>
  );
}
