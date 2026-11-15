/**
 * The other Google accounts of a host, as rows: the address, a status, how many calendars count, the
 * calendars themselves (loaded only when opened), Reconnect where Google asked for it, Check and Remove.
 * Under them, "Add another Google account" and what to expect at Google. Used on Integrations (the owner,
 * "you"), on Team (a co-host, by name) and on a co-host's own page ("you", through their private link).
 *
 * The main account keeps its own block on each page (new meetings, Gmail and the time zone are its).
 * Everything here talks to the server through `api`, so the same rows work with a session or a link.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CalendarPlus, ChevronRight, RefreshCw, Trash2 } from 'lucide-react';
import type { AdminHost, GoogleAccountRemoved, GoogleCalendarListItem, GoogleRemovalPreview, IntegrationTestResponse } from '../../../shared/types';
import { errorMessage } from '../../lib/api';
import {
  CEILING_TEXT,
  LAST_CALENDAR_TEXT,
  addressList,
  calendarsCountText,
  canAddAccount,
  connectedOnText,
  extraAccounts,
  mainAccount,
  type ScreenAccount,
} from '../../lib/googleAccounts';
import { Badge, Button, Checkbox, ConfirmDialog, Skeleton, useToast } from '../../ui';
import '../../styles/googleAccounts.css';

export interface AccountsApi {
  listCalendars(accountId: string, signal: AbortSignal): Promise<GoogleCalendarListItem[]>;
  saveCalendars(accountId: string, busyCalendarIds: string[]): Promise<AdminHost>;
  preview(accountId: string): Promise<GoogleRemovalPreview>;
  remove(accountId: string): Promise<GoogleAccountRemoved>;
  /** where the browser goes for "Add another Google account" (add) or a row's Reconnect (accountId) */
  connectUrl(p: { add?: boolean; accountId?: string; main?: boolean }): string;
  /** "Check this account"; absent where no check is offered (the co-host page) */
  test?(accountId: string): Promise<IntegrationTestResponse>;
}

export interface Voice {
  /** "you" on the person's own page, else their first name ("Alex") */
  who: 'you' | string;
}

function possessive(v: Voice): string {
  return v.who === 'you' ? 'your' : `${v.who}'s`;
}

function statusBadge(a: ScreenAccount): ReactNode {
  if (a.status === 'needs_reconnect') return <Badge tone="warning">Needs reconnecting</Badge>;
  if (a.health && a.health.ok === false) return <Badge tone="danger">Could not be read</Badge>;
  return <Badge tone="success">Connected</Badge>;
}

