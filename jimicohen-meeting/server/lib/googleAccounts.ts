/**
 * Every Google account of a host: the main one (`host.google`: new meetings, Gmail, "Follow Google
 * Calendar") and the others (`host.googleExtra`), whose busy times block the host too.
 *
 * Pure functions over a host record. Nothing here reads storage or the network, so a step handed to
 * updateHost can call them as often as the store runs it and always gets the same answer.
 *
 * Ids. An account connected by this code gets `gacc_` + a hash of the host id and Google's own account
 * id (`sub`), so the same id always means the same Google account. A main account written before ids
 * existed (or by an older deploy) has none stored: it gets one from its own connection record (host id,
 * `connectedAt`, address), and the next write stores it. Older code sets `connectedAt` afresh on every
 * connect, so a main account an older deploy connected again gets a new id on purpose: bookings stamped
 * with the earlier id are then checked again before anything is written through it.
 */
import { MAX_GOOGLE_ACCOUNTS_PER_HOST } from '../../shared/defaults';
import type { Booking, GoogleAccount, Host, HostGoogle } from '../../shared/types';
import { sha256Hex } from './crypto';

export type AccountRef = { host: Host; account: GoogleAccount; main: boolean };

/** What a Google sign-in was started for (server/routes/google.ts). */
export type ConnectIntent = 'main' | 'extra' | 'reconnect' | 'replace';
/** What it did: the host's first account, a new one, one refreshed, an extra moved to main, or the main replaced. */
export type ConnectOutcome = 'first' | 'added' | 'refreshed' | 'promoted' | 'replaced';

