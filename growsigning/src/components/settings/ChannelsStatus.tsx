'use client';
// Settings, Sending: one read-only card for admins, "Codes by phone call", once the people who run the server have set up
// calls with a code (src/lib/channels.ts, GET /me). No account gets WhatsApp, so it has no line here. Nothing to change here, and nothing at all on a
// server without them or for a member (research/ux-charter.md 2.2, Connections).
import { useMe } from '@/components/AppShell';
import { useST } from '@/components/senderLang';

export function ChannelsStatus() {
  const me = useMe();
  const T = useST();
  if (me.role === 'member' || !me.phone_calls) return null;
  return (
    <section className="card" data-feature="ds-channels" data-item="card" aria-labelledby="channels-status-h">
      <h2 id="channels-status-h">{T('settings.channels.title')}</h2>
      {me.phone_calls && <p className="muted" style={{ marginTop: 6 }}>{T('settings.channels.calls')}</p>}
    </section>
  );
}
