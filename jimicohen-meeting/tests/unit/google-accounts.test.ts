/**
 * Every Google account of a host (server/lib/googleAccounts.ts): ids, lookups, the upsert of a new sign-in
 * in every case of the design's table, the fold of a duplicate, and which account holds a booking's event.
 */
import { describe, expect, it } from 'vitest';
import { MAX_GOOGLE_ACCOUNTS_PER_HOST, defaultOwnerHost } from '../../shared/defaults';
import type { Booking, GoogleAccount, Host, HostGoogle } from '../../shared/types';
import {
  accountIdFor,
  accountsOf,
  extrasOf,
  findAccount,
  foldIntoMain,
  heldElsewhere,
  holderCandidates,
  legacyMainId,
  mainOf,
  removeExtra,
  sameGoogleAccount,
  upsertAccount,
  writeExtra,
  type ConnectIntent,
  type IncomingGrant,
} from '../../server/lib/googleAccounts';

const NOW = '2026-11-16T09:00:00.000Z';
const LATER = '2026-11-20T09:00:00.000Z';
const HOST = 'host_owner';

function account(email: string, over: Partial<GoogleAccount> = {}): GoogleAccount {
  const sub = over.sub ?? `sub-${email}`;
  return {
    id: accountIdFor(HOST, sub),
    email,
    sub,
    refreshTokenEnc: `sealed-${email}`,
    scopes: ['openid'],
    busyCalendarIds: ['primary'],
    writeCalendarId: 'primary',
    gmailSend: false,
    status: 'ok',
    connectedAt: NOW,
    ...over,
  };
}

function host(main: HostGoogle | null, extras: unknown[] = []): Host {
  return { ...defaultOwnerHost(NOW), google: main, googleExtra: extras as GoogleAccount[] };
}

function grant(email: string, over: Partial<IncomingGrant> = {}): IncomingGrant {
  return { email, sub: `sub-${email}`, refreshTokenEnc: `fresh-${email}`, scopes: ['openid', 'email'], gmailSend: false, at: LATER, ...over };
}

const opens = (): boolean => true;

describe('account ids', () => {
  it('come from Google\'s account id: stable, and the same whatever the address', () => {
    expect(accountIdFor(HOST, 'sub-1')).toBe(accountIdFor(HOST, 'sub-1'));
    expect(accountIdFor(HOST, 'sub-1')).toMatch(/^gacc_[0-9a-f]{24}$/);
    expect(accountIdFor(HOST, 'sub-1')).not.toBe(accountIdFor(HOST, 'sub-2'));
    expect(accountIdFor(HOST, 'sub-1')).not.toBe(accountIdFor('host_alex', 'sub-1'));
  });

  it('a main account written before ids has one from its connection record, which an older deploy\'s reconnect changes', () => {
    const old: HostGoogle = { ...account('jimi@gmail.example'), id: undefined, sub: undefined };
    const first = legacyMainId(host(old))!;
    expect(first).toMatch(/^gacc_/);
    expect(mainOf(host(old))!.account.id).toBe(first);
    // Two reads agree.
    expect(mainOf(host(old))!.account.id).toBe(mainOf(host(old))!.account.id);
    // An older deploy connecting again sets connectedAt afresh: the id changes on purpose.
    expect(legacyMainId(host({ ...old, connectedAt: LATER }))).not.toBe(first);
    // Not from the address alone: another host with the same address and time gets another id.
    expect(legacyMainId({ ...host(old), id: 'host_alex' })).not.toBe(first);
  });

  it('a stored id is never recomputed, and survives a change of address', () => {
    const stored = account('jimi@gmail.example', { id: 'gacc_000000000000000000000001' });
    expect(mainOf(host({ ...stored, email: 'jimi@renamed.example' }))!.account.id).toBe('gacc_000000000000000000000001');
    expect(extrasOf(host(null, [{ ...stored, email: 'x@renamed.example' }]))[0].account.id).toBe('gacc_000000000000000000000001');
  });
});