/** At most this many calendars count per account (freeBusy expands 50 per request). */
export const MAX_CALENDARS_PER_ACCOUNT = 50;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lower(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** The id of an account connected by this code: the same Google account on the same host always gets the same id. */
export function accountIdFor(hostId: string, sub: string): string {
  return `gacc_${sha256Hex(`${hostId}\nsub:${sub}`).slice(0, 24)}`;
}

/** The id of a main account that has none stored: from its connection record, never from the address alone. */
export function legacyMainId(host: Host): string | null {
  const g = host.google;
  if (!isRecord(g) || typeof g.email !== 'string') return null;
  return `gacc_${sha256Hex(`${host.id}\nlegacy:${typeof g.connectedAt === 'string' ? g.connectedAt : ''}\n${lower(g.email)}`).slice(0, 24)}`;
}

function storedId(v: unknown): string | null {
  return typeof v === 'string' && ID_PATTERN.test(v) ? v : null;
}

function readable(entry: Record<string, unknown>): boolean {
  return typeof entry.refreshTokenEnc === 'string' && entry.refreshTokenEnc !== '';
}

/** One stored account as code can use it: an entry without a token cannot be read, so it reads as needing a reconnect. */
function normalised(entry: HostGoogle, id: string): GoogleAccount {
  const raw = entry as unknown as Record<string, unknown>;
  return {
    ...entry,
    id,
    busyCalendarIds: Array.isArray(entry.busyCalendarIds) ? entry.busyCalendarIds.filter((c): c is string => typeof c === 'string' && c !== '') : [],
    scopes: Array.isArray(entry.scopes) ? entry.scopes.filter((s): s is string => typeof s === 'string') : [],
    writeCalendarId: typeof entry.writeCalendarId === 'string' && entry.writeCalendarId !== '' ? entry.writeCalendarId : 'primary',
    gmailSend: entry.gmailSend === true,
    status: readable(raw) && entry.status === 'ok' ? 'ok' : 'needs_reconnect',
    connectedAt: typeof entry.connectedAt === 'string' ? entry.connectedAt : '',
  };
}

/** The main account, its id filled in when none is stored. */
export function mainOf(host: Host | null | undefined): AccountRef | null {
  if (!host || !isRecord(host.google) || typeof host.google.email !== 'string') return null;
  const id = storedId(host.google.id) ?? legacyMainId(host);
  if (!id) return null;
  return { host, account: normalised(host.google, id), main: true };
}

interface StoredExtra {
  /** where it sits in host.googleExtra */
  index: number;
  account: GoogleAccount;
}

/**
 * The readable entries of host.googleExtra with the ids code uses for them. An entry that is not an
 * object, or has no address or id, is skipped (this code never writes one). Two entries with the same id
 * can only come from hand-edited storage: the second reads as `<id>_2` (then `_3`), the same way every
 * time, so both stay reachable.
 */
function storedExtras(host: Host): StoredExtra[] {
  const raw: unknown[] = Array.isArray(host.googleExtra) ? host.googleExtra : [];
  const seen = new Set<string>();
  const main = mainOf(host);
  if (main) seen.add(main.account.id);
  const out: StoredExtra[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.email !== 'string' || !entry.email.includes('@')) return;
    const base = storedId(entry.id);
    if (!base) return;
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}_${n}`;
    seen.add(id);
    out.push({ index, account: normalised(entry as unknown as HostGoogle, id) });
  });
  return out;
}

function byConnected(a: GoogleAccount, b: GoogleAccount): number {
  return a.connectedAt.localeCompare(b.connectedAt) || a.id.localeCompare(b.id);
}

/** The other accounts, oldest first. */
export function extrasOf(host: Host): AccountRef[] {
  return storedExtras(host)
    .map((e) => e.account)
    .sort(byConnected)
    .map((account) => ({ host, account, main: false }));
}

/** Every account: the main one first, then the others, oldest first. */
export function accountsOf(host: Host): AccountRef[] {
  const main = mainOf(host);
  return main ? [main, ...extrasOf(host)] : extrasOf(host);
}

export function accountCount(host: Host): number {
  return accountsOf(host).length;
}

/**
 * An account of this host. By id; else by Google's account id (`sub`), and only when no entry has that
 * sub, by address among the entries whose sub is not known yet. The same address with another sub is
 * another Google account (a reused or renamed address), so it is not found here.
 */
export function findAccount(host: Host, key: { id?: string; sub?: string; email?: string }): AccountRef | null {
  const all = accountsOf(host);
  if (key.id) {
    const hit = all.find((a) => a.account.id === key.id);
    if (hit) return hit;
    if (!key.sub && !key.email) return null;
  }
  if (key.sub) {
    const hit = all.find((a) => a.account.sub === key.sub);
    if (hit) return hit;
    const address = lower(key.email);
    return address ? (all.find((a) => !a.account.sub && lower(a.account.email) === address) ?? null) : null;
  }
  const address = lower(key.email);
  return address ? (all.find((a) => lower(a.account.email) === address) ?? null) : null;
}

/** Whether two entries are the same Google account: by sub when both know it, else by address. */
export function sameGoogleAccount(a: Pick<HostGoogle, 'email' | 'sub'>, b: Pick<HostGoogle, 'email' | 'sub'>): boolean {
  if (a.sub && b.sub) return a.sub === b.sub;
  return lower(a.email) !== '' && lower(a.email) === lower(b.email);
}

/**
 * Whether the same Google account is connected anywhere else: another host's account, or another entry
 * of this host. A revoke at Google ends the whole grant, so it only happens when nothing else holds it.
 */
export function heldElsewhere(hosts: Host[], hostId: string, accountId: string, account: Pick<HostGoogle, 'email' | 'sub'>): boolean {
  return hosts.some((h) => accountsOf(h).some((ref) => !(h.id === hostId && ref.account.id === accountId) && sameGoogleAccount(ref.account, account)));
}

/** host.googleExtra with the entry of this id changed by `fn` (null removes it). Every other entry is written back as it was. */
export function writeExtra(host: Host, accountId: string, fn: (account: GoogleAccount) => GoogleAccount | null): Host {
  const target = storedExtras(host).find((e) => e.account.id === accountId);
  if (!target) return host;
  const raw: unknown[] = Array.isArray(host.googleExtra) ? host.googleExtra : [];
  const next: unknown[] = [];
  raw.forEach((entry, index) => {
    if (index !== target.index) {
      next.push(entry);
      return;
    }
    const changed = fn(structuredClone(target.account));
    if (changed) next.push(changed);
  });
  return { ...host, googleExtra: next as GoogleAccount[] };
}

/** The main account (when it has this id) or the extra with this id, changed by `fn`. */
export function writeAccount(host: Host, accountId: string, fn: (account: GoogleAccount) => GoogleAccount): Host {
  const main = mainOf(host);
  if (main && main.account.id === accountId) return { ...host, google: fn(structuredClone(main.account)) };
  return writeExtra(host, accountId, fn);
}

export function removeExtra(host: Host, accountId: string): { host: Host; removed: GoogleAccount | null } {
  const target = storedExtras(host).find((e) => e.account.id === accountId);
  if (!target) return { host, removed: null };
  return { host: writeExtra(host, accountId, () => null), removed: target.account };
}

function calendarsOrPrimary(list: string[]): string[] {
  return list.length > 0 ? list : ['primary'];
}

/**
 * An extra entry that is the same Google account as the main one (only an older deploy connecting an
 * account that was already an extra makes that). Once the main account's sub is known, the extra is
 * folded in: its ticked calendars join the main account's and the entry goes. Its grant is the main
 * account's grant, so nothing is revoked.
 */
export function foldIntoMain(host: Host): { host: Host; folded: GoogleAccount[] } {
  const main = mainOf(host);
  if (!main?.account.sub) return { host, folded: [] };
  const same = storedExtras(host).filter((e) => e.account.sub === main.account.sub);
  if (same.length === 0) return { host, folded: [] };
  const calendars = new Set(calendarsOrPrimary(main.account.busyCalendarIds));
  for (const e of same) for (const id of calendarsOrPrimary(e.account.busyCalendarIds)) calendars.add(id);
  const drop = new Set(same.map((e) => e.index));
  const raw: unknown[] = Array.isArray(host.googleExtra) ? host.googleExtra : [];
  return {
    host: {
      ...host,
      google: { ...main.account, busyCalendarIds: [...calendars].slice(0, MAX_CALENDARS_PER_ACCOUNT) },
      googleExtra: raw.filter((_, i) => !drop.has(i)) as GoogleAccount[],
    },
    folded: same.map((e) => e.account),
  };
}

// ───────────────────────── connecting ─────────────────────────

/** What Google said about the account that just signed in. */
export interface IncomingGrant {
  email: string;
  sub: string;
  /** the sealed refresh token Google sent now; null when it left it out (it considers the earlier one still good) */
  refreshTokenEnc: string | null;
  scopes: string[];
  gmailSend: boolean;
  refreshExpiresAt?: string;
  /** now */
  at: string;
}

export interface UpsertResult {
  /** the record to store (the one given when refused) */
  host: Host;
  outcome?: ConnectOutcome;
  accountId?: string;
  /** the person picked another account at Google than the one the button was for */
  note?: 'other_account';
  /** with the note: the account that still needs reconnecting, or that stays the main one */
  wanted?: string;
  refused?: 'ceiling' | 'no_refresh_token';
  /** the old main account, dropped by "Use a different Google account" */
  dropped?: GoogleAccount;
  /** the host had no Google account at all before */
  firstEver: boolean;
}

/**
 * Puts a fresh Google sign-in onto the host (see the design's table, 7.5). Nothing is ever replaced
 * silently: only `replace` drops the main account, and its dialog says so first. `canOpen` tells whether a
 * stored sealed token still opens (with the current key), for when Google left the refresh token out.
 */
export function upsertAccount(host: Host, incoming: IncomingGrant, intent: ConnectIntent, aid: string | undefined, canOpen: (sealed: string) => boolean): UpsertResult {
  const main = mainOf(host);
  const extras = extrasOf(host);
  const firstEver = !main && extras.length === 0;
  const found = findAccount(host, { sub: incoming.sub, email: incoming.email });
  const own = found?.account.refreshTokenEnc;
  const token = incoming.refreshTokenEnc ?? (typeof own === 'string' && own !== '' && canOpen(own) ? own : null);
  if (!token) return { host, refused: 'no_refresh_token', firstEver };

  const refresh = (a: GoogleAccount): GoogleAccount => {
    const next: GoogleAccount = {
      ...a,
      email: incoming.email,
      sub: incoming.sub,
      refreshTokenEnc: token,
      scopes: [...incoming.scopes],
      gmailSend: incoming.gmailSend,
      status: 'ok',
      refreshedAt: incoming.at,
      health: null,
    };
    if (!next.writeCalendarId) next.writeCalendarId = 'primary';
    if (!next.connectedAt) next.connectedAt = incoming.at;
    if (incoming.refreshExpiresAt) next.refreshExpiresAt = incoming.refreshExpiresAt;
    else delete next.refreshExpiresAt;
    return next;
  };
  const fresh = (): GoogleAccount => ({
    id: accountIdFor(host.id, incoming.sub),
    email: incoming.email,
    sub: incoming.sub,
    refreshTokenEnc: token,
    scopes: [...incoming.scopes],
    busyCalendarIds: ['primary'],
    writeCalendarId: 'primary',
    gmailSend: incoming.gmailSend,
    status: 'ok',
    connectedAt: incoming.at,
    refreshedAt: incoming.at,
    health: null,
    ...(incoming.refreshExpiresAt ? { refreshExpiresAt: incoming.refreshExpiresAt } : {}),
  });
  const full = accountCount(host) >= MAX_GOOGLE_ACCOUNTS_PER_HOST;
  const rawExtras = (h: Host): GoogleAccount[] => (Array.isArray(h.googleExtra) ? h.googleExtra : []);
  const done = (next: Host, outcome: ConnectOutcome, accountId: string, extra: Partial<UpsertResult> = {}): UpsertResult => ({
    host: foldIntoMain({ ...next, calendarHealth: null }).host,
    outcome,
    accountId,
    firstEver,
    ...extra,
  });

  if (firstEver) {
    const account = fresh();
    return done({ ...host, google: account }, 'first', account.id);
  }

  const asMain = (h: Host, account: GoogleAccount): Host => ({ ...h, google: account });
  const addExtra = (h: Host, account: GoogleAccount): Host => ({ ...h, googleExtra: [...rawExtras(h), account] });
  const promote = (ref: AccountRef): Host => asMain(removeExtra(host, ref.account.id).host, refresh(ref.account));

  if (found?.main) {
    const note = intent === 'reconnect' && aid && aid !== found.account.id ? { note: 'other_account' as const, wanted: aid } : {};
    return done(asMain(host, refresh(found.account)), 'refreshed', found.account.id, note);
  }

  if (found) {
    // An extra account signed in again.
    switch (intent) {
      case 'extra':
        return done(writeExtra(host, found.account.id, refresh), 'refreshed', found.account.id);
      case 'reconnect': {
        const note = aid && aid !== found.account.id ? { note: 'other_account' as const, wanted: aid } : {};
        return done(writeExtra(host, found.account.id, refresh), 'refreshed', found.account.id, note);
      }
      case 'main':
        if (!main) return done(promote(found), 'promoted', found.account.id);
        return done(writeExtra(host, found.account.id, refresh), 'refreshed', found.account.id, { note: 'other_account', wanted: main.account.id });
      case 'replace':
        if (!main) return done(promote(found), 'promoted', found.account.id);
        return done(promote(found), 'replaced', found.account.id, { dropped: main.account });
    }
  }

  // A Google account this host does not have yet.
  if (intent === 'replace' && main) {
    const account = fresh();
    return done(asMain(host, account), 'replaced', account.id, { dropped: main.account });
  }
  if (full) return { host, refused: 'ceiling', firstEver };
  const account = fresh();
  if (intent === 'extra') return done(addExtra(host, account), 'added', account.id);
  if (!main) return done(asMain(host, account), 'added', account.id);
  if (intent === 'reconnect') return done(addExtra(host, account), 'added', account.id, aid ? { note: 'other_account', wanted: aid } : { note: 'other_account' });
  // The plain Connect button with a main account in place: nothing is replaced without asking.
  return done(addExtra(host, account), 'added', account.id, { note: 'other_account', wanted: main.account.id });
}

// ───────────────────────── bookings ─────────────────────────

/**
 * Which account holds the event of a booking. A stored account id that the host still has is trusted.
 * Otherwise every account of the host that works is only a candidate: it has to show the event, with our
 * booking id in it, before anything is written through it. A detached booking has no holder at all.
 */
export function holderCandidates(host: Host | null | undefined, g: NonNullable<Booking['google']>): { trusted: AccountRef | null; candidates: AccountRef[] } {
  if (!host || g.detached) return { trusted: null, candidates: [] };
  const all = accountsOf(host);
  if (g.accountId) {
    const trusted = all.find((a) => a.account.id === g.accountId);
    if (trusted) return { trusted, candidates: [] };
  }
  return { trusted: null, candidates: all.filter((a) => a.account.status === 'ok') };
}

/** Whether a booking's stored account id names no account of the host any more. */
export function accountGone(host: Host | null | undefined, g: NonNullable<Booking['google']>): boolean {
  if (!g.accountId) return true;
  return !host || !accountsOf(host).some((a) => a.account.id === g.accountId);
}
