/**
 * A Google connection that Google said would end on a set day (refreshExpiresAt, kept when it was made). That
 * is what Google does while the app's consent screen is still in "Testing": after 7 days the connection stops,
 * no times are offered and bookings stop reaching the calendar. The owner is emailed two days and one day
 * before, while there is still time to publish the app and reconnect. Run by the scheduled housekeeping.
 */
import type { Host } from '../../shared/types';
import type { Ctx } from './ctx';
import { accountsOf } from './googleAccounts';
import { enqueueJob } from './jobs';
import { claim, getSite, releaseClaim } from './repo';
import { firstName } from './templates';
import { DAY_MS, formatInZone, isValidZone } from './time';

/** Messages are queued as text: anything that looks like a template placeholder stays as typed. */
function literal(text: string): string {
  return text.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
}

/** Emails the owner about every working connection that ends within two days, once two days before and once the day before. */
export async function remindEndingConnections(ctx: Ctx, hosts: Host[]): Promise<{ reminded: number }> {
  const site = await getSite(ctx);
  const owner = hosts.find((h) => h.id === site.ownerHostId) ?? hosts.find((h) => h.role === 'owner') ?? null;
  const zone = owner && isValidZone(owner.timezone) ? owner.timezone : 'UTC';
  const nowMs = ctx.now().getTime();
  let reminded = 0;
  for (const host of hosts) {
    for (const { account } of accountsOf(host)) {
      const ends = Date.parse(account.refreshExpiresAt ?? '');
      if (account.status !== 'ok' || !Number.isFinite(ends) || ends <= nowMs || ends - nowMs > 2 * DAY_MS) continue;
      const tomorrow = ends - nowMs <= DAY_MS;
      // One per end date and step: a reconnect brings a new end date (or none), and with it new reminders.
      const once = `google-ends-${account.id}-${account.refreshExpiresAt}-${tomorrow ? 1 : 2}`;
      if (!(await claim(ctx, once))) continue;
      const mine = host.id === owner?.id;
      const first = firstName(host.name) || 'your co-host';
      const day = formatInZone(ends, zone, 'date');
      const body = [
        'Hi {{host_first_name}},',
        literal(
          `Google said when ${mine ? 'you' : first} connected ${account.email} that the connection ends on ${day}. After that, no times are offered for meetings with ${mine ? 'you' : first} and new bookings stop reaching ${mine ? 'your' : `${first}'s`} calendar.`,
        ),
        literal(
          `That usually means your Google Cloud app is still in Testing, where a connection lasts 7 days. Publish it now (Google Auth Platform, Audience, then Publish app, so it reads In production), then ${mine ? 'reconnect under Integrations' : `ask ${first} to connect again from their private link`}. Reconnecting without publishing only lasts another 7 days. If a time limit was chosen on Google's screen instead, connecting again and allowing ongoing access is enough.`,
        ),
      ].join('\n\n');
      try {
        await enqueueJob(ctx, {
          type: 'message',
          kind: 'host_alert',
          bookingId: '',
          channel: 'email',
          audience: 'host',
          subject: literal(`${mine ? 'Your' : `${first}'s`} Google connection ends ${tomorrow ? 'tomorrow' : 'in two days'}: ${account.email}`),
          body,
          dueAt: new Date(nowMs).toISOString(),
        });
        reminded++;
      } catch (err) {
        await releaseClaim(ctx, once).catch(() => undefined);
        throw err;
      }
    }
  }
  return { reminded };
}
