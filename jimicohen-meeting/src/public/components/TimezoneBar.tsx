import { SegmentedControl, TimezoneSelect } from '../../ui';

export interface TimezoneBarProps {
  zone: string;
  onZoneChange: (zone: string) => void;
  hour12: boolean;
  onHour12Change: (hour12: boolean) => void;
}

/** "Times are in East Africa Time (Nairobi)" with a searchable switcher, and the 12 / 24 hour toggle. */
export function TimezoneBar({ zone, onZoneChange, hour12, onHour12Change }: TimezoneBarProps) {
  return (
    <div className="bw-tz">
      <div className="bw-tz__zone">
        <span className="bw-tz__label">Times are in</span>
        <TimezoneSelect variant="inline" value={zone} onChange={onZoneChange} hour12={hour12} aria-label="Times are in" className="bw-tz__select" />
      </div>
      <SegmentedControl
        size="sm"
        aria-label="Clock format"
        value={hour12 ? '12' : '24'}
        onChange={(v) => onHour12Change(v === '12')}
        options={[
          { value: '12', label: '12h', ariaLabel: '12 hour clock' },
          { value: '24', label: '24h', ariaLabel: '24 hour clock' },
        ]}
        className="bw-tz__clock"
      />
    </div>
  );
}
