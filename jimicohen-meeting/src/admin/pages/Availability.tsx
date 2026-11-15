import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronRight, Globe, Lock, MonitorSmartphone } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { AdminHost, HostUpdate, Schedule } from '../../../shared/types';
import { ApiFailure, errorMessage, updateHost } from '../../lib/api';
import { detectZone, formatOffset, formatTime, zoneLabel, zoneOffsetMinutes } from '../../lib/tz';
import { Avatar, ButtonLink, RadioGroup, TimezoneSelect, useToast } from '../../ui';
import { Notice, Page, PageHeader, SaveBar } from '../components/Page';
import { ScheduleEditor, scheduleProblem } from '../components/ScheduleEditor';
import { useUnsavedGuard } from '../components/UnsavedGuard';
import { firstName, sameJson } from '../format';
import { useAdmin } from '../state';

type ZoneMode = AdminHost['timezoneMode'];

interface HoursDraft {
  schedules: Schedule[];
  defaultScheduleId: string;
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

export default function Availability() {
  const { data, setData, ownerHost } = useAdmin();
  const toast = useToast();
  const latest = useRef(data);
  latest.current = data;

  const [base, setBase] = useState<HoursDraft>(() => ({ schedules: ownerHost.schedules, defaultScheduleId: ownerHost.defaultScheduleId }));
  const [draft, setDraft] = useState<HoursDraft>(base);
  const [saving, setSaving] = useState(false);
  const [serverProblem, setServerProblem] = useState<string | null>(null);
  const [zoneBusy, setZoneBusy] = useState(false);

  const dirty = !sameJson(draft, base);
  useUnsavedGuard(dirty);
  const problem = useMemo(() => (dirty ? scheduleProblem(draft.schedules) : null), [dirty, draft.schedules]);

  const now = useNow(30000);
  const deviceZone = useMemo(() => detectZone(), []);
  const zone = ownerHost.timezone;
  const mode = ownerHost.timezoneMode;
  const coHosts = data.hosts.filter((h) => h.id !== ownerHost.id);

  const applyHost = (host: AdminHost) => {
    const current = latest.current;
    setData({ ...current, hosts: current.hosts.map((h) => (h.id === host.id ? host : h)) });
  };

  const saveHours = async () => {
    if (saving || problem) return;
    setSaving(true);
    setServerProblem(null);
    try {
      const host = await updateHost(ownerHost.id, { schedules: draft.schedules, defaultScheduleId: draft.defaultScheduleId });
      applyHost(host);
      const next = { schedules: host.schedules, defaultScheduleId: host.defaultScheduleId };
      setBase(next);
      setDraft(next);
      toast.success('Availability saved', 'New bookings follow these hours from now on.');
    } catch (e) {
      const failure = e instanceof ApiFailure ? e : null;
      const fieldMessage = failure?.fields ? Object.values(failure.fields)[0] : undefined;
      if (fieldMessage) setServerProblem(fieldMessage);
      toast.error('Your hours were not saved', fieldMessage ?? errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const saveZone = async (update: HostUpdate, describe: (host: AdminHost) => string) => {
    if (zoneBusy) return;
    setZoneBusy(true);
    try {
      const host = await updateHost(ownerHost.id, update);
      applyHost(host);
      toast.success(describe(host));
    } catch (e) {
      toast.error('The time zone did not change', errorMessage(e));
    } finally {
      setZoneBusy(false);
    }
  };

  const setMode = (next: ZoneMode) => {
    if (next === mode) return;
    if (next === 'device') void saveZone({ timezoneMode: 'device', deviceTimezone: deviceZone }, (h) => `Following this device: ${zoneLabel(h.timezone)}`);
    else if (next === 'google') void saveZone({ timezoneMode: 'google' }, (h) => `Following Google Calendar: ${zoneLabel(h.timezone)}`);
    else void saveZone({ timezoneMode: 'fixed', timezone: zone }, (h) => `Time zone fixed to ${zoneLabel(h.timezone)}`);
  };

  return (
    <Page>
      <PageHeader title="Availability" description="When people can book you. Your hours follow your time zone, and invitees always see times in their own." />

      <section className="adm-panel adm-zone" aria-labelledby="avail-zone">
        <div className="adm-zone__now">
          <p className="adm-eyebrow" id="avail-zone">
            Your time zone
          </p>
          <p className="adm-zone__name">{zoneLabel(zone)}</p>
          <p className="adm-zone__clock">
            <Globe size={15} aria-hidden="true" />
            <span>
              {formatTime(now, zone)} right now · {formatOffset(zoneOffsetMinutes(zone, now))}
            </span>
          </p>
        </div>
        <div className="adm-zone__mode">
          <RadioGroup<ZoneMode>
            label="Keep it up to date"
            variant="cards"
            columns={3}
            value={mode}
            onChange={setMode}
            options={[
              {
                value: 'device',
                icon: <MonitorSmartphone size={18} />,
                label: 'Follow this device',
                description: 'Changes on its own when you open the dashboard somewhere new.',
              },
              {
                value: 'google',
                icon: <CalendarDays size={18} />,
                label: 'Follow Google Calendar',
                description: ownerHost.google ? `Uses the time zone set in ${ownerHost.google.email}, your main Google account.` : 'Connect Google Calendar to use this.',
                disabled: !ownerHost.google,
              },
              { value: 'fixed', icon: <Lock size={18} />, label: 'Keep it fixed', description: 'Stays put until you choose another one.' },
            ]}
          />
          {mode === 'fixed' ? (
            <div className="adm-zone__pick">
              <TimezoneSelect value={zone} disabled={zoneBusy} onChange={(timezone) => void saveZone({ timezoneMode: 'fixed', timezone }, (h) => `Time zone set to ${zoneLabel(h.timezone)}`)} />
            </div>
          ) : mode === 'device' && deviceZone !== zone ? (
            <p className="adm-zone__note">This device is in {zoneLabel(deviceZone)}. Reload the page to switch to it.</p>
          ) : mode === 'google' && deviceZone !== zone ? (
            // Google Calendar keeps its zone when you travel, and it may never have been set: say when the two differ.
            <p className="adm-zone__note">
              This device is in {zoneLabel(deviceZone)}. Your hours follow Google Calendar: {zoneLabel(zone)}.{' '}
              <button
                type="button"
                className="adm-textbtn"
                disabled={zoneBusy}
                onClick={() => void saveZone({ timezoneMode: 'device', deviceTimezone: deviceZone }, (h) => `Following this device: ${zoneLabel(h.timezone)}`)}
              >
                Follow this device instead
              </button>
            </p>
          ) : !ownerHost.google ? (
            <p className="adm-zone__note">
              <Link className="adm-textlink" to="/admin/integrations">
                Connect Google Calendar
              </Link>{' '}
              to follow its time zone instead.
            </p>
          ) : null}
        </div>
      </section>

      {serverProblem ? (
        <Notice tone="danger" title="Your hours were not saved">
          {serverProblem}
        </Notice>
      ) : null}

      <section className="adm-avail" aria-label="Your hours">
        <ScheduleEditor
          schedules={draft.schedules}
          defaultScheduleId={draft.defaultScheduleId}
          timezone={zone}
          onChange={(next) => {
            setDraft(next);
            setServerProblem(null);
          }}
        />
      </section>

      {coHosts.length ? (
        <div className="adm-hintcard">
          <div className="adm-hintcard__avatars" aria-hidden="true">
            {coHosts.slice(0, 3).map((h) => (
              <Avatar key={h.id} name={h.name} src={h.avatarUrl} size="sm" decorative />
            ))}
          </div>
          <div>
            <p className="adm-hintcard__title">
              {coHosts.length === 1 ? `${firstName(coHosts[0].name)} sets their own hours` : 'Co-hosts set their own hours'}
            </p>
            <p className="adm-hintcard__text">Each co-host has a private link for their calendar, hours and time zone. Together meetings only offer times that fit everyone.</p>
          </div>
          <ButtonLink variant="secondary" size="sm" to="/admin/team" iconRight={<ChevronRight size={15} />}>
            Open Team
          </ButtonLink>
        </div>
      ) : null}

      <SaveBar
        dirty={dirty}
        saving={saving}
        problem={problem}
        saveLabel="Save hours"
        onSave={() => void saveHours()}
        onDiscard={() => {
          setDraft(base);
          setServerProblem(null);
        }}
      />
    </Page>
  );
}
