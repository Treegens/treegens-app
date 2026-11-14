import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronDown, Globe, LocateFixed, Search } from 'lucide-react';
import { allZones, detectZone, formatTime, listZones, searchZones, zoneInfo, zoneLabel } from '../lib/tz';
import type { ZoneInfo } from '../lib/tz';
import { Input } from './Input';
import { Modal } from './Modal';
import { cx } from './util';

export interface TimezoneDialogProps {
  open: boolean;
  onClose: () => void;
  /** current IANA zone */
  value: string;
  /** called with the chosen zone. The dialog closes itself afterwards. */
  onChange: (zone: string) => void;
  /** how the current time in each zone is written. Defaults to the locale's habit. */
  hour12?: boolean;
  title?: string;
}

interface Row {
  zone: ZoneInfo;
  /** group heading to print above this row */
  heading?: string;
}

/**
 * Searchable time zone list in a dialog (bottom sheet on phones). Search understands cities,
 * countries, zone names and offsets ("nairobi", "kenya", "pacific", "gmt+3"). Arrow keys move
 * through the list from the search field and Enter picks.
 */
export function TimezoneDialog({ open, onClose, value, onChange, hour12, title = 'Choose a time zone' }: TimezoneDialogProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const now = useMemo(() => Date.now(), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const device = useMemo(() => detectZone(), []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    if (!open) return [];
    const q = query.trim();
    if (q) return searchZones(q, now).map((zone) => ({ zone }));
    const out: Row[] = [];
    const known = new Set(allZones(now).map((z) => z.id));
    const top = Array.from(new Set([value, device])).filter(Boolean);
    top.forEach((id, i) => out.push({ zone: known.has(id) ? allZones(now).find((z) => z.id === id)! : zoneInfo(id, now), heading: i === 0 ? 'Suggested' : undefined }));
    for (const group of listZones(now)) {
      group.zones.forEach((zone, i) => out.push({ zone, heading: i === 0 ? group.region : undefined }));
    }
    return out;
  }, [open, query, now, value, device]);

  useEffect(() => {
    setActive(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (zone: string) => {
    onChange(zone);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row) pick(row.zone.id);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={title} size="md" flush className="ui-zones">
      <div className="ui-zones__search">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search a city, country or zone"
          aria-label="Search time zones"
          leading={<Search size={16} aria-hidden="true" />}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          data-autofocus=""
        />
        {value !== device ? (
          <button type="button" className="ui-zones__device" onClick={() => pick(device)}>
            <LocateFixed size={15} aria-hidden="true" />
            <span>Use my device time zone: {zoneLabel(device, now)}</span>
          </button>
        ) : null}
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label="Time zones" className="ui-zones__list" tabIndex={-1}>
        {rows.length === 0 ? (
          <p className="ui-zones__none">No time zone matches “{query.trim()}”. Try a nearby big city.</p>
        ) : (
          rows.map((row, i) => {
            const z = row.zone;
            const selected = z.id === value;
            return (
              <div key={`${z.id}-${i}`} role="presentation">
                {row.heading ? (
                  <div className="ui-zones__heading" role="presentation">
                    {row.heading}
                  </div>
                ) : null}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={selected}
                  data-index={i}
                  className={cx('ui-zone', i === active && 'is-active', selected && 'is-selected')}
                  onClick={() => pick(z.id)}
                  onMouseMove={() => (i !== active ? setActive(i) : undefined)}
                >
                  <span className="ui-zone__main">
                    <span className="ui-zone__city">{z.city}</span>
                    <span className="ui-zone__name">{z.name}</span>
                  </span>
                  <span className="ui-zone__meta">
                    <span className="ui-zone__time">{formatTime(now, z.id, { hour12 })}</span>
                    <span className="ui-zone__offset">{z.offset}</span>
                  </span>
                  <Check className="ui-zone__check" size={16} aria-hidden="true" />
                </div>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}

export interface TimezoneSelectProps {
  value: string;
  onChange: (zone: string) => void;
  hour12?: boolean;
  /**
   * field  = looks like a Select, for forms (dashboard availability, host page)
   * inline = quiet text button with a globe, for "Times are in ..." lines on public pages
   */
  variant?: 'field' | 'inline';
  /** accessible name of the trigger. The visible text is always the current zone. */
  'aria-label'?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** Shows the current zone ("East Africa Time (Nairobi)") and opens TimezoneDialog to change it. */
export function TimezoneSelect({ value, onChange, hour12, variant = 'field', disabled = false, id, className, 'aria-label': ariaLabel = 'Time zone' }: TimezoneSelectProps) {
  const [open, setOpen] = useState(false);
  const label = useMemo(() => zoneLabel(value), [value]);
  return (
    <>
      <button
        type="button"
        id={id}
        className={cx(variant === 'field' ? 'ui-input ui-zone-trigger' : 'ui-zone-inline', className)}
        aria-haspopup="dialog"
        aria-label={`${ariaLabel}: ${label}. Change`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Globe size={16} aria-hidden="true" />
        <span className="ui-zone-trigger__label">{label}</span>
        <ChevronDown size={16} aria-hidden="true" className="ui-zone-trigger__chevron" />
      </button>
      <TimezoneDialog open={open} onClose={() => setOpen(false)} value={value} onChange={onChange} hour12={hour12} />
    </>
  );
}
