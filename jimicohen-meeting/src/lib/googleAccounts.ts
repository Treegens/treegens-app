/**
 * The Google accounts of a host as the screens see them: the main one (new meetings, Gmail, the time zone)
 * first, then the others, whose busy times block the host too. A host from an older server has only
 * `google`; its main account then has no id, and the per-account routes are not offered for it.
 */
import { MAX_GOOGLE_ACCOUNTS_PER_HOST } from '../../shared/defaults';
import type { AdminHost } from '../../shared/types';

export { MAX_GOOGLE_ACCOUNTS_PER_HOST };

export interface ScreenAccount {
  /** empty for the main account of an older server */
  id: string;
  email: string;
  status: 'ok' | 'needs_reconnect';
  main: boolean;
  busyCalendarIds: string[];
  connectedAt?: string;
  refreshExpiresAt?: string;
  health?: { ok: boolean; message?: string; at: string } | null;
}

export function mainAccount(host: AdminHost | null | undefined): ScreenAccount | null {
  const g = host?.google;
  if (!g) return null;
  return { id: g.id ?? '', email: g.email, status: g.status, main: true, busyCalendarIds: g.busyCalendarIds, connectedAt: g.connectedAt, refreshExpiresAt: g.refreshExpiresAt, health: g.health ?? null };
}

export function extraAccounts(host: AdminHost | null | undefined): ScreenAccount[] {
  return (host?.googleExtra ?? []).map((a) => ({ ...a, main: false }));
}

export function allAccounts(host: AdminHost | null | undefined): ScreenAccount[] {
  const main = mainAccount(host);
  return main ? [main, ...extraAccounts(host)] : extraAccounts(host);
}

export function accountsNeedingReconnect(host: AdminHost | null | undefined): ScreenAccount[] {
  return allAccounts(host).filter((a) => a.status === 'needs_reconnect');
}

/** Whether the host can connect another account. */
export function canAddAccount(host: AdminHost | null | undefined): boolean {
  return allAccounts(host).length < MAX_GOOGLE_ACCOUNTS_PER_HOST;
}

/** The address of an account of any of these hosts, by id. */
export function accountEmail(hosts: AdminHost[], id: string | null | undefined): string | null {
  if (!id) return null;
  for (const host of hosts) {
    const found = allAccounts(host).find((a) => a.id === id);
    if (found) return found.email;
  }
  return null;
}

/** "a@x", "a@x and b@x", "a@x, b@x and c@x" */
export function addressList(list: string[]): string {
  if (list.length <= 1) return list[0] ?? '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** "2 of 4 calendars count", from the stored ids (an empty list means the primary calendar). */
export function calendarsCountText(busyCalendarIds: string[], total?: number): string {
  const ticked = Math.max(1, busyCalendarIds.length);
  if (total === undefined || total <= 0) return ticked === 1 ? '1 calendar counts' : `${ticked} calendars count`;
  return `${Math.min(ticked, total)} of ${total} calendar${total === 1 ? '' : 's'} count${ticked === 1 && total === 1 ? 's' : ''}`;
}

/** "connected on 16 November" */
export function connectedOnText(iso: string | undefined): string {
  const ms = Date.parse(iso ?? '');
  if (!Number.isFinite(ms)) return '';
  return `connected on ${new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`;
}

export const CEILING_TEXT = `You have connected ${MAX_GOOGLE_ACCOUNTS_PER_HOST} Google accounts, the most one person can connect here. Remove one to add another.`;
export const LAST_CALENDAR_TEXT = 'At least one calendar of each account counts. To stop an account counting, remove it.';
