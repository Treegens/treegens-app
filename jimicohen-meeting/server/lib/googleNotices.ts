/**
 * A co-host's private link is a bearer link: whoever holds it can change that co-host's Google accounts.
 * So every account added, and every change of a main account, is announced to the person it affects, and
 * for a co-host to the owner as well, naming the address, the time and where it came from. A refresh of an
 * account that was already there says nothing. The owner changing their own record from their own
 * dashboard gets no notice either.
 */
import { DateTime, IANAZone } from 'luxon';
import type { Host, SiteSettings } from '../../shared/types';
import type { Ctx } from './ctx';
import type { ConnectOutcome } from './googleAccounts';
import { enqueueJob } from './jobs';
import { claim, getSite, listHosts, releaseClaim } from './repo';
import { firstName } from './templates';

/** Messages are queued as text: anything that looks like a template placeholder stays as typed. */
function literal(text: string): string {
  return text.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
}

export interface ConnectionNotice {
  hostId: string;
  accountId: string;
  email: string;
  outcome: ConnectOutcome;
  /** started from the co-host's private link (otherwise from the owner's signed-in dashboard) */
  viaLink: boolean;
  /** with 'replaced': the address of the main account it replaced */
  replacedEmail?: string;
}

/** "16 November at 09:00 (your time)", in the zone of the person reading it. */
function when(ctx: Ctx, zone: string): string {
  const dt = DateTime.fromJSDate(ctx.now(), { zone: IANAZone.isValidZone(zone) ? zone : 'UTC' }).setLocale('en-GB');
  return `${dt.toFormat("d LLLL 'at' HH:mm")} (your time)`;
}

/** Queues the notices one connection calls for. Never throws: the connection itself is saved either way. */
export async function noticeGoogleConnection(ctx: Ctx, n: ConnectionNotice): Promise<number> {
  try {
    const announce = n.outcome === 'added' || n.outcome === 'promoted' || n.outcome === 'replaced' || (n.outcome === 'first' && n.viaLink);
    if (!announce) return 0;
    const [site, hosts] = await Promise.all([getSite(ctx), listHosts(ctx)]);
    const host = hosts.find((h) => h.id === n.hostId);
    if (!host) return 0;
    const isOwner = host.id === site.ownerHostId;
    // The owner's own record, from their own dashboard: they did it themselves.
    if (isOwner && !n.viaLink) return 0;
    const day = ctx.now().toISOString().slice(0, 10);
    const name = `gnotice-${n.hostId}-${n.accountId}-${day}`;
    if (!(await claim(ctx, name))) return 0;
    const owner = hosts.find((h) => h.id === site.ownerHostId) ?? null;
    const jobs = buildNotices(ctx, n, host, owner, site, isOwner);
    try {
      for (const job of jobs) {
        await enqueueJob(ctx, { type: 'message', kind: 'host_alert', bookingId: '', channel: 'email', audience: 'host', hostId: job.hostId, subject: literal(job.subject), body: job.body, dueAt: ctx.now().toISOString() });
      }
    } catch (err) {
      await releaseClaim(ctx, name).catch(() => undefined);
      throw err;
    }
    return jobs.length;
  } catch (err) {
    ctx.log('warn', 'google: could not queue the notice about a new connection', { hostId: n.hostId, error: err instanceof Error ? err.name : 'unknown' });
    return 0;
  }
}

function buildNotices(ctx: Ctx, n: ConnectionNotice, host: Host, owner: Host | null, site: SiteSettings, isOwner: boolean): { hostId: string; subject: string; body: string }[] {
  const out: { hostId: string; subject: string; body: string }[] = [];
  const hostFirst = firstName(host.name) || host.name || 'Your co-host';
  const ownerFirst = firstName(owner?.name ?? '') || owner?.name || site.profile.name || 'The owner';
  const mainChange = n.outcome === 'replaced' || n.outcome === 'promoted';
  const replacedPart = n.outcome === 'replaced' && n.replacedEmail ? ` It replaced ${n.replacedEmail}.` : '';

  // To the person whose record changed.
  const toHost: string[] = ['Hi {{host_first_name}},'];
  if (mainChange) {
    toHost.push(
      literal(
        n.viaLink
          ? `${n.email} is now where your new meetings are added.${replacedPart} This was changed on ${when(ctx, host.timezone)}, from your private link.`
          : `${ownerFirst} made ${n.email} the account your new meetings are added to.${replacedPart}`,
      ),
    );
  } else if (n.viaLink) {
    toHost.push(literal(`${n.email} was connected on ${when(ctx, host.timezone)}, from your private link. Its busy times now count when people book you.`));
  } else {
    toHost.push(literal(`${ownerFirst} connected ${n.email} to your booking page. Its busy times now count when people book you.`));
  }
  if (n.viaLink) toHost.push(isOwner ? 'If this was not you, remove it under Integrations.' : literal(`If this was not you, remove it on your page and ask ${ownerFirst} for a new private link.`));
  out.push({
    hostId: host.id,
    subject: mainChange ? 'Your new meetings go to another Google account' : 'A Google account was connected to your booking page',
    body: toHost.join('\n\n'),
  });

  // And to the owner, about a co-host who changed their own record through the link.
  if (!isOwner && n.viaLink && owner) {
    const ownerZone = owner.timezone || host.timezone;
    const what = mainChange
      ? `${hostFirst} made ${n.email} the account their new meetings are added to, on ${when(ctx, ownerZone)}, from their private link.${n.outcome === 'replaced' && n.replacedEmail ? ` It replaced ${n.replacedEmail}.` : ''}`
      : `${hostFirst} connected ${n.email} on ${when(ctx, ownerZone)}, from their private link. Its busy times now count when people book ${hostFirst}.`;
    out.push({
      hostId: owner.id,
      subject: mainChange ? `${hostFirst} changed where their meetings go` : `${hostFirst} connected another Google account`,
      body: ['Hi {{host_first_name}},', literal(what), literal(`If you did not expect this, remove it on the Team page and replace ${hostFirst}'s private link.`)].join('\n\n'),
    });
  }
  return out;
}
