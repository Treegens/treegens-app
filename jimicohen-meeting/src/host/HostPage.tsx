/**
 * /host/:id?t=<token>: a co-host's own page. No dashboard session: the private link is the key.
 *
 * Here they connect Google Calendar (full-page redirect, the token travels with the request),
 * choose which calendars count as busy, set their weekly hours, see that their time zone is
 * handled for them, and can link a non-Google calendar through its private ICS feed.
 * It wears the owner's site theme.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { CalendarCheck, CalendarDays, CalendarPlus, Check, CircleCheck, Clock, Globe, LinkIcon, Lock, MonitorSmartphone, ShieldCheck, Trash2, TriangleAlert, Unlink, UserRound } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DEFAULT_THEME } from '../../shared/defaults';
import { NO_ASSETS } from '../../shared/theme';
import type { ThemeAssets } from '../../shared/theme';
import type { AdminHost, GoogleCalendarListItem, HostSelfResponse, HostUpdate, Schedule } from '../../shared/types';
import { ScheduleEditor, scheduleProblem } from '../admin/components/ScheduleEditor';
import { APP_BASE, ApiFailure, assetUrl, errorMessage, getHostSelf, getHostSelfCalendars, googleConnectUrl, updateHostSelf } from '../lib/api';
import { ThemeScope, cachedTheme } from '../lib/theme';
import { detectZone, formatOffset, formatTime, zoneLabel, zoneOffsetMinutes } from '../lib/tz';
import { Avatar, Button, Checkbox, EmptyState, Field, IconButton, Input, RadioGroup, Select, Skeleton, Switch, TimezoneSelect, cx, useToast } from '../ui';
import '../styles/adminx.css';

type ZoneMode = AdminHost['timezoneMode'];

type State = { status: 'loading' } | { status: 'ready'; data: HostSelfResponse } | { status: 'invalid' } | { status: 'error'; message: string };

interface HoursDraft {
  schedules: Schedule[];
  defaultScheduleId: string;
}

function first(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function googleReason(reason: string | null): string {
  const r = (reason ?? '').trim();
  if (!r) return 'Google did not finish connecting. Please try again.';
  if (r === 'access_denied') return 'The Google screen was closed before access was allowed. Press Connect to try again.';
  return r.slice(0, 240);
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

interface CardProps {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  /** small status on the right of the title */
  status?: ReactNode;
  children: ReactNode;
  id?: string;
}

function Card({ icon, title, description, status, children, id }: CardProps) {
  return (
    <section className="hp-card" aria-labelledby={id ? `${id}-title` : undefined} id={id}>
      <header className="hp-card__head">
        <span className="hp-card__icon" aria-hidden="true">
          {icon}
        </span>
        <div className="hp-card__text">
          <h2 className="hp-card__title" id={id ? `${id}-title` : undefined}>
            {title}
          </h2>
          {description ? <p className="hp-card__desc">{description}</p> : null}
        </div>
        {status ? <div className="hp-card__status">{status}</div> : null}
      </header>
      <div className="hp-card__body">{children}</div>
    </section>
  );
}

