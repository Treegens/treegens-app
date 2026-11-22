'use client';
// Settings, Sending: one read-only card for admins, "Connections", once the people who run the server have set up
// WhatsApp or calls with a code (src/lib/channels.ts, GET /me). Nothing to change here, and nothing at all on a
// server without them or for a member (research/ux-charter.md 2.2, Connections).
import { useMe } from '@/components/AppShell';
import { useST, senderRich } from '@/components/senderLang';

export function ChannelsStatus() {
  const me = useMe();
  const T = useST();
  if (me.role === 'member' || (!me.whatsapp && !me.phone_calls)) return null;
  return (
    <section className="card" data-feature="ds-channels" data-item="card" aria-labelledby="channels-status-h">
      <h2 id="channels-status-h">{T('settings.channels.title')}</h2>
      {me.whatsapp && <p className="muted" style={{ marginTop: 6 }}>{senderRich(T.lang, 'settings.channels.whatsapp', { what: <b>{T('settings.channels.whatsapp_name')}</b> }, { count: me.whatsapp_daily ?? 100 })}</p>}
      {me.phone_calls && <p className="muted" style={{ marginTop: 6 }}>{senderRich(T.lang, 'settings.channels.calls', { what: <b>{T('settings.channels.calls_name')}</b> })}</p>}
    </section>
  );
}
