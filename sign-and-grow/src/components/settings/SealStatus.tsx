'use client';
// Settings, Records and data: one read-only line for admins about the digital seal of completed PDFs, once the
// people who run the server have set it up (GET /seal, src/server/routes-seal.ts). Nothing to change here, and
// nothing at all on a server without seal settings or for a member.
import { api, useLoad } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

const ui = SOURCE_LOCALE;
const day = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

export function SealStatus() {
  const me = useMe();
  const admin = me.role !== 'member';
  const [s] = useLoad<any>(() => (admin ? api('/seal').catch(() => null) : Promise.resolve(null)), [admin]);
  if (!s?.set) return null;
  return (
    <section className="card" data-feature="ds-seal" data-item="card" aria-labelledby="seal-status-h">
      <h2 id="seal-status-h">{t(ui, 'seal.status.name')}</h2>
      {s.on ? (
        <p className="muted" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>
          {t(ui, 'seal.status.on', { name: s.by, issuer: s.issuer })} {t(ui, s.time_stamp ? (s.time_stamp_trusted ? 'seal.time.stamp' : 'seal.time.stamp_unchecked') : 'seal.time.clock')} {t(ui, 'seal.status.until', { day: day(s.until) })}
        </p>
      ) : (
        <p className="notice warn" role="status" style={{ marginTop: 6 }}>{t(ui, 'seal.status.off')}</p>
      )}
    </section>
  );
}