function Pill({ tone, children }: { tone: 'ok' | 'wait' | 'warn'; children: ReactNode }) {
  return (
    <span className={cx('hp-pill', `hp-pill--${tone}`)}>
      {tone === 'ok' ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : tone === 'warn' ? <TriangleAlert size={13} aria-hidden="true" /> : <span className="hp-pill__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

// ───────────── the page once the host is known ─────────────

interface PanelProps {
  id: string;
  token: string;
  data: HostSelfResponse;
  onHost: (host: AdminHost) => void;
  onCalendars: (calendars: GoogleCalendarListItem[] | null) => void;
}

function HostPanel({ id, token, data, onHost, onCalendars }: PanelProps) {
  const toast = useToast();
  const { host, siteName, googleConfigured, calendars } = data;
  const owner = first(siteName);
  const me = first(host.name);
  const now = useNow(30000);
  const deviceZone = useMemo(() => detectZone(), []);

  const google = host.google;
  const needsReconnect = google?.status === 'needs_reconnect';
  const connected = !!google && !needsReconnect;
  const hasFeed = host.icsFeeds.length > 0;
  const ready = connected || hasFeed;

  const update = useCallback(
    async (patch: HostUpdate): Promise<AdminHost> => {
      const next = await updateHostSelf(id, token, patch);
      onHost(next);
      return next;
    },
    [id, token, onHost],
  );

  // ── time zone: tell the server which zone this device is in, once per visit
  const sentZone = useRef(false);
  useEffect(() => {
    if (sentZone.current) return;
    sentZone.current = true;
    const before = host.timezone;
    update({ deviceTimezone: deviceZone }).then(
      (next) => {
        if (next.timezone !== before) toast.info(`Your time zone is now ${zoneLabel(next.timezone)}`, 'It follows the device you are using.');
      },
      () => undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [zoneBusy, setZoneBusy] = useState(false);
  const saveZone = async (patch: HostUpdate, describe: (h: AdminHost) => string) => {
    if (zoneBusy) return;
    setZoneBusy(true);
    try {
      toast.success(describe(await update(patch)));
    } catch (e) {
      toast.error('The time zone did not change', errorMessage(e));
    } finally {
      setZoneBusy(false);
    }
  };
  const setMode = (next: ZoneMode) => {
    if (next === host.timezoneMode) return;
    if (next === 'device') void saveZone({ timezoneMode: 'device', deviceTimezone: deviceZone }, (h) => `Following this device: ${zoneLabel(h.timezone)}`);
    else if (next === 'google') void saveZone({ timezoneMode: 'google' }, (h) => `Following Google Calendar: ${zoneLabel(h.timezone)}`);
    else void saveZone({ timezoneMode: 'fixed', timezone: host.timezone }, (h) => `Time zone fixed to ${zoneLabel(h.timezone)}`);
  };

  // ── calendars
  const connect = () => {
    window.location.assign(googleConnectUrl({ hostId: id, token, returnTo: `${APP_BASE}/host/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}` }));
  };

  const [calBusy, setCalBusy] = useState(false);
  const [calError, setCalError] = useState<string | null>(null);
  useEffect(() => {
    if (!connected || calendars) return;
    const controller = new AbortController();
    setCalError(null);
    getHostSelfCalendars(id, token, { signal: controller.signal }).then(
      (list) => onCalendars(list),
      (e: unknown) => {
        if (!controller.signal.aborted) setCalError(errorMessage(e, 'Your calendars could not be loaded.'));
      },
    );
    return () => controller.abort();
  }, [connected, calendars, id, token, onCalendars]);

  const saveCalendars = async (patch: HostUpdate) => {
    if (calBusy) return;
    setCalBusy(true);
    try {
      await update(patch);
    } catch (e) {
      toast.error('Your calendar choice was not saved', errorMessage(e));
    } finally {
      setCalBusy(false);
    }
  };
  const busyIds = google?.busyCalendarIds ?? [];
  const writable = (calendars ?? []).filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer');

  // ── hours
  const baseHours = useMemo<HoursDraft>(() => ({ schedules: host.schedules, defaultScheduleId: host.defaultScheduleId }), [host.schedules, host.defaultScheduleId]);
  const [hours, setHours] = useState<HoursDraft>(baseHours);
  const lastBase = useRef(baseHours);
  useEffect(() => {
    setHours((prev) => (same(prev, lastBase.current) ? baseHours : prev));
    lastBase.current = baseHours;
  }, [baseHours]);
  const hoursDirty = !same(hours, baseHours);
  const hoursProblem = hoursDirty ? scheduleProblem(hours.schedules) : null;
  const [savingHours, setSavingHours] = useState(false);
  const [hoursError, setHoursError] = useState<string | null>(null);

  const saveHours = async () => {
    if (savingHours || hoursProblem || !hoursDirty) return;
    setSavingHours(true);
    setHoursError(null);
    try {
      lastBase.current = hours;
      await update({ schedules: hours.schedules, defaultScheduleId: hours.defaultScheduleId });
      toast.success('Your hours are saved', 'New bookings follow them from now on.');
    } catch (e) {
      const failure = e instanceof ApiFailure ? e : null;
      setHoursError(failure?.fields ? Object.values(failure.fields)[0] : errorMessage(e, 'Your hours could not be saved.'));
    } finally {
      setSavingHours(false);
    }
  };

  // Closing the tab with unsaved hours asks first.
  useEffect(() => {
    if (!hoursDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hoursDirty]);

  // ── other calendars (ICS)
  const [feedLabel, setFeedLabel] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
  const [feedBusy, setFeedBusy] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [removingFeed, setRemovingFeed] = useState<string | null>(null);

  const addFeed = async (e: FormEvent) => {
    e.preventDefault();
    if (feedBusy) return;
    const url = feedUrl.trim();
    if (!/^(https|webcal):\/\/\S+$/i.test(url)) {
      setFeedError('Paste the full link. It starts with https:// or webcal://');
      return;
    }
    setFeedBusy(true);
    setFeedError(null);
    try {
      await update({ addIcsFeed: { label: feedLabel.trim() || 'Calendar feed', url } });
      setFeedLabel('');
      setFeedUrl('');
      toast.success('Calendar linked', 'Busy times from it are now kept free.');
    } catch (err) {
      const failure = err instanceof ApiFailure ? err : null;
      setFeedError(failure?.fields ? Object.values(failure.fields)[0] : errorMessage(err, 'That calendar could not be linked. Check the link and try again.'));
    } finally {
      setFeedBusy(false);
    }
  };

  const removeFeed = async (feedId: string) => {
    setRemovingFeed(feedId);
    try {
      await update({ removeIcsFeedId: feedId });
    } catch (e) {
      toast.error('The calendar was not removed', errorMessage(e));
    } finally {
      setRemovingFeed(null);
    }
  };

  // ── details
  const [name, setName] = useState(host.name);
  const [title, setTitle] = useState(host.title ?? '');
  const [detailsBusy, setDetailsBusy] = useState(false);
  const detailsDirty = name.trim() !== host.name || title.trim() !== (host.title ?? '');
  const saveDetails = async (e: FormEvent) => {
    e.preventDefault();
    if (detailsBusy || !detailsDirty || !name.trim()) return;
    setDetailsBusy(true);
    try {
      await update({ name: name.trim(), title: title.trim() });
      toast.success('Saved');
    } catch (err) {
      toast.error('Your details were not saved', errorMessage(err));
    } finally {
      setDetailsBusy(false);
    }
  };

  return (
    <div className="hp">
      <header className="hp-hero">
        <div className="hp-hero__who">
          <Avatar name={host.name} src={host.avatarUrl} size={56} decorative />
          <p className="hp-hero__eyebrow">Co-host page · meetings with {siteName}</p>
        </div>
        <h1 className="hp-hero__title">{ready ? `You are all set, ${me}.` : `Hi ${me}. One step to go.`}</h1>
        <p className="hp-hero__lead">
          {ready
            ? `People can now book time with you and ${owner}, and only when you are both free. Come back to this page whenever your hours or calendars change.`
            : `${owner} added you as a co-host. Connect your calendar and people will only be offered times when you are really free.`}
        </p>
        <ol className="hp-track" aria-label="Setup">
          <li className={cx('hp-track__step', ready && 'is-done')}>
            <span className="hp-track__mark" aria-hidden="true">
              {ready ? <Check size={13} strokeWidth={3} /> : '1'}
            </span>
            Calendar
            <span className="u-vh">{ready ? ': connected' : ': not connected yet'}</span>
          </li>
          <li className="hp-track__step is-done">
            <span className="hp-track__mark" aria-hidden="true">
              <Check size={13} strokeWidth={3} />
            </span>
            Hours
            <span className="u-vh">: set, change them below</span>
          </li>
          <li className="hp-track__step is-done">
            <span className="hp-track__mark" aria-hidden="true">
              <Check size={13} strokeWidth={3} />
            </span>
            Time zone
            <span className="u-vh">: automatic</span>
          </li>
        </ol>
      </header>

      <Card
        id="hp-calendar"
        icon={<CalendarCheck size={20} />}
        title="Your calendar"
        description="We only look at when you are busy, never at what the event is. New meetings are added for you."
        status={connected ? <Pill tone="ok">Connected</Pill> : needsReconnect ? <Pill tone="warn">Reconnect needed</Pill> : <Pill tone="wait">Not connected</Pill>}
      >
        {connected && google ? (
          <>
            <p className="hp-ok">
              <CircleCheck size={17} aria-hidden="true" />
              <span>
                Connected as <strong>{google.email}</strong>
              </span>
            </p>
            {calError ? (
              <p className="hp-error" role="alert">
                {calError}
              </p>
            ) : !calendars ? (
              <div className="hp-callist" aria-busy="true">
                <Skeleton height={22} width="60%" />
                <Skeleton height={22} width="44%" />
                <Skeleton height={22} width="52%" />
              </div>
            ) : (
              <>
                <fieldset className="hp-fieldset">
                  <legend className="hp-legend">Keep me free when these calendars are busy</legend>
                  <ul role="list" className="hp-callist">
                    {calendars.map((c) => (
                      <li key={c.id}>
                        <Checkbox
                          checked={busyIds.includes(c.id) || (c.primary && busyIds.includes('primary'))}
                          disabled={calBusy}
                          onChange={(on) => {
                            const alias = c.primary && busyIds.includes('primary') ? 'primary' : c.id;
                            const next = on ? [...busyIds, c.id] : busyIds.filter((x) => x !== alias && x !== c.id);
                            void saveCalendars({ busyCalendarIds: next });
                          }}
                          label={
                            <span className="ix-cal">
                              <span className="ix-cal__dot" style={{ background: c.backgroundColor || 'var(--c-faint)' }} aria-hidden="true" />
                              <span className="ix-cal__name">{c.summary}</span>
                              {c.primary ? <span className="ix-cal__tag">Main</span> : null}
                            </span>
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </fieldset>
                {busyIds.length === 0 ? (
                  <p className="hp-warn" role="status">
                    <TriangleAlert size={15} aria-hidden="true" />
                    <span>No calendar is ticked, so people could book over your other plans.</span>
                  </p>
                ) : null}
                {writable.length > 1 ? (
                  <Field label="Add new meetings to" className="hp-narrow">
                    <Select
                      value={writable.some((c) => c.id === google.writeCalendarId) ? google.writeCalendarId : (writable.find((c) => c.primary)?.id ?? google.writeCalendarId)}
                      disabled={calBusy}
                      onChange={(e) => void saveCalendars({ writeCalendarId: e.target.value })}
                      options={writable.map((c) => ({ value: c.id, label: c.primary ? `${c.summary} (main)` : c.summary }))}
                    />
                  </Field>
                ) : null}
                <p className="hp-quiet">Changes here save on their own.</p>
              </>
            )}
          </>
        ) : (
          <>
            {needsReconnect ? (
              <p className="hp-warn" role="status">
                <TriangleAlert size={15} aria-hidden="true" />
                <span>Google asked you to sign in again. Until you do, your busy times are not checked.</span>
              </p>
            ) : null}
            {googleConfigured ? (
              <div className="hp-connect">
                <Button variant="primary" size="lg" iconLeft={<CalendarCheck size={18} />} onClick={connect}>
                  {needsReconnect ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
                </Button>
                <p className="hp-quiet">You will be taken to Google to allow access, then brought straight back here.</p>
              </div>
            ) : (
              <p className="hp-note">
                <Unlink size={16} aria-hidden="true" />
                <span>
                  {owner} has not finished the Google setup yet, so connecting is not possible right now. You can already set your hours below, or link another calendar further down.
                </span>
              </p>
            )}
            <ul className="hp-promises">
              <li>
                <ShieldCheck size={15} aria-hidden="true" />
                We read busy and free only. Event names and guests stay private.
              </li>
              <li>
                <CalendarPlus size={15} aria-hidden="true" />
                Meetings booked with you appear on your calendar by themselves.
              </li>
            </ul>
          </>
        )}
      </Card>

      <Card id="hp-hours" icon={<Clock size={20} />} title="Your hours" description={`When you are open to meetings. A joint meeting with ${owner} is only offered when it fits both of you.`} status={hoursDirty ? <Pill tone="wait">Not saved yet</Pill> : undefined}>
        <ScheduleEditor
          schedules={hours.schedules}
          defaultScheduleId={hours.defaultScheduleId}
          timezone={host.timezone}
          onChange={(next) => {
            setHours(next);
            setHoursError(null);
          }}
        />
        {hoursProblem || hoursError ? (
          <p className="hp-error" role="alert">
            {hoursProblem ?? hoursError}
          </p>
        ) : null}
        <div className={cx('hp-save', hoursDirty && 'is-dirty')}>
          <Button variant="primary" disabled={!hoursDirty || !!hoursProblem} loading={savingHours} loadingLabel="Saving" onClick={() => void saveHours()}>
            Save hours
          </Button>
          {hoursDirty ? (
            <Button variant="ghost" disabled={savingHours} onClick={() => setHours(baseHours)}>
              Undo changes
            </Button>
          ) : (
            <span className="hp-quiet">Your hours are saved.</span>
          )}
        </div>
      </Card>

      <Card
        id="hp-zone"
        icon={<Globe size={20} />}
        title="Your time zone"
        description="Your hours are in this zone. People who book always see times in their own."
        status={<Pill tone="ok">{host.timezoneMode === 'fixed' ? 'Fixed' : 'Automatic'}</Pill>}
      >
        <div className="hp-zone">
          <p className="hp-zone__name">{zoneLabel(host.timezone)}</p>
          <p className="hp-zone__clock">
            {formatTime(now, host.timezone)} right now · {formatOffset(zoneOffsetMinutes(host.timezone, now))}
          </p>
        </div>
        <RadioGroup<ZoneMode>
          label="Keep it up to date"
          variant="cards"
          columns={3}
          value={host.timezoneMode}
          onChange={setMode}
          disabled={zoneBusy}
          options={[
            { value: 'device', icon: <MonitorSmartphone size={18} />, label: 'Follow this device', description: 'Updates when you open this page somewhere new.' },
            { value: 'google', icon: <CalendarDays size={18} />, label: 'Follow Google Calendar', description: connected ? 'Uses the zone set in your Google Calendar.' : 'Connect Google Calendar to use this.', disabled: !connected },
            { value: 'fixed', icon: <Lock size={18} />, label: 'Keep it fixed', description: 'Stays put until you choose another.' },
          ]}
        />
        {host.timezoneMode === 'fixed' ? (
          <div className="hp-narrow">
            <TimezoneSelect value={host.timezone} disabled={zoneBusy} onChange={(timezone) => void saveZone({ timezoneMode: 'fixed', timezone }, (h) => `Time zone set to ${zoneLabel(h.timezone)}`)} />
          </div>
        ) : host.timezoneMode === 'device' && deviceZone !== host.timezone ? (
          <p className="hp-quiet">This device is in {zoneLabel(deviceZone)}. Reload the page to switch to it.</p>
        ) : null}
      </Card>

      <Card
        id="hp-feeds"
        icon={<LinkIcon size={20} />}
        title="Another calendar"
        description="Using Outlook, iCloud or a work calendar? Paste its private ICS link and those busy times are kept free too. This is optional."
      >
        {host.icsFeeds.length ? (
          <ul role="list" className="hp-feeds">
            {host.icsFeeds.map((f) => (
              <li key={f.id} className="hp-feed">
                <CalendarDays size={16} aria-hidden="true" />
                <span className="hp-feed__label">{f.label}</span>
                <span className="hp-feed__state">Linked</span>
                <IconButton label={`Remove ${f.label}`} icon={<Trash2 size={16} />} size="sm" loading={removingFeed === f.id} onClick={() => void removeFeed(f.id)} />
              </li>
            ))}
          </ul>
        ) : null}
        <form className="hp-feedform" onSubmit={addFeed} noValidate>
          <Field label="Name" optional className="hp-feedform__label">
            <Input value={feedLabel} maxLength={60} placeholder="Work calendar" autoComplete="off" onChange={(e) => setFeedLabel(e.target.value)} />
          </Field>
          <Field label="ICS link" error={feedError ?? undefined} className="hp-feedform__url">
            <Input
              type="url"
              inputMode="url"
              value={feedUrl}
              placeholder="https://"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setFeedUrl(e.target.value);
                setFeedError(null);
              }}
            />
          </Field>
          <Button type="submit" variant="secondary" loading={feedBusy} loadingLabel="Linking" disabled={!feedUrl.trim()} className="hp-feedform__btn">
            Link calendar
          </Button>
        </form>
        <details className="hp-help">
          <summary>Where do I find the link?</summary>
          <ul>
            <li>
              <strong>Outlook:</strong> Settings, Calendar, Shared calendars, Publish a calendar, then copy the ICS link.
            </li>
            <li>
              <strong>iCloud:</strong> in Calendar, share the calendar as a Public Calendar and copy its link.
            </li>
            <li>
              <strong>Other apps:</strong> look for "subscribe", "publish" or "iCal link" in the calendar's sharing settings.
            </li>
          </ul>
          <p>The link is stored encrypted and is never shown again.</p>
        </details>
      </Card>

      <Card id="hp-details" icon={<UserRound size={20} />} title="Your details" description="How you appear on booking pages, and how we reach you.">
        <form className="hp-details" onSubmit={saveDetails} noValidate>
          <div className="hp-grid2">
            <Field label="Name">
              <Input value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Role or title" optional>
              <Input value={title} maxLength={80} placeholder="Head of Partnerships" autoComplete="organization-title" onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>
          {detailsDirty ? (
            <div>
              <Button type="submit" variant="secondary" loading={detailsBusy} loadingLabel="Saving" disabled={!name.trim()}>
                Save details
              </Button>
            </div>
          ) : null}
        </form>
        <Switch
          labelSide="start"
          checked={host.notify.email}
          onChange={(email) => void update({ notify: { ...host.notify, email } }).catch((e: unknown) => toast.error('Not saved', errorMessage(e)))}
          label="Email me about bookings"
          description={host.email ? `New, moved and cancelled meetings, sent to ${host.email}.` : 'New, moved and cancelled meetings.'}
        />
      </Card>

      <footer className="hp-foot">
        <Lock size={14} aria-hidden="true" />
        <p>This page is private to you. Anyone with the link can change these settings, so keep it to yourself. If it gets out, ask {owner} for a new one.</p>
      </footer>
    </div>
  );
}

// ───────────── loading, errors, shell ─────────────

function HostSkeleton() {
  return (
    <div className="hp" aria-busy="true">
      <p className="u-vh" role="status">
        Loading your page
      </p>
      <div className="hp-hero" aria-hidden="true">
        <Skeleton circle width={56} height={56} />
        <Skeleton width="62%" height={40} />
        <Skeleton lines={2} height={16} />
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="hp-card" aria-hidden="true">
          <Skeleton width="40%" height={22} />
          <Skeleton lines={3} height={15} />
          <Skeleton width={220} height={48} />
        </div>
      ))}
    </div>
  );
}

export default function HostPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('t') ?? '';
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const previous = document.title;
    document.title = 'Your co-host page';
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    if (!id || !token) {
      setState({ status: 'invalid' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    getHostSelf(id, token, { signal: controller.signal }).then(
      (data) => setState({ status: 'ready', data }),
      (e: unknown) => {
        if (controller.signal.aborted) return;
        const failure = e instanceof ApiFailure ? e : null;
        if (failure && (failure.status === 404 || failure.status === 401 || failure.status === 403)) setState({ status: 'invalid' });
        else setState({ status: 'error', message: errorMessage(e, 'This page did not load. Please try again.') });
      },
    );
    return () => controller.abort();
  }, [id, token, attempt]);

  const onHost = useCallback((host: AdminHost) => {
    setState((prev) => (prev.status === 'ready' ? { status: 'ready', data: { ...prev.data, host, calendars: host.google ? prev.data.calendars : null } } : prev));
  }, []);
  const onCalendars = useCallback((calendars: GoogleCalendarListItem[] | null) => {
    setState((prev) => (prev.status === 'ready' ? { status: 'ready', data: { ...prev.data, calendars } } : prev));
  }, []);

  const data = state.status === 'ready' ? state.data : null;
  const boot = useMemo(() => cachedTheme(), []);
  const theme = data?.theme ?? boot.theme ?? DEFAULT_THEME;
  const assets = useMemo<ThemeAssets>(() => {
    if (!data) return boot.assets ?? NO_ASSETS;
    return { coverUrl: null, logoUrl: assetUrl(data.theme.logoAssetId), backgroundUrl: assetUrl(data.theme.background?.imageAssetId) };
  }, [data, boot.assets]);

  return (
    <ThemeScope theme={theme} assets={assets}>
      <main className="hp-page">
        {state.status === 'loading' ? (
          <HostSkeleton />
        ) : state.status === 'invalid' ? (
          <div className="hp hp--message">
            <div className="hp-card">
              <EmptyState
                as="h2"
                icon={<Unlink />}
                title="This link does not work any more"
                description="It may have been replaced by a newer one, or part of it went missing when it was copied. Ask the person who invited you to send a fresh link."
              />
            </div>
          </div>
        ) : state.status === 'error' ? (
          <div className="hp hp--message">
            <div className="hp-card">
              <EmptyState
                as="h2"
                tone="danger"
                icon={<TriangleAlert />}
                title="This page did not load"
                description={state.message}
                action={
                  <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
                    Try again
                  </Button>
                }
              />
            </div>
          </div>
        ) : (
          <>
            <GoogleReturn onDone={() => navigate(`/host/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`, { replace: true })} />
            <HostPanel id={id} token={token} data={state.data} onHost={onHost} onCalendars={onCalendars} />
          </>
        )}
      </main>
    </ThemeScope>
  );
}

/** Back from Google: say what happened (inside the theme, so the toast is themed) and tidy the address. */
function GoogleReturn({ onDone }: { onDone: () => void }) {
  const [params] = useSearchParams();
  const toast = useToast();
  const handled = useRef(false);
  useEffect(() => {
    const result = params.get('google');
    if (!result || handled.current) return;
    handled.current = true;
    if (result === 'connected') toast.success('Your calendar is connected', 'Times when you are busy are no longer offered.');
    else toast.error('Google did not connect', googleReason(params.get('reason')));
    onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  return null;
}
