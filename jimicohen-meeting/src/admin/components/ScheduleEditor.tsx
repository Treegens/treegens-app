/**
 * Availability editor: named schedules, weekly hours (several ranges per day, copy to other
 * days) and date overrides. Controlled: every edit calls `onChange` with the full next value,
 * the parent decides when to save.
 *
 * Works inside <AdminScope> and <ThemeScope> (the co-host page): it reads --c-* variables only.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarOff, CalendarPlus, Copy, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { WEEKDAY_HOURS } from '../../../shared/defaults';
import type { DateOverride, LocalDate, Schedule, TimeRange } from '../../../shared/types';
import { addDays, formatDayKey, todayKey, weekdayNames, zoneLabel } from '../../lib/tz';
import { Badge, Button, ConfirmDialog, IconButton, Input, Menu, cx } from '../../ui';
import { localId, sameJson } from '../format';
import { OverrideDialog } from './OverrideDialog';
import { formatWallRange } from './TimeSelect';
import { WEEKDAYS, WeeklyHoursEditor, rangesProblem } from './WeeklyHoursEditor';
import './schedule-editor.css';

export interface ScheduleEditorProps {
  schedules: Schedule[];
  defaultScheduleId: string;
  /** IANA zone the hours are in, shown for context */
  timezone: string;
  onChange: (next: { schedules: Schedule[]; defaultScheduleId: string }) => void;
}

/** First thing wrong with a set of schedules, in words, or null when they can be saved. */
export function scheduleProblem(schedules: Schedule[]): string | null {
  const names = weekdayNames(0, undefined, 'long');
  for (const s of schedules) {
    if (!s.name.trim()) return 'Give every schedule a name.';
    for (const day of WEEKDAYS) {
      const problem = rangesProblem(s.weekly[day] ?? []);
      if (problem) return `${s.name}, ${names[day]}: ${problem}`;
    }
    for (const o of s.overrides) {
      const problem = rangesProblem(o.ranges);
      if (problem) return `${s.name}, ${formatDayKey(o.date, undefined, 'medium')}: ${problem}`;
    }
  }
  return null;
}

interface OverrideGroup {
  dates: LocalDate[];
  ranges: TimeRange[];
}

/** Consecutive dates with the same hours read as one line: "Dec 24 to Dec 26". */
function groupOverrides(overrides: DateOverride[], from: LocalDate): OverrideGroup[] {
  const sorted = overrides.filter((o) => o.date >= from).sort((a, b) => a.date.localeCompare(b.date));
  const groups: OverrideGroup[] = [];
  for (const o of sorted) {
    const last = groups[groups.length - 1];
    if (last && addDays(last.dates[last.dates.length - 1], 1) === o.date && sameJson(last.ranges, o.ranges)) last.dates.push(o.date);
    else groups.push({ dates: [o.date], ranges: o.ranges });
  }
  return groups;
}

function groupLabel(g: OverrideGroup): string {
  if (g.dates.length === 1) return formatDayKey(g.dates[0], undefined, 'medium');
  return `${formatDayKey(g.dates[0], undefined, 'medium')} to ${formatDayKey(g.dates[g.dates.length - 1], undefined, 'medium')}`;
}

