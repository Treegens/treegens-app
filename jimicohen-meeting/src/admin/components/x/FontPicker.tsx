/**
 * Font choice for the design editor: a select-like button that opens a list where every font
 * is written in its own face. A font is only downloaded once its row scrolls into view, and
 * picking one applies it to the live preview straight away while the list stays open.
 */
import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { FONT_CATALOG, FONT_CATEGORY_LABELS, fontByKey } from '../../../../shared/presets';
import type { FontCategory, FontDef } from '../../../../shared/presets';
import { loadFonts } from '../../../lib/theme';
import { cx } from '../../../ui';
import { Popover } from '../Popover';
import { useSeen } from './bits';

const ORDER: FontCategory[] = ['sans', 'serif', 'display', 'mono', 'system'];

function FontOption({ font, selected, sample, onPick }: { font: FontDef; selected: boolean; sample: string; onPick: () => void }) {
  const [ref, seen] = useSeen<HTMLButtonElement>();
  useEffect(() => {
    if (seen) loadFonts([font.key]);
  }, [seen, font.key]);
  return (
    <button ref={ref} type="button" role="option" aria-selected={selected} className={cx('dx-font__opt', selected && 'is-selected')} onClick={onPick} data-font-option="">
      <span className="dx-font__sample" style={seen ? { fontFamily: font.stack, fontWeight: font.headingWeight, letterSpacing: `${font.headingTracking}em` } : undefined}>
        {sample}
      </span>
      <span className="dx-font__name">{font.label}</span>
      {selected ? <Check size={15} aria-hidden="true" className="dx-font__check" /> : null}
    </button>
  );
}

export interface FontPickerProps {
  /** key in FONT_CATALOG */
  value: string;
  onChange: (key: string) => void;
  /** names the control: "Heading font" */
  label: string;
  /** words written in each font */
  sample?: string;
  id?: string;
}

export function FontPicker({ value, onChange, label, sample = 'Book a meeting', id }: FontPickerProps) {
  const current = fontByKey(value);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    loadFonts([current.key]);
  }, [current.key]);

  /** When the list opens, start at the current font instead of the top. */
  const openAtSelected = (node: HTMLDivElement | null) => {
    listRef.current = node;
    if (!node) return;
    window.setTimeout(() => {
      const selected = node.querySelector<HTMLElement>('[aria-selected="true"]');
      selected?.scrollIntoView({ block: 'center' });
      selected?.focus({ preventScroll: true });
    }, 40);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-font-option]') ?? []);
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
    items[next]?.focus();
  };

  return (
    <Popover
      label={label}
      side="bottom"
      align="start"
      className="dx-font__panel"
      trigger={
        <button type="button" id={id} className="ui-input dx-font__trigger" aria-label={`${label}: ${current.label}. Change`}>
          <span className="dx-font__current" style={{ fontFamily: current.stack, fontWeight: current.headingWeight }}>
            {current.label}
          </span>
          <span className="dx-font__cat">{current.category === 'system' ? 'System' : FONT_CATEGORY_LABELS[current.category]}</span>
          <ChevronDown size={16} aria-hidden="true" className="dx-font__chev" />
        </button>
      }
    >
      {() => (
        <div ref={openAtSelected} role="listbox" aria-label={label} className="dx-font__list" onKeyDown={onKeyDown}>
          {ORDER.map((cat) => {
            const fonts = FONT_CATALOG.filter((f) => f.category === cat);
            if (!fonts.length) return null;
            return (
              <div key={cat} role="group" aria-label={FONT_CATEGORY_LABELS[cat]} className="dx-font__group">
                <p className="dx-font__heading" aria-hidden="true">
                  {FONT_CATEGORY_LABELS[cat]}
                </p>
                {fonts.map((f) => (
                  <FontOption key={f.key} font={f} selected={f.key === current.key} sample={sample} onPick={() => onChange(f.key)} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </Popover>
  );
}
