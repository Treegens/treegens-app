/**
 * The visitor's display preferences: time zone and 12 / 24 hour clock.
 *
 * The zone is detected from the device. A manual choice is remembered in localStorage and wins
 * on the next visit, until the visitor picks their device zone again. The clock follows the
 * theme (which follows the locale when set to "auto") until the visitor flips the toggle.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { STORAGE_KEYS, storageGet, storageRemove, storageSet } from '../../lib/storage';
import { detectZone, isValidZone } from '../../lib/tz';

export interface VisitorPrefs {
  zone: string;
  /** the zone the device reports */
  deviceZone: string;
  setZone: (zone: string) => void;
  hour12: boolean;
  setHour12: (hour12: boolean) => void;
}

export interface VisitorPrefsOptions {
  /** clock style to use until the visitor chooses: the theme's resolved setting */
  defaultHour12: boolean;
  /** false in the design editor preview: nothing is read from or written to storage */
  persist?: boolean;
}

export function useVisitorPrefs({ defaultHour12, persist = true }: VisitorPrefsOptions): VisitorPrefs {
  const deviceZone = useMemo(() => detectZone(), []);

  const [zone, setZoneState] = useState<string>(() => {
    if (persist) {
      const saved = storageGet(STORAGE_KEYS.zone);
      if (isValidZone(saved)) return saved;
    }
    return deviceZone;
  });

  const [hourChoice, setHourChoice] = useState<boolean | null>(() => {
    if (!persist) return null;
    const saved = storageGet(STORAGE_KEYS.hourFormat);
    return saved === '12' ? true : saved === '24' ? false : null;
  });

  // In the design editor the theme's clock setting is being edited live: follow it again when it changes.
  useEffect(() => {
    if (!persist) setHourChoice(null);
  }, [persist, defaultHour12]);

  const setZone = useCallback(
    (next: string) => {
      if (!isValidZone(next)) return;
      setZoneState(next);
      if (!persist) return;
      if (next === deviceZone) storageRemove(STORAGE_KEYS.zone);
      else storageSet(STORAGE_KEYS.zone, next);
    },
    [deviceZone, persist],
  );

  const setHour12 = useCallback(
    (next: boolean) => {
      setHourChoice(next);
      if (persist) storageSet(STORAGE_KEYS.hourFormat, next ? '12' : '24');
    },
    [persist],
  );

  return { zone, deviceZone, setZone, hour12: hourChoice ?? defaultHour12, setHour12 };
}
