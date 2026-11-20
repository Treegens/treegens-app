'use client';
import { fmtDate } from '@/components/ui';

// A person named on this envelope said they did not sign it, or that it was not them (src/server/evidence.ts). The
// envelope page says so at the top, in the words of the audit lines, for as long as the envelope exists: the mark
// never goes away, and nothing was changed or deleted because of it.
export function Disputed({ envelope, audit }: { envelope: any; audit: any[] }) {
  if (!envelope.disputed_at) return null;
  const lines = (audit || []).filter((a: any) => a.action === 'Disputed');
  return (
    <section className="notice warn" role="note" aria-labelledby="sn-disputed-h">
      <h2 id="sn-disputed-h" style={{ fontSize: 17, margin: '0 0 6px' }}>Disputed since {fmtDate(envelope.disputed_at, true)}</h2>
      {lines.map((a: any, i: number) => <p key={i} style={{ margin: '0 0 6px' }}>{fmtDate(a.at, true)}: {a.detail}</p>)}
      <p style={{ margin: '0 0 6px' }}>This envelope now shows as disputed here and to anyone who checks it on the Verify page. What they wrote to us went to the people who run Sign&amp;Grow, not to you. We do not decide who is right: speak to the person directly, and if it becomes a legal matter, ask a lawyer where you are, because the rules differ by country and by kind of document.</p>
      <p style={{ margin: 0 }}>To keep what you have, download the evidence pack below: the signed file, the record, our emails and what each person agreed to.</p>
    </section>
  );
}
