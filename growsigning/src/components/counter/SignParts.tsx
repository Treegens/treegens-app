'use client';
import { useEffect } from 'react';
import { Shell, StateCard } from '@/components/sign/parts';

// Parts of the signing page for someone signing at a service counter (src/server/counter.ts).

/**
 * The done screen's words. After Finish the link used at the counter is closed (counterFinished), so there is no
 * View or Download here: the copy goes to the person's own email, with a link only they have.
 */
export function CounterCopy({ allDone }: { allDone: boolean }) {
  return (
    <p>
      {allDone
        ? 'Your copy, with its certificate, is on its way to the email address you gave.'
        : 'Your copy is emailed to the address you gave once everyone on the document has signed.'}
    </p>
  );
}

/** While the official has not recorded who is signing yet: a wait, not a problem. It asks again by itself. */
export function CounterWait({ message, onRetry }: { message: string; onRetry: () => void }) {
  useEffect(() => {
    const t = setInterval(onRetry, 4000);
    return () => clearInterval(t);
  }, [onRetry]);
  return (
    <Shell>
      <StateCard tone="wait" title="Waiting for the official">
        <p role="status">{message}</p>
        <button type="button" className="btn lg" onClick={onRetry}>Check again now</button>
      </StateCard>
    </Shell>
  );
}
