'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate } from '@/components/ui';

// A person named on this envelope said they did not sign it, or that it was not them (src/server/evidence.ts). The
// envelope page says so at the top, with the audit lines and with what each person wrote, word for word (GET
// /envelopes/:id/disputes). Never the internet address or browser they wrote from: those are for the people who run
// the service only, and the person was told so before they sent it. The mark stays for the envelope's life.
export function Disputed({ envelope, audit }: { envelope: any; audit: any[] }) {
  const [said, setSaid] = useState<any[] | null>(null);
  useEffect(() => {
    if (!envelope.disputed_at) return;
    api(`/envelopes/${envelope.id}/disputes`).then((r: any) => setSaid(r.disputes || []), () => setSaid(null));
  }, [envelope.id, envelope.disputed_at]);
  if (!envelope.disputed_at) return null;
  const lines = (audit || []).filter((a: any) => a.action === 'Disputed' || a.action === 'Dispute closed');
  const open = said ? said.some((d: any) => !d.closed_at) : true;
  return (
    <section className="notice warn" role="note" aria-labelledby="sn-disputed-h">
      <h2 id="sn-disputed-h" style={{ fontSize: 17, margin: '0 0 6px' }}>Disputed since {fmtDate(envelope.disputed_at, true)}</h2>
      {lines.map((a: any, i: number) => <p key={i} style={{ margin: '0 0 6px' }}>{fmtDate(a.at, true)}: {a.detail}</p>)}
      {(said || []).filter((d: any) => d.detail).map((d: any, i: number) => (
        <blockquote key={i} style={{ margin: '0 0 8px', paddingLeft: 10, borderLeft: '3px solid currentColor', overflowWrap: 'anywhere' }}>
          <p style={{ margin: 0 }}><b>What was written</b> with the dispute about {d.name} on {fmtDate(d.at, true)}, word for word. Nobody has checked it, so do not call a number or open a link in it:</p>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }} dir="auto">{d.detail}</p>
        </blockquote>
      ))}
      <p style={{ margin: '0 0 6px' }}>This envelope shows as disputed here and to anyone who checks it on the Verify page. We do not decide who is right: speak to the person directly, and if it becomes a legal matter, ask a lawyer where you are, because the rules differ by country and by kind of document.{open ? ' While a dispute is open you cannot delete this envelope for good: deleting only takes it out of your lists. A person at Sign&Grow closes the dispute once they have looked into it.' : ''}</p>
      <p style={{ margin: 0 }}>To keep what you have outside Sign&amp;Grow, use <b>Download evidence pack</b> at the top of this page: the signed file, the record, our emails, the disputes and what each person agreed to.</p>
    </section>
  );
}
