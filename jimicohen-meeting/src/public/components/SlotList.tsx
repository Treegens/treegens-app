import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { CalendarSearch } from 'lucide-react';
import { formatDayKey, formatTime, zonedParts } from '../../lib/tz';
import { Skeleton, cx } from '../../ui';
import { plural } from '../lib/text';

export interface SlotListProps {
  /** the chosen day (key in the visitor's zone), or null when none is chosen yet */
  day: string | null;
  /** start times of that day, ascending, epoch ms */
  slots: number[];
  zone: string;
  hour12: boolean;
  selected: number | null;
  onSelect: (start: number) => void;
  loading?: boolean;
  /** the visitor's current booking when rescheduling */
  currentStart?: number | null;
  locale?: string;
  /** shown under the list, e.g. the confirm bar when rescheduling */
  footer?: ReactNode;
  /** what to show when there is no day or no time */
  emptyTitle?: string;
  emptyHint?: ReactNode;
}

type Period = 'Morning' | 'Afternoon' | 'Evening' | 'Night';

function periodOf(hour: number): Period {
  if (hour < 5) return 'Night';
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  if (hour < 22) return 'Evening';
  return 'Night';
}

/** The open times of one day: real buttons in lists, grouped by part of the day. */
export function SlotList({ day, slots, zone, hour12, selected, onSelect, loading = false, currentStart, locale, footer, emptyTitle, emptyHint }: SlotListProps) {
  const headingId = useId();

  const groups = useMemo(() => {
    const out: { period: Period; items: number[] }[] = [];
    for (const s of slots) {
      const period = periodOf(zonedParts(s, zone).hour);
      const last = out[out.length - 1];
      if (last && last.period === period) last.items.push(s);
      else out.push({ period, items: [s] });
    }
    return out;
  }, [slots, zone]);

  // When the list scrolls inside its panel, a soft fade at the bottom says there is more below.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setMore(el.scrollHeight - el.clientHeight > 4 && el.scrollTop + el.clientHeight < el.scrollHeight - 6);
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [day, slots, loading]);

  // A new day starts at the top of its list.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [day]);

  if (loading) {
    return (
      <div className="bw-slots" aria-busy="true">
        <div className="bw-slots__head">
          <Skeleton width="62%" height={20} />
        </div>
        <div className="bw-slots__scroll">
          <ul role="list" className="bw-slots__list" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i}>
                <Skeleton className="bw-slot-skel" />
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (!day || slots.length === 0) {
    return (
      <div className="bw-slots bw-slots--empty">
        <span className="bw-slots__emptyicon" aria-hidden="true">
          <CalendarSearch size={20} />
        </span>
        <p className="bw-slots__emptytitle">{emptyTitle ?? (day ? 'No times left on this day' : 'Choose a day')}</p>
        <p className="bw-slots__emptyhint">{emptyHint ?? (day ? 'Try another day in the calendar.' : 'Days with open times are highlighted in the calendar.')}</p>
      </div>
    );
  }

  let index = 0;
  const showPeriods = groups.length > 1;

  return (
    <section className="bw-slots" aria-labelledby={headingId}>
      <div className="bw-slots__head">
        <h3 className="bw-slots__day" id={headingId}>
          {formatDayKey(day, locale, 'long')}
        </h3>
        <p className="bw-slots__count">{plural(slots.length, 'time', 'times')}</p>
      </div>
      <div className="bw-slots__scroll" ref={scrollRef} data-more={more}>
        {groups.map((group) => (
          <div key={group.period + group.items[0]} className="bw-slots__group" role="group" aria-label={group.period}>
            {showPeriods ? (
              <p className="bw-slots__period" aria-hidden="true">
                {group.period}
              </p>
            ) : null}
            <ul role="list" className="bw-slots__list">
              {group.items.map((start) => {
                const isSelected = selected === start;
                const isCurrent = currentStart === start;
                const i = index++;
                return (
                  <li key={start} style={{ '--i': Math.min(i, 14) } as CSSProperties}>
                    <button
                      type="button"
                      className={cx('bw-slot', isSelected && 'is-selected', isCurrent && 'is-current')}
                      aria-pressed={isSelected}
                      data-start={start}
                      onClick={() => onSelect(start)}
                    >
                      <span className="bw-slot__time">{formatTime(start, zone, { hour12, locale })}</span>
                      {isCurrent ? <span className="bw-slot__tag">Current</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      {footer}
    </section>
  );
}
