'use client';
import { useEffect, useRef, useState } from 'react';

// "They filled everything in and never pressed Finish." The first time nothing required is left, the step "Check
// before you finish" opens by itself, so the last field leads straight to the one button that signs.
//
// Three rules keep that from getting in anyone's way:
//   - Once for each visit. Someone who goes back to change an answer is not interrupted again, and the Finish
//     button at the bottom stays where it was.
//   - Never under someone's fingers. While a field that is typed or chosen in still has the focus, nothing opens:
//     the step comes when they leave the field.
//   - Never a signature by accident. When the step opens by itself, the focus goes to the step as a whole and not to
//     its Finish button, so an Enter or a space that was on its way to something else cannot finish the document.
//     Someone who presses Finish themselves gets the button, as before.

const TYPED_IN = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=file]), textarea, select';
/** How long the page waits after the last field, so the mark that was just placed is seen before the step covers it. */
export const AUTO_REVIEW_DELAY_MS = 700;

/** Moves the focus from the button the dialog chose to the dialog itself. Tried for a few frames, until it is there. */
function focusTheStep(tries = 20) {
  const panel = document.querySelector<HTMLElement>('.sg-dialog[role="dialog"]');
  const at = document.activeElement;
  if (panel && at instanceof HTMLElement && panel.contains(at)) {
    if (at !== panel && at.hasAttribute('data-autofocus')) panel.focus({ preventScroll: true });
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusTheStep(tries - 1));
}

/**
 * `ready` is true while nothing required is left, the pages are on the screen and nothing else is open. `show` opens
 * the step exactly as the Finish button does.
 */
export function useAutoReview(ready: boolean, show: () => void) {
  const shown = useRef(false);
  const latest = useRef(show);
  latest.current = show;
  const [leftField, setLeftField] = useState(0);
  useEffect(() => {
    if (!ready || shown.current) return;
    const at = document.activeElement;
    if (at instanceof HTMLElement && at.matches(TYPED_IN)) {
      const done = () => setLeftField((n) => n + 1);
      at.addEventListener('blur', done, { once: true });
      return () => at.removeEventListener('blur', done);
    }
    const timer = setTimeout(() => {
      shown.current = true;
      latest.current();
      focusTheStep();
    }, AUTO_REVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready, leftField]);
}
