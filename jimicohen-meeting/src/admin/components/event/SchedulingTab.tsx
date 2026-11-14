import { Link } from 'react-router-dom';
import { WEEKDAY_HOURS } from '../../../../shared/defaults';
import type { EventScheduling } from '../../../../shared/types';
import { addDays, todayKey, zoneLabel } from '../../../lib/tz';
import { Field, Input, Select, Switch } from '../../../ui';
import { firstName } from '../../format';
import { useAdmin } from '../../state';
import { NumberField, OffsetInput } from '../Fields';
import { FieldGroup, Section } from '../Page';
import { WeeklyHoursEditor } from '../WeeklyHoursEditor';
import type { TabProps } from './shared';

const BUFFERS = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120];
const INCREMENTS = [5, 10, 15, 20, 30, 45, 60, 90, 120];

function minuteOptions(values: number[], current: number, zeroLabel?: string) {
  const all = Array.from(new Set([...values, current])).sort((a, b) => a - b);
  return all.map((v) => ({ value: String(v), label: v === 0 && zeroLabel ? zeroLabel : v % 60 === 0 && v >= 60 ? `${v / 60} ${v === 60 ? 'hour' : 'hours'}` : `${v} minutes` }));
}

export function SchedulingTab({ draft, update, errors }: TabProps) {
  const { data, ownerHost } = useAdmin();
  const s = draft.scheduling;
  const set = (patch: Partial<EventScheduling>) => update({ scheduling: { ...s, ...patch } });
  const hosts = draft.hostIds.map((id) => data.hosts.find((h) => h.id === id)).filter((h): h is NonNullable<typeof h> => !!h);
  const today = todayKey(ownerHost.timezone);

  return (
    <>
      <Section title="When people can book" description="How soon, and how far ahead.">
        <div className="adm-grid2">
          <FieldGroup label="Minimum notice" hint="Nobody can book closer to the start than this." error={errors['scheduling.minNoticeMinutes']}>
            <OffsetInput label="Minimum notice" value={s.minNoticeMinutes} maxMinutes={43200} invalid={!!errors['scheduling.minNoticeMinutes']} onChange={(minNoticeMinutes) => set({ minNoticeMinutes })} />
          </FieldGroup>
          <Field label="Book up to" hint="A rolling window that moves forward every day." error={errors['scheduling.maxDaysAhead']}>
            <NumberField value={s.maxDaysAhead} min={1} max={730} suffix="days ahead" onChange={(maxDaysAhead) => set({ maxDaysAhead })} />
          </Field>
        </div>
        <Switch
          labelSide="start"
          checked={!!s.dateRange}
          onChange={(on) => set({ dateRange: on ? { start: today, end: addDays(today, 30) } : null })}
          label="Only between two dates"
          description="For a launch week, a trip or a limited offer. Dates are in your time zone."
        />
        {s.dateRange ? (
          <div className="adm-grid2">
            <Field label="From" error={errors['scheduling.dateRange.start'] ?? errors['scheduling.dateRange']}>
              <Input type="date" value={s.dateRange.start} max={s.dateRange.end || undefined} onChange={(e) => s.dateRange && e.target.value && set({ dateRange: { ...s.dateRange, start: e.target.value } })} />
            </Field>
            <Field label="Until" error={errors['scheduling.dateRange.end']}>
              <Input type="date" value={s.dateRange.end} min={s.dateRange.start || undefined} onChange={(e) => s.dateRange && e.target.value && set({ dateRange: { ...s.dateRange, end: e.target.value } })} />
            </Field>
          </div>
        ) : null}
      </Section>

      <Section title="Around each meeting" description="Breathing room, and how start times are spaced.">
        <div className="adm-grid2">
          <Field label="Buffer before" hint="Kept free before the meeting starts." error={errors['scheduling.bufferBeforeMin']}>
            <Select value={String(s.bufferBeforeMin)} options={minuteOptions(BUFFERS, s.bufferBeforeMin, 'No buffer')} onChange={(e) => set({ bufferBeforeMin: Number(e.target.value) })} />
          </Field>
          <Field label="Buffer after" hint="Kept free after it ends." error={errors['scheduling.bufferAfterMin']}>
            <Select value={String(s.bufferAfterMin)} options={minuteOptions(BUFFERS, s.bufferAfterMin, 'No buffer')} onChange={(e) => set({ bufferAfterMin: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="adm-grid2">
          <Field label="Start times every" hint="30 minutes offers 9:00, 9:30, 10:00 and so on." error={errors['scheduling.slotIncrementMin']}>
            <Select value={String(s.slotIncrementMin)} options={minuteOptions(INCREMENTS, s.slotIncrementMin)} onChange={(e) => set({ slotIncrementMin: Number(e.target.value) })} />
          </Field>
          <FieldGroup label="Daily limit" hint={s.maxPerDay ? 'Counted per host, per day, for this event type.' : 'No limit: every free time can be booked.'} error={errors['scheduling.maxPerDay']}>
            <div className="adm-inline">
              <Switch checked={!!s.maxPerDay} onChange={(on) => set({ maxPerDay: on ? 3 : null })} aria-label="Limit bookings per day" />
              {s.maxPerDay ? <NumberField aria-label="Bookings per day" value={s.maxPerDay} min={1} max={50} suffix="per day" onChange={(maxPerDay) => set({ maxPerDay })} className="adm-w-md" /> : <span className="adm-quiet">Off</span>}
            </div>
          </FieldGroup>
        </div>
      </Section>

      <Section
        title="Hours"
        description="Each host's weekly hours decide what is on offer. Pick a different schedule for this event, or narrow it further."
        aside={
          <Link className="adm-textlink" to="/admin/availability">
            Edit your weekly hours
          </Link>
        }
      >
        {hosts.map((h) => {
          const defaultName = h.schedules.find((x) => x.id === h.defaultScheduleId)?.name ?? 'Default';
          const chosen = s.scheduleIds[h.id] && h.schedules.some((x) => x.id === s.scheduleIds[h.id]) ? s.scheduleIds[h.id] : '';
          return (
            <Field key={h.id} label={hosts.length > 1 ? `${firstName(h.name)}'s schedule` : 'Schedule'} hint={h.schedules.length > 1 ? undefined : h.id === ownerHost.id ? 'You have one schedule. Add more under Availability to choose between them.' : `${firstName(h.name)} has one schedule, set from their own link.`}>
              <Select
                wrapperClassName="adm-w-lg"
                value={chosen}
                disabled={h.schedules.length <= 1}
                options={[{ value: '', label: `Default (${defaultName})` }, ...h.schedules.filter((x) => x.id !== h.defaultScheduleId).map((x) => ({ value: x.id, label: x.name }))]}
                onChange={(e) => {
                  const next = { ...s.scheduleIds };
                  if (e.target.value) next[h.id] = e.target.value;
                  else delete next[h.id];
                  set({ scheduleIds: next });
                }}
              />
            </Field>
          );
        })}
        <Switch
          labelSide="start"
          checked={!!s.restrictHours}
          onChange={(on) => set({ restrictHours: on ? structuredClone(WEEKDAY_HOURS) : null })}
          label="Only offer this event during certain hours"
          description="An extra limit on top of everyone's own hours. Good for keeping one kind of meeting to the afternoon."
        />
        {s.restrictHours ? (
          <div className="adm-well">
            <p className="adm-well__note">These hours are in your time zone, {zoneLabel(ownerHost.timezone)}.</p>
            <WeeklyHoursEditor value={s.restrictHours} onChange={(restrictHours) => set({ restrictHours })} />
            {errors['scheduling.restrictHours'] ? (
              <p className="adm-fielderror" role="alert">
                {errors['scheduling.restrictHours']}
              </p>
            ) : null}
          </div>
        ) : null}
      </Section>
    </>
  );
}
