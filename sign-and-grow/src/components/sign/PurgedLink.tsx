'use client';
// What a signing link says once its envelope was purged (src/server/records.ts): the sender deleted the document,
// nothing is left here to open, and where a copy may still be. The words are PURGED_LINK in src/lib/retention.ts,
// which the server sends too.
import Link from 'next/link';
import { Shell, StateCard } from './parts';
import { PURGED_LINK } from '@/lib/retention';

export function PurgedLink({ day }: { day?: string | null }) {
  return (
    <Shell>
      <StateCard tone="stop" title="The sender deleted this document">
        <p>{PURGED_LINK}</p>
        {day && <p className="muted small">Deleted on {day}.</p>}
        <p className="muted small">The sender decides how long their documents are kept, so questions about this one are for them. For anything else, use <Link href="/help?topic=signing#contact">the help page</Link>.</p>
      </StateCard>
    </Shell>
  );
}