/** The calendars of one account that block times. The last ticked one cannot be unticked. */
function AccountCalendars({ account, api, onHost }: { account: ScreenAccount; api: AccountsApi; onHost: (h: AdminHost) => void }) {
  const toast = useToast();
  const [list, setList] = useState<GoogleCalendarListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [ticked, setTicked] = useState<string[]>(account.busyCalendarIds);

  useEffect(() => setTicked(account.busyCalendarIds), [account.busyCalendarIds]);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setList(null);
    api.listCalendars(account.id, controller.signal).then(
      (l) => setList(l),
      (e: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(e, `The calendars of ${account.email} could not be loaded.`));
      },
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, attempt]);

  // An empty stored list means the primary calendar.
  const isTicked = (c: GoogleCalendarListItem) => ticked.includes(c.id) || (c.primary && (ticked.includes('primary') || ticked.length === 0));
  const save = async (next: string[]) => {
    if (busy || next.length === 0) return;
    setBusy(true);
    const before = ticked;
    setTicked(next);
    try {
      onHost(await api.saveCalendars(account.id, next));
    } catch (e) {
      setTicked(before);
      toast.error('The calendar choice was not saved', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="ga-cals" role="alert">
        <p className="ga-cals__error">The calendars of {account.email} could not be loaded.</p>
        <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }
  if (!list) {
    return (
      <div className="ga-cals" aria-busy="true">
        <Skeleton height={20} width="56%" />
        <Skeleton height={20} width="40%" />
      </div>
    );
  }
  const tickedCount = list.filter(isTicked).length;
  return (
    <div className="ga-cals">
      <p className="ga-cals__title">Calendars in {account.email} that block times</p>
      <ul role="list" className="ga-cals__list">
        {list.map((c) => {
          const on = isTicked(c);
          const last = on && tickedCount <= 1;
          return (
            <li key={c.id} title={last ? LAST_CALENDAR_TEXT : undefined}>
              <Checkbox
                checked={on}
                disabled={busy || last}
                onChange={(next) => {
                  const current = list.filter(isTicked).map((x) => (x.primary && (ticked.includes('primary') || ticked.length === 0) ? 'primary' : x.id));
                  const id = c.primary && current.includes('primary') ? 'primary' : c.id;
                  void save(next ? [...new Set([...current, c.id])] : current.filter((x) => x !== id && x !== c.id));
                }}
                label={
                  <span className="ix-cal">
                    <span className="ix-cal__dot" style={{ background: c.backgroundColor || 'var(--a-faint, #ccc)' }} aria-hidden="true" />
                    <span className="ix-cal__name">{c.summary}</span>
                    {c.primary ? <span className="ix-cal__tag">Main</span> : null}
                  </span>
                }
              />
            </li>
          );
        })}
      </ul>
      <p className="ga-cals__note">{tickedCount <= 1 ? LAST_CALENDAR_TEXT : 'Changes save on their own.'}</p>
    </div>
  );
}

/** The removal dialog's sentences, built from what the server says the removal changes. */
export function removalLines(preview: GoogleRemovalPreview | null, voice: Voice, otherExtras: number): string[] {
  if (!preview) return [];
  const you = voice.who === 'you';
  const theirs = possessive(voice);
  if (!preview.main) {
    return [
      you
        ? 'Its busy times will no longer be checked, so people can book over events that are only in this account.'
        : `${voice.who}'s busy times in ${preview.email} will no longer be checked, so people can book over events that are only in that account.`,
    ];
  }
  const lines = [you ? 'New meetings will not be added to any Google Calendar until you choose another account for them.' : `New meetings will not be added to ${voice.who}'s Google Calendar until another account is chosen for them.`];
  const keep = preview.extrasKeepBlocking ?? otherExtras;
  if (keep > 0) lines.push(`${you ? 'Your' : `${voice.who}'s`} other ${keep === 1 ? 'Google account still blocks' : `${keep} Google accounts still block`} times.`);
  if (preview.emailFallback === 'none') lines.push('Your emails are sent from this Gmail, so they stop until you allow another Gmail or set up Resend.');
  else if (preview.emailFallback === 'resend') lines.push('Your emails are sent from this Gmail, so they go out through Resend from then on.');
  if (preview.timezoneModeBecomes === 'device') lines.push(`${you ? 'Your' : `${voice.who}'s`} time zone follows this account. After removing it, it follows ${you ? 'this device' : 'their device'}.`);
  if (preview.upcomingEvents > 0) {
    const n = preview.atLeast ? `At least ${preview.upcomingEvents}` : `${preview.upcomingEvents}`;
    lines.push(
      `${n} upcoming ${preview.upcomingEvents === 1 && !preview.atLeast ? 'meeting is' : 'meetings are'} in this account's calendar. They stay there, but changes to them will reach ${you ? 'your' : theirs} invitees by email only, with a note to delete the old Google invitation.`,
    );
  }
  return lines;
}

/** Asks for the consequences, then removes one account. `onDone` gets the server's answer. */
export function RemoveAccountDialog({
  account,
  api,
  voice,
  otherExtras,
  onClose,
  onDone,
}: {
  account: ScreenAccount | null;
  api: AccountsApi;
  voice: Voice;
  otherExtras: number;
  onClose: () => void;
  onDone: (removed: GoogleAccountRemoved) => void;
}) {
  const toast = useToast();
  const [preview, setPreview] = useState<GoogleRemovalPreview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setPreview(null);
    setFailed(false);
    if (!account) return;
    let live = true;
    api.preview(account.id).then(
      (p) => live && setPreview(p),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id]);

  const lines = removalLines(preview, voice, otherExtras);
  const remove = async () => {
    if (!account) return;
    try {
      const done = await api.remove(account.id);
      onDone(done);
      const after = done.removed.main
        ? done.effects.detached > 0
          ? `New meetings are not added to a Google Calendar until another account is chosen. ${done.effects.detached === 1 ? 'One upcoming meeting stays' : `${done.effects.detached} upcoming meetings stay`} in its calendar.`
          : 'New meetings are not added to a Google Calendar until another account is chosen.'
        : 'Its busy times are no longer checked.';
      toast.success(`${done.removed.email} was removed`, after);
    } catch (e) {
      toast.error('The account was not removed', errorMessage(e));
      throw e;
    }
  };
  return (
    <ConfirmDialog
      open={!!account}
      onClose={onClose}
      onConfirm={remove}
      tone="danger"
      title={account ? `Remove ${account.email}?` : 'Remove this account?'}
      description={
        failed ? (
          'What removing it changes could not be loaded. You can still remove it.'
        ) : !preview ? (
          'Checking what removing it changes...'
        ) : (
          <span className="ga-lines">
            {lines.map((l) => (
              <span key={l} className="ga-lines__line">
                {l}
              </span>
            ))}
          </span>
        )
      }
      confirmLabel="Remove account"
      cancelLabel="Keep it"
      confirmDisabled={!preview && !failed}
    />
  );
}

/** One extra account. `offerConnect` false: no Reconnect here (the account's owner reconnects it from their own page). */
function AccountRow({
  account,
  api,
  voice,
  onHost,
  onRemove,
  offerConnect = true,
}: {
  account: ScreenAccount;
  api: AccountsApi;
  voice: Voice;
  onHost: (h: AdminHost) => void;
  onRemove: () => void;
  offerConnect?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<{ running: boolean; result?: IntegrationTestResponse }>({ running: false });
  const reconnect = account.status === 'needs_reconnect';
  const ends = Date.parse(account.refreshExpiresAt ?? '');
  const runCheck = async () => {
    if (!api.test) return;
    setCheck({ running: true });
    try {
      setCheck({ running: false, result: await api.test(account.id) });
    } catch (e) {
      setCheck({ running: false, result: { ok: false, detail: errorMessage(e) } });
    }
  };
  return (
    <li className="ga-row" data-account={account.email}>
      <div className="ga-row__head">
        <span className="ga-row__email">{account.email}</span>
        {statusBadge(account)}
      </div>
      <p className="ga-row__meta">
        {calendarsCountText(account.busyCalendarIds)}
        {account.connectedAt ? ` · ${connectedOnText(account.connectedAt)}` : ''}
      </p>
      {reconnect ? (
        <p className="ga-row__why">
          {voice.who === 'you'
            ? 'Google asked you to sign in again. Until you do, no times are offered for meetings with you.'
            : `Google asked ${voice.who} to sign in again to ${account.email}. Until then, times that include ${voice.who} are not offered.${offerConnect ? '' : ` ${voice.who} can reconnect it from their private link.`}`}
        </p>
      ) : account.health && account.health.ok === false && account.health.message ? (
        <p className="ga-row__why">{account.health.message}</p>
      ) : null}
      {Number.isFinite(ends) ? (
        <p className="ga-row__why" title={`${account.email} stops working on ${new Date(ends).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`}>
          This connection {ends <= Date.now() ? 'stopped working' : 'ends'} on {new Date(ends).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}. Reconnect it, and publish the consent screen so it reads In production.
        </p>
      ) : null}
      <div className="ga-row__actions">
        {offerConnect && (reconnect || Number.isFinite(ends)) ? (
          <Button size="sm" variant="primary" onClick={() => window.location.assign(api.connectUrl({ accountId: account.id }))}>
            Reconnect
          </Button>
        ) : null}
        {!reconnect ? (
          <Button size="sm" variant="secondary" aria-expanded={open} iconLeft={<ChevronRight size={14} className={open ? 'ga-turned' : undefined} />} onClick={() => setOpen((v) => !v)}>
            Calendars
          </Button>
        ) : null}
        {api.test && !reconnect ? (
          <Button size="sm" variant="ghost" iconLeft={<RefreshCw size={14} />} loading={check.running} loadingLabel="Checking" onClick={() => void runCheck()}>
            Check this account
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" iconLeft={<Trash2 size={14} />} onClick={onRemove}>
          Remove
        </Button>
      </div>
      {check.result ? (
        <p className={check.result.ok ? 'ga-row__check' : 'ga-row__check ga-row__check--bad'} role="status">
          {check.result.detail}
        </p>
      ) : null}
      {open && !reconnect ? <AccountCalendars account={account} api={api} onHost={onHost} /> : null}
    </li>
  );
}

/**
 * "Other Google accounts": every extra account of the host, then the add button. `addHelp` is said under
 * the button (who Google will ask). Nothing is shown before the host has a first account, except when it
 * has extras and no main one.
 */
export function OtherGoogleAccounts({
  host,
  api,
  voice,
  onHost,
  onRemoved,
  addHelp,
  canAdd = true,
  offerConnect = true,
  testingHelp,
}: {
  host: AdminHost;
  api: AccountsApi;
  voice: Voice;
  onHost: (h: AdminHost) => void;
  onRemoved?: (removed: GoogleAccountRemoved) => void;
  addHelp?: ReactNode;
  /** false where adding is not offered at all (keys missing) */
  canAdd?: boolean;
  /**
   * false on Team: a co-host adds and reconnects their own accounts from their private link. Google signs in
   * whoever is signed in at Google on this device, so from the owner's browser it would be the owner's account.
   * `addHelp` is then said instead of the button.
   */
  offerConnect?: boolean;
  /** what to say about Google's "Testing" mode, for someone who does not own the Google Cloud app */
  testingHelp?: string;
}) {
  const [removing, setRemoving] = useState<ScreenAccount | null>(null);
  const extras = extraAccounts(host);
  const main = mainAccount(host);
  if (!main && extras.length === 0) return null;
  const you = voice.who === 'you';
  const room = canAddAccount(host);
  return (
    <section className="ga-other" aria-label="Other Google accounts">
      {!main ? (
        <div className="ga-nomain">
          <p>
            {you
              ? 'New meetings are not added to any Google Calendar. Choose which of your accounts gets them.'
              : offerConnect
                ? `New meetings are not added to ${voice.who}'s Google Calendar. Choose which of ${voice.who}'s accounts gets them.`
                : `New meetings are not added to ${voice.who}'s Google Calendar until ${voice.who} chooses an account for them on their private page.`}
          </p>
          {offerConnect ? (
            <Button size="sm" variant="primary" iconLeft={<CalendarPlus size={14} />} onClick={() => window.location.assign(api.connectUrl({ main: true }))}>
              Choose an account for new meetings
            </Button>
          ) : null}
        </div>
      ) : null}
      <h3 className="ga-other__title">Other Google accounts</h3>
      <p className="ga-other__desc">
        {you ? 'Events in these accounts also block times on your booking page.' : `Events in these accounts also block times that include ${voice.who}.`} New meetings are not added to them.
      </p>
      {extras.length > 0 ? (
        <ul role="list" className="ga-rows">
          {extras.map((a) => (
            <AccountRow key={a.id} account={a} api={api} voice={voice} onHost={onHost} onRemove={() => setRemoving(a)} offerConnect={offerConnect} />
          ))}
        </ul>
      ) : (
        <p className="ga-other__none">{you ? 'None yet. If you keep events in another Google account, add it here so those times are not offered.' : 'None yet.'}</p>
      )}
      {canAdd && !offerConnect && addHelp ? (
        <div className="ga-add">
          <p className="ga-add__help">{addHelp}</p>
        </div>
      ) : null}
      {canAdd && offerConnect ? (
        <div className="ga-add">
          <Button variant="secondary" iconLeft={<CalendarPlus size={16} />} disabled={!room} onClick={() => window.location.assign(api.connectUrl({ add: true }))}>
            Add another Google account
          </Button>
          <p className="ga-add__help">
            {room
              ? `Google asks which account to use. If you pick one that is already here, it is refreshed, not added twice. ${testingHelp ?? 'While your Google Cloud app is in Testing, every Google account you add must be listed as a test user there.'}`
              : CEILING_TEXT}
          </p>
          {room && addHelp ? <p className="ga-add__help">{addHelp}</p> : null}
        </div>
      ) : null}
      <RemoveAccountDialog
        account={removing}
        api={api}
        voice={voice}
        otherExtras={Math.max(0, extras.length - 1)}
        onClose={() => setRemoving(null)}
        onDone={(done) => {
          onHost(done.host);
          onRemoved?.(done);
        }}
      />
    </section>
  );
}

/** "jimi@gmail.example and 2 more" */
export function accountsSummary(host: AdminHost): string {
  const main = mainAccount(host);
  const extras = extraAccounts(host);
  const first = main?.email ?? extras[0]?.email ?? '';
  const more = (main ? extras.length : extras.length - 1) | 0;
  return more > 0 ? `${first} and ${more} more` : first;
}

/** The addresses that need a reconnect, in one phrase. */
export function reconnectList(accounts: ScreenAccount[]): string {
  return addressList(accounts.filter((a) => a.status === 'needs_reconnect').map((a) => a.email));
}