describe('findAccount', () => {
  const main = account('jimi@gmail.example');
  const work = account('jimi@work.example');
  const h = host(main, [work]);

  it('finds by id, and by sub', () => {
    expect(findAccount(h, { id: work.id })?.account.email).toBe('jimi@work.example');
    expect(findAccount(h, { sub: 'sub-jimi@work.example', email: 'whatever@example.com' })?.account.id).toBe(work.id);
    expect(findAccount(h, { id: 'gacc_unknown' })).toBeNull();
  });

  it('uses the address only for an entry whose sub is not known yet', () => {
    const old = host({ ...main, sub: undefined });
    expect(findAccount(old, { sub: 'sub-new', email: 'JIMI@gmail.example' })?.main).toBe(true);
  });

  it('the same address with another sub is another Google account', () => {
    expect(findAccount(h, { sub: 'sub-someone-else', email: 'jimi@work.example' })).toBeNull();
    expect(sameGoogleAccount(work, { email: 'jimi@work.example', sub: 'sub-other' })).toBe(false);
    expect(sameGoogleAccount(work, { email: 'JIMI@work.example' })).toBe(true);
  });
});

describe('extrasOf', () => {
  it('reads an entry without a token as needing a reconnect, and skips what is not an account', () => {
    const noToken = { ...account('a@x.example'), refreshTokenEnc: undefined };
    const h = host(account('m@x.example'), [noToken, 'garbage', null, { email: 'no-id@x.example' }, { id: 'gacc_x' }]);
    const extras = extrasOf(h);
    expect(extras).toHaveLength(1);
    expect(extras[0].account.status).toBe('needs_reconnect');
    expect(accountsOf(h).map((a) => a.account.email)).toEqual(['m@x.example', 'a@x.example']);
  });

  it('lists the other accounts oldest first, whatever order they are stored in', () => {
    const late = account('late@x.example', { connectedAt: LATER });
    const early = account('early@x.example');
    expect(extrasOf(host(account('m@x.example'), [late, early])).map((a) => a.account.email)).toEqual(['early@x.example', 'late@x.example']);
  });

  it('gives a duplicate id a suffix, the same way every time, and a write through it leaves every other entry byte for byte', () => {
    const one = account('one@x.example', { id: 'gacc_dup' });
    const two = account('two@x.example', { id: 'gacc_dup', connectedAt: LATER });
    const strange = { id: 'gacc_strange', email: 'odd@x.example', weird: { field: [1, 2] } };
    const h = host(null, [one, two, strange]);
    expect(extrasOf(h).map((a) => a.account.id).sort()).toEqual(['gacc_dup', 'gacc_dup_2', 'gacc_strange']);
    expect(extrasOf(h).find((a) => a.account.id === 'gacc_dup_2')!.account.email).toBe('two@x.example');
    const written = writeExtra(h, 'gacc_dup_2', (a) => ({ ...a, busyCalendarIds: ['primary', 'family'] }));
    expect(written.googleExtra![0]).toBe(one);
    expect(JSON.stringify(written.googleExtra![2])).toBe(JSON.stringify(strange));
    expect(written.googleExtra![1]).toMatchObject({ id: 'gacc_dup_2', email: 'two@x.example', busyCalendarIds: ['primary', 'family'] });
    expect(removeExtra(h, 'gacc_dup').host.googleExtra).toEqual([two, strange]);
  });
});

describe('the fold', () => {
  it('folds an extra that is the main account into it once the main account\'s sub is known, uniting the calendars', () => {
    const main = account('jimi@gmail.example', { busyCalendarIds: [] });
    const same = account('jimi@gmail.example', { id: 'gacc_dupe', busyCalendarIds: ['primary', 'family@group'] });
    const other = account('jimi@work.example');
    const { host: folded, folded: gone } = foldIntoMain(host(main, [same, other]));
    expect(gone.map((a) => a.id)).toEqual(['gacc_dupe']);
    expect(folded.googleExtra).toEqual([other]);
    expect(folded.google!.busyCalendarIds).toEqual(['primary', 'family@group']);
    // Without a known sub nothing is folded.
    expect(foldIntoMain(host({ ...main, sub: undefined }, [same])).folded).toEqual([]);
  });
});

