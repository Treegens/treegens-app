'use client';
// Settings, Records and data: one read-only line for admins about the digital seal of completed PDFs, once the
// people who run the server have set it up (GET /seal, src/server/routes-seal.ts). Nothing to change here, and
// nothing at all on a server without seal settings or for a member.
import { api, useLoad } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { useST } from '@/components/senderLang';
import { screenLocale } from '@/lib/dates';

const day = (s: string) => new Date(s).toLocaleDateString(screenLocale(), { day: 'numeric', month: 'long', year: 'numeric' });

export function SealStatus() {
  const me = useMe();
  const T = useST();
  const admin = me.role !== 'member';
  const [s] = useLoad<any>(() => (admin ? api('/seal').catch(() => null) : Promise.resolve(null)), [admin]);
  if (!s?.set) return null;
  return (
    <section className="card" data-feature="ds-seal" data-item="card" aria-labelledby="seal-status-h">
      <h2 id="seal-status-h">{T('seal.status.name')}</h2>
      {s.on ? (
        <p className="muted" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
          {T('seal.status.on', { name: s.by, issuer: s.issuer })} {T(s.time_stamp ? (s.time_stamp_trusted ? 'seal.time.stamp' : 'seal.time.stamp_unchecked') : 'seal.time.clock')} {T('seal.status.until', { day: day(s.until) })}
        </p>
      ) : (
        <p className="notice warn" role="status" style={{ marginTop: 6 }}>{T('seal.status.off')}</p>
      )}
    </section>
  );
}