export function ScheduleEditor({ schedules, defaultScheduleId, timezone, onChange }: ScheduleEditorProps) {
  const [activeId, setActiveId] = useState(defaultScheduleId);
  const [dialog, setDialog] = useState<{ initial: OverrideGroup | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const focusName = useRef(false);

  const active = schedules.find((s) => s.id === activeId) ?? schedules.find((s) => s.id === defaultScheduleId) ?? schedules[0];
  const today = useMemo(() => todayKey(timezone), [timezone]);
  const groups = useMemo(() => (active ? groupOverrides(active.overrides, today) : []), [active, today]);

  useEffect(() => {
    if (active && active.id !== activeId) setActiveId(active.id);
  }, [active, activeId]);

  useEffect(() => {
    if (!focusName.current) return;
    focusName.current = false;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [activeId]);

  if (!active) {
    return (
      <div className="sch">
        <div className="sch__empty">
          <p>No schedule yet.</p>
          <Button
            variant="secondary"
            iconLeft={<Plus size={16} />}
            onClick={() => {
              const id = localId('sch');
              onChange({ schedules: [{ id, name: 'Working hours', weekly: structuredClone(WEEKDAY_HOURS), overrides: [] }], defaultScheduleId: id });
            }}
          >
            Create a schedule
          </Button>
        </div>
      </div>
    );
  }

  const emit = (nextSchedules: Schedule[], nextDefault = defaultScheduleId) => onChange({ schedules: nextSchedules, defaultScheduleId: nextDefault });
  const patchActive = (fn: (s: Schedule) => Schedule) => emit(schedules.map((s) => (s.id === active.id ? fn(s) : s)));
  const isDefault = active.id === defaultScheduleId;

  const addSchedule = (copyOf?: Schedule) => {
    const id = localId('sch');
    const base: Schedule = copyOf
      ? { ...structuredClone(copyOf), id, name: `${copyOf.name} (copy)` }
      : { id, name: `Schedule ${schedules.length + 1}`, weekly: structuredClone(WEEKDAY_HOURS), overrides: [] };
    focusName.current = true;
    emit([...schedules, base]);
    setActiveId(id);
  };

  const removeActive = () => {
    const rest = schedules.filter((s) => s.id !== active.id);
    if (!rest.length) return;
    emit(rest, isDefault ? rest[0].id : defaultScheduleId);
    setActiveId(isDefault ? rest[0].id : defaultScheduleId);
  };

  const applyOverride = (dates: LocalDate[], ranges: TimeRange[], replacing: LocalDate[]) => {
    patchActive((s) => {
      const drop = new Set([...dates, ...replacing]);
      // Dates that have passed no longer matter: drop them so the list never grows forever.
      const kept = s.overrides.filter((o) => !drop.has(o.date) && o.date >= addDays(today, -1));
      const added = dates.map((date) => ({ date, ranges: ranges.map((r) => ({ ...r })) }));
      return { ...s, overrides: [...kept, ...added].sort((a, b) => a.date.localeCompare(b.date)) };
    });
  };

  return (
    <div className="sch">
      <div className="sch__bar">
        {schedules.length > 1 ? (
          <div className="sch__tabs" role="tablist" aria-label="Schedules">
            {schedules.map((s) => (
              <button key={s.id} type="button" role="tab" aria-selected={s.id === active.id} className={cx('sch__tab', s.id === active.id && 'is-selected')} onClick={() => setActiveId(s.id)}>
                {s.id === defaultScheduleId ? <Star size={13} aria-label="Default schedule" className="sch__star" /> : null}
                <span className="u-truncate">{s.name || 'Untitled'}</span>
              </button>
            ))}
          </div>
        ) : null}
        <Button variant="ghost" size="sm" iconLeft={<Plus size={15} />} onClick={() => addSchedule()} className="sch__new" aria-label="New schedule">
          New schedule
        </Button>
      </div>

      <div className="sch__head">
        <div className="sch__name">
          <Input
            ref={nameRef}
            aria-label="Schedule name"
            value={active.name}
            maxLength={60}
            placeholder="Schedule name"
            invalid={!active.name.trim()}
            leading={<Pencil size={14} aria-hidden="true" />}
            onChange={(e) => patchActive((s) => ({ ...s, name: e.target.value }))}
          />
        </div>
        <div className="sch__headactions">
          {isDefault ? (
            <Badge tone="primary" icon={<Star size={12} />}>
              Default
            </Badge>
          ) : (
            <Button variant="secondary" size="sm" iconLeft={<Star size={14} />} onClick={() => emit(schedules, active.id)}>
              Make default
            </Button>
          )}
          <Menu
            label="Schedule actions"
            trigger={<IconButton label="More schedule actions" icon={<MoreHorizontal />} variant="secondary" size="sm" />}
            items={[
              { label: 'Duplicate', icon: <Copy size={16} />, onSelect: () => addSchedule(active) },
              { type: 'separator' },
              { label: 'Delete schedule', icon: <Trash2 size={16} />, danger: true, disabled: schedules.length <= 1, onSelect: () => setConfirmDelete(true) },
            ]}
          />
        </div>
      </div>

      <div className="sch__grid">
        <section className="sch__panel" aria-label="Weekly hours">
          <div className="sch__panelhead">
            <h3 className="sch__title">Weekly hours</h3>
            <p className="sch__zone">Times are in {zoneLabel(timezone)}</p>
          </div>
          <WeeklyHoursEditor value={active.weekly} onChange={(weekly) => patchActive((s) => ({ ...s, weekly }))} />
        </section>

        <section className="sch__panel sch__panel--overrides" aria-label="Date overrides">
          <div className="sch__panelhead">
            <h3 className="sch__title">Date overrides</h3>
            <p className="sch__zone">Different hours on specific dates, or days off.</p>
          </div>
          {groups.length ? (
            <ul className="sch-ovrlist" role="list">
              {groups.map((g) => (
                <li key={g.dates[0]} className="sch-ovrlist__item">
                  <div className="sch-ovrlist__text">
                    <p className="sch-ovrlist__date">{groupLabel(g)}</p>
                    <p className={cx('sch-ovrlist__hours', !g.ranges.length && 'is-off')}>{g.ranges.length ? g.ranges.map((r) => formatWallRange(r)).join(', ') : 'Unavailable'}</p>
                  </div>
                  <IconButton size="sm" label={`Edit the override for ${groupLabel(g)}`} icon={<Pencil />} onClick={() => setDialog({ initial: g })} />
                  <IconButton
                    size="sm"
                    variant="danger"
                    label={`Remove the override for ${groupLabel(g)}`}
                    icon={<Trash2 />}
                    onClick={() => patchActive((s) => ({ ...s, overrides: s.overrides.filter((o) => !g.dates.includes(o.date)) }))}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className="sch-ovrempty">
              <CalendarOff size={18} aria-hidden="true" />
              <p>No overrides. Add one for a holiday, a trip or a day with different hours.</p>
            </div>
          )}
          <Button variant="secondary" size="sm" iconLeft={<CalendarPlus size={15} />} onClick={() => setDialog({ initial: null })}>
            Add a date override
          </Button>
        </section>
      </div>

      <OverrideDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        timezone={timezone}
        existing={active.overrides}
        initial={dialog?.initial ?? null}
        onApply={(dates, ranges) => applyOverride(dates, ranges, dialog?.initial?.dates ?? [])}
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={removeActive}
        tone="danger"
        title={`Delete "${active.name || 'this schedule'}"?`}
        description="Event types that use this schedule go back to the default schedule."
        confirmLabel="Delete schedule"
      />
    </div>
  );
}

export default ScheduleEditor;