describe('upsertAccount: every case of the table', () => {
  const main = account('jimi@gmail.example', { busyCalendarIds: ['primary', 'family@group'], writeCalendarId: 'work@group' });
  const extra = account('jimi@work.example', { busyCalendarIds: ['team@group'] });
  const full = host(main, [extra]);
  const up = (h: Host, g: IncomingGrant, intent: ConnectIntent, aid?: string) => upsertAccount(h, g, intent, aid, opens);

  it('a host with no account at all: the first account, the main one, whatever the button was', () => {
    for (const intent of ['main', 'extra', 'reconnect', 'replace'] as const) {
      const r = up(host(null), grant('new@x.example'), intent);
      expect(r).toMatchObject({ outcome: 'first', firstEver: true, accountId: accountIdFor(HOST, 'sub-new@x.example') });
      expect(r.host.google).toMatchObject({ email: 'new@x.example', busyCalendarIds: ['primary'], writeCalendarId: 'primary', status: 'ok' });
    }
  });

  it('add: the main account picked again is refreshed in place, keeping its id, calendars and first connection', () => {
    const r = up(full, grant('jimi@gmail.example'), 'extra');
    expect(r).toMatchObject({ outcome: 'refreshed', accountId: main.id });
    expect(r.host.google).toMatchObject({ id: main.id, busyCalendarIds: ['primary', 'family@group'], writeCalendarId: 'work@group', connectedAt: NOW, refreshedAt: LATER, refreshTokenEnc: 'fresh-jimi@gmail.example' });
    expect(r.host.googleExtra).toHaveLength(1);
  });

  it('add: an extra picked again is refreshed; a new one is added after the others', () => {
    const again = up(full, grant('jimi@work.example'), 'extra');
    expect(again).toMatchObject({ outcome: 'refreshed', accountId: extra.id });
    expect(again.host.googleExtra![0]).toMatchObject({ busyCalendarIds: ['team@group'], refreshTokenEnc: 'fresh-jimi@work.example' });
    const added = up(full, grant('jimi@eco.example'), 'extra');
    expect(added).toMatchObject({ outcome: 'added', firstEver: false });
    expect(added.host.google).toEqual(main);
    expect(added.host.googleExtra!.map((a) => a.email)).toEqual(['jimi@work.example', 'jimi@eco.example']);
  });

  it('same sub with a new address: the same account, refreshed under the new address', () => {
    const r = up(full, grant('jimi@renamed.example', { sub: 'sub-jimi@work.example' }), 'extra');
    expect(r).toMatchObject({ outcome: 'refreshed', accountId: extra.id });
    expect(r.host.googleExtra).toHaveLength(1);
    expect(r.host.googleExtra![0]).toMatchObject({ id: extra.id, email: 'jimi@renamed.example', connectedAt: NOW });
  });

  it('same address with another sub: another account, added', () => {
    const r = up(full, grant('jimi@work.example', { sub: 'sub-reused' }), 'extra');
    expect(r.outcome).toBe('added');
    expect(r.host.googleExtra!.map((a) => a.id)).toEqual([extra.id, accountIdFor(HOST, 'sub-reused')]);
  });

  it('plain connect: refreshes the main, promotes an extra when there is no main, and never replaces a main silently', () => {
    expect(up(full, grant('jimi@gmail.example'), 'main').outcome).toBe('refreshed');
    const kept = up(full, grant('jimi@work.example'), 'main');
    expect(kept).toMatchObject({ outcome: 'refreshed', note: 'other_account', accountId: extra.id });
    expect(kept.host.google!.id).toBe(main.id);
    const promoted = up(host(null, [extra]), grant('jimi@work.example'), 'main');
    expect(promoted).toMatchObject({ outcome: 'promoted', accountId: extra.id });
    expect(promoted.host.google!.id).toBe(extra.id);
    expect(promoted.host.googleExtra).toEqual([]);
    const noMain = up(host(null, [extra]), grant('jimi@eco.example'), 'main');
    expect(noMain).toMatchObject({ outcome: 'added' });
    expect(noMain.host.google!.email).toBe('jimi@eco.example');
    const unknown = up(full, grant('jimi@eco.example'), 'main');
    expect(unknown).toMatchObject({ outcome: 'added', note: 'other_account' });
    expect(unknown.host.google).toEqual(main);
    expect(unknown.host.googleExtra!.map((a) => a.email)).toEqual(['jimi@work.example', 'jimi@eco.example']);
  });

  it('reconnect: the wanted account is refreshed; another one picked at Google leaves the wanted one as it was', () => {
    const broken = host(main, [{ ...extra, status: 'needs_reconnect' }]);
    const fixed = up(broken, grant('jimi@work.example'), 'reconnect', extra.id);
    expect(fixed).toMatchObject({ outcome: 'refreshed', accountId: extra.id });
    expect(fixed.note).toBeUndefined();
    expect(fixed.host.googleExtra![0].status).toBe('ok');
    const mainPicked = up(broken, grant('jimi@gmail.example'), 'reconnect', extra.id);
    expect(mainPicked).toMatchObject({ outcome: 'refreshed', accountId: main.id, note: 'other_account', wanted: extra.id });
    expect(mainPicked.host.googleExtra![0].status).toBe('needs_reconnect');
    const stranger = up(broken, grant('b@x.example'), 'reconnect', extra.id);
    expect(stranger).toMatchObject({ outcome: 'added', note: 'other_account', wanted: extra.id });
    expect(stranger.host.googleExtra!.find((a) => a.id === extra.id)!.status).toBe('needs_reconnect');
  });

  it('use a different account: the same one refreshes, an extra moves to main, a new one becomes main; the old main is dropped', () => {
    expect(up(full, grant('jimi@gmail.example'), 'replace')).toMatchObject({ outcome: 'refreshed' });
    const moved = up(full, grant('jimi@work.example'), 'replace');
    expect(moved).toMatchObject({ outcome: 'replaced', accountId: extra.id, dropped: main });
    expect(moved.host.google!.id).toBe(extra.id);
    expect(moved.host.googleExtra).toEqual([]);
    const fresh = up(full, grant('jimi@new.example'), 'replace');
    expect(fresh).toMatchObject({ outcome: 'replaced', dropped: main });
    expect(fresh.host.google!.email).toBe('jimi@new.example');
    expect(fresh.host.googleExtra).toEqual([extra]);
  });

  it(`refuses a ${MAX_GOOGLE_ACCOUNTS_PER_HOST + 1}st account and stores nothing, while refreshing one still works`, () => {
    const many = Array.from({ length: MAX_GOOGLE_ACCOUNTS_PER_HOST - 1 }, (_, i) => account(`a${i}@x.example`));
    const atCeiling = host(main, many);
    expect(accountsOf(atCeiling)).toHaveLength(MAX_GOOGLE_ACCOUNTS_PER_HOST);
    const refused = up(atCeiling, grant('one-too-many@x.example'), 'extra');
    expect(refused).toMatchObject({ refused: 'ceiling' });
    expect(refused.host).toBe(atCeiling);
    expect(up(atCeiling, grant('a3@x.example'), 'extra').outcome).toBe('refreshed');
  });

  it('Google left the refresh token out: an account keeps its own; a new one cannot be added', () => {
    const kept = up(full, grant('jimi@work.example', { refreshTokenEnc: null }), 'extra');
    expect(kept.host.googleExtra![0].refreshTokenEnc).toBe('sealed-jimi@work.example');
    expect(up(full, grant('new@x.example', { refreshTokenEnc: null }), 'extra')).toMatchObject({ refused: 'no_refresh_token' });
    // A stored token that no longer opens is no use either.
    expect(upsertAccount(full, grant('jimi@work.example', { refreshTokenEnc: null }), 'extra', undefined, () => false)).toMatchObject({ refused: 'no_refresh_token' });
  });
});

