/**
 * Removing one Google account of a host, from the dashboard (any host) or a co-host's own page: what it
 * would change, said before the dialog opens, and the removal itself with everything that comes with it.
 *
 * An extra account only blocks time, so it simply goes (its grant is revoked unless the same Google account
 * is connected elsewhere). The main account is the disconnect of old: new meetings get no Google event until
 * another account is chosen for them, a time zone that followed it follows the device, and its upcoming
 * bookings are detached, so later changes reach the invitees by email with our own calendar file instead of
 * a second Google invitation from another account.
 */
import type { GoogleAccountRemoved, GoogleRemovalPreview, Host } from '../../shared/types';
import { toAdminHost } from './admin/view';
import { countEventsInAccount, detachEventsOfAccount } from './booking';
import { forgetHostBusy } from './busy';
import type { Ctx } from './ctx';
import { resolveEmailProvider } from './email';
import { removeGoogleAccount } from './google';
import { extrasOf, findAccount, mainOf, type AccountRef } from './googleAccounts';
import { HttpError } from './http';
import { getHost, getSecrets, getSite, updateHost } from './repo';
import { isEmail } from './validate';

function accountOf(host: Host, accountId: string): AccountRef {
  const ref = findAccount(host, { id: accountId });
  if (!ref) throw new HttpError(404, 'google_account_not_found', 'That Google account is not connected any more. Reload the page.');
  return ref;
}

/**
 * What sends the owner's emails once their main account (and its Gmail) is gone, when that Gmail is what
 * sends them now. Null when Gmail is not the sender, so nothing changes.
 */
async function emailAfter(ctx: Ctx, host: Host, ref: AccountRef): Promise<'resend' | 'none' | null> {
  const site = await getSite(ctx);
  if (!ref.main || host.id !== site.ownerHostId || ref.account.gmailSend !== true) return null;
  if ((await resolveEmailProvider(ctx).catch(() => 'none')) !== 'gmail') return null;
  const secrets = await getSecrets(ctx);
  const resendReady = !!secrets.resend?.apiKey && isEmail(site.email?.fromEmail);
  return (site.email?.provider ?? 'auto') === 'auto' && resendReady ? 'resend' : 'none';
}

/** GET .../google/:accountId/removal. `self`: the co-host's own page, which never hears about Gmail. */
export async function googleRemovalPreview(ctx: Ctx, host: Host, accountId: string, opts: { self: boolean }): Promise<GoogleRemovalPreview> {
  const ref = accountOf(host, accountId);
  const { count, atLeast } = await countEventsInAccount(ctx, host.id, ref.account.id, { includeUnstamped: ref.main });
  const preview: GoogleRemovalPreview = { main: ref.main, email: ref.account.email, upcomingEvents: count };
  if (atLeast) preview.atLeast = true;
  if (!ref.main) return preview;
  preview.extrasKeepBlocking = extrasOf(host).length;
  if (host.timezoneMode === 'google') preview.timezoneModeBecomes = 'device';
  if (!opts.self) {
    const fallback = await emailAfter(ctx, host, ref);
    if (fallback) {
      preview.emailFallback = fallback;
      preview.emailStops = fallback === 'none';
    }
  }
  return preview;
}

/** DELETE .../google/:accountId */
export async function removeHostGoogleAccount(ctx: Ctx, host: Host, accountId: string, opts: { self: boolean }): Promise<GoogleAccountRemoved> {
  const ref = accountOf(host, accountId);
  const fallback = !opts.self ? await emailAfter(ctx, host, ref).catch(() => null) : null;
  const done = await removeGoogleAccount(ctx, host.id, ref.account.id);
  if (!done) throw new HttpError(404, 'google_account_not_found', 'That Google account is not connected any more. Reload the page.');
  let after = done.host;
  if (done.main) {
    // Nothing to follow any more: fall back to the device the person uses.
    after = (await updateHost(ctx, host.id, (h) => (h.timezoneMode === 'google' && !mainOf(h) ? { ...h, timezoneMode: 'device' } : h))) ?? after;
  }
  // Bookings whose event was in this account: in phase 1 only the main account holds any.
  const detached = await detachEventsOfAccount(ctx, host.id, { id: done.removed.id, email: done.removed.email }, { includeUnstamped: done.main, why: 'removed' }).catch((err: unknown) => {
    // The stamp of the next housekeeping runs finds them: their account names nothing any more.
    ctx.log('warn', 'google: could not detach the bookings of a removed account', { hostId: host.id, error: err instanceof Error ? err.name : 'unknown' });
    return 0;
  });
  // What was read from that account must not be offered from the cache for another minute.
  await forgetHostBusy(ctx, [host.id]);
  const answer: GoogleAccountRemoved = {
    ok: true,
    host: toAdminHost(ctx, after),
    removed: { id: done.removed.id, email: done.removed.email, main: done.main },
    effects: { timezoneMode: after.timezoneMode, detached },
  };
  if (fallback) answer.effects.emailFallback = fallback;
  return answer;
}

/** The routes of old ("Disconnect"): the main account goes, as above. Answers with the host as it is after. */
export async function removeMainGoogleAccount(ctx: Ctx, host: Host): Promise<Host> {
  const main = mainOf(host);
  if (!main) {
    const after = await updateHost(ctx, host.id, (h) => ({ ...h, google: null, calendarHealth: null, timezoneMode: h.timezoneMode === 'google' ? 'device' : h.timezoneMode }));
    return after ?? { ...host, google: null, calendarHealth: null };
  }
  await removeHostGoogleAccount(ctx, host, main.account.id, { self: true });
  return (await getHost(ctx, host.id)) ?? { ...host, google: null, calendarHealth: null };
}
