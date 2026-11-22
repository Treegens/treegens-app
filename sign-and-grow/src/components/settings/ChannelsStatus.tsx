'use client';
// Settings, Sending: one read-only card for admins, "Connections", once the people who run the server have set up
// WhatsApp or calls with a code (src/lib/channels.ts, GET /me). Nothing to change here, and nothing at all on a
// server without them or for a member (research/ux-charter.md 2.2, Connections).
import { useMe } from '@/components/AppShell';

export function ChannelsStatus() {
  const me = useMe();
  if (me.role === 'member' || (!me.whatsapp && !me.phone_calls)) return null;
  return (
    <section className="card" data-feature="ds-channels" data-item="card" aria-labelledby="channels-status-h">
      <h2 id="channels-status-h">Connections</h2>
      {me.whatsapp && <p className="muted" style={{ marginTop: 6 }}><b>WhatsApp:</b> senders can have us send the signing link by WhatsApp to people who agreed to it, chosen under &ldquo;How they get it&rdquo;. Up to {me.whatsapp_daily ?? 100} messages a day for this account.</p>}
      {me.phone_calls && <p className="muted" style={{ marginTop: 6 }}><b>Calls with a code:</b> someone checked with a code by text message can ask for a call that reads the code out instead, for a landline.</p>}
    </section>
  );
}