describe('holderCandidates', () => {
  const main = account('jimi@gmail.example');
  const work = account('jimi@work.example');
  const h = host(main, [work, account('old@x.example', { status: 'needs_reconnect' })]);
  const g = (over: Partial<NonNullable<Booking['google']>>): NonNullable<Booking['google']> => ({ hostId: HOST, calendarId: 'primary', eventId: 'evt1', ...over });

  it('trusts a stored id the host still has, in main or an extra', () => {
    expect(holderCandidates(h, g({ accountId: main.id })).trusted?.account.id).toBe(main.id);
    expect(holderCandidates(h, g({ accountId: work.id })).trusted?.account.id).toBe(work.id);
  });

  it('only offers candidates for an unknown or missing id: the accounts that work, main first', () => {
    for (const over of [{}, { accountId: 'gacc_gone' }]) {
      const r = holderCandidates(h, g(over));
      expect(r.trusted).toBeNull();
      expect(r.candidates.map((c) => c.account.email)).toEqual(['jimi@gmail.example', 'jimi@work.example']);
    }
  });

  it('has nothing for a detached booking', () => {
    expect(holderCandidates(h, g({ accountId: main.id, detached: true }))).toEqual({ trusted: null, candidates: [] });
  });

  it('a grant is shared when any other entry anywhere is the same Google account', () => {
    const alex = { ...host(account('alex@x.example', { id: 'gacc_alex' })), id: 'host_alex' };
    expect(heldElsewhere([h, alex], HOST, work.id, work)).toBe(false);
    const alexToo = { ...alex, googleExtra: [account('jimi@work.example', { id: 'gacc_other' })] };
    expect(heldElsewhere([h, alexToo], HOST, work.id, work)).toBe(true);
  });
});
