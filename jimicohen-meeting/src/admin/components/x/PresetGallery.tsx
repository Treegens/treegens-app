/**
 * The preset gallery: one small, honest thumbnail per preset, painted with the preset's own
 * CSS variables (background layers, card, type, button), so what you see is what you get.
 */
import { useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { THEME_PRESETS, fontByKey } from '../../../../shared/presets';
import type { ThemePreset } from '../../../../shared/presets';
import { themeToCssVars } from '../../../../shared/theme';
import { loadFonts } from '../../../lib/theme';
import { cx } from '../../../ui';
import { useSeen } from './bits';

const varsCache = new Map<string, CSSProperties>();

function varsOf(preset: ThemePreset): CSSProperties {
  let vars = varsCache.get(preset.key);
  if (!vars) {
    vars = themeToCssVars(preset.theme, null) as CSSProperties;
    varsCache.set(preset.key, vars);
  }
  return vars;
}

function PresetCard({ preset, selected, onPick }: { preset: ThemePreset; selected: boolean; onPick: () => void }) {
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const vars = useMemo(() => varsOf(preset), [preset]);
  const heading = fontByKey(preset.theme.fontHeading);

  useEffect(() => {
    if (seen) loadFonts([preset.theme.fontHeading]);
  }, [seen, preset.theme.fontHeading]);

  return (
    <button ref={ref} type="button" className={cx('dx-preset', selected && 'is-selected')} aria-pressed={selected} onClick={onPick}>
      <span className="dx-preset__thumb" style={vars} data-card={preset.theme.cardStyle} aria-hidden="true">
        <span className="dx-preset__card">
          <span className="dx-preset__title" style={seen ? { fontFamily: heading.stack, fontWeight: heading.headingWeight } : undefined}>
            Aa
          </span>
          <span className="dx-preset__lines">
            <span />
            <span />
          </span>
          <span className="dx-preset__row">
            <span className="dx-preset__days">
              <span />
              <span className="is-on" />
              <span />
              <span />
            </span>
            <span className="dx-preset__btn" />
          </span>
        </span>
        {selected ? (
          <span className="dx-preset__tick">
            <Check size={12} strokeWidth={3.2} />
          </span>
        ) : null}
      </span>
      <span className="dx-preset__name">{preset.label}</span>
      <span className="dx-preset__desc">{preset.description}</span>
    </button>
  );
}

export interface PresetGalleryProps {
  /** Theme.preset of the draft: a preset key or "custom" */
  value: string;
  onPick: (key: string) => void;
}

export function PresetGallery({ value, onPick }: PresetGalleryProps) {
  return (
    <div className="dx-presets" role="group" aria-label="Presets">
      {THEME_PRESETS.map((p) => (
        <PresetCard key={p.key} preset={p} selected={p.key === value} onPick={() => onPick(p.key)} />
      ))}
    </div>
  );
}
