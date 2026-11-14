import { createContext, useContext, useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from './util';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: ReactNode;
  /** small count or status after the label */
  badge?: ReactNode;
  disabled?: boolean;
}

interface TabsContextValue {
  baseId: string;
  value: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

export interface TabsProps<T extends string = string> {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** names the tab list for screen readers */
  label: string;
  /** underline = page sections. pills = filters inside a panel. */
  variant?: 'underline' | 'pills';
  /** tabs share the full width equally */
  block?: boolean;
  /** <TabPanel> elements. Optional: you can also render the active content yourself. */
  children?: ReactNode;
  className?: string;
}

/**
 * Tab list with roving focus (arrow keys, Home, End). Scrolls sideways on narrow screens.
 *
 *   <Tabs label="Event settings" tabs={tabs} value={tab} onChange={setTab}>
 *     <TabPanel id="basics">...</TabPanel>
 *     <TabPanel id="hosts">...</TabPanel>
 *   </Tabs>
 */
export function Tabs<T extends string = string>({ tabs, value, onChange, label, variant = 'underline', block = false, children, className }: TabsProps<T>) {
  const auto = useId();
  const baseId = `tabs${auto}`;
  const listRef = useRef<HTMLDivElement>(null);

  const focusTab = (i: number) => {
    const el = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[i];
    el?.focus();
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const step = (from: number, dir: 1 | -1) => {
    const n = tabs.length;
    for (let s = 1; s <= n; s++) {
      const i = (from + dir * s + n * s) % n;
      if (!tabs[i].disabled) {
        onChange(tabs[i].id);
        focusTab(i);
        return;
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(i, 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(i, -1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      step(-1, 1);
    } else if (e.key === 'End') {
      e.preventDefault();
      step(tabs.length, -1);
    }
  };

  return (
    <TabsContext.Provider value={{ baseId, value }}>
      <div className={cx('ui-tabs', `ui-tabs--${variant}`, block && 'ui-tabs--block', className)}>
        <div ref={listRef} role="tablist" aria-label={label} className="ui-tabs__list">
          {tabs.map((t, i) => {
            const selected = t.id === value;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${baseId}-tab-${t.id}`}
                aria-selected={selected}
                aria-controls={children ? `${baseId}-panel-${t.id}` : undefined}
                tabIndex={selected ? 0 : -1}
                disabled={t.disabled}
                className={cx('ui-tab', selected && 'is-selected')}
                onClick={() => onChange(t.id)}
                onKeyDown={(e) => onKeyDown(e, i)}
              >
                {t.icon ? (
                  <span className="ui-tab__icon" aria-hidden="true">
                    {t.icon}
                  </span>
                ) : null}
                <span>{t.label}</span>
                {t.badge !== undefined && t.badge !== null ? <span className="ui-tab__badge">{t.badge}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
      {children}
    </TabsContext.Provider>
  );
}

export interface TabPanelProps {
  /** matches a TabItem id */
  id: string;
  /** keep the panel in the DOM while hidden (preserves form state) */
  keepMounted?: boolean;
  className?: string;
  children: ReactNode;
}

/** Content for one tab. Must be rendered inside <Tabs>. */
export function TabPanel({ id, keepMounted = false, className, children }: TabPanelProps) {
  const ctx = useContext(TabsContext);
  const active = ctx ? ctx.value === id : true;
  if (!active && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={ctx ? `${ctx.baseId}-panel-${id}` : undefined}
      aria-labelledby={ctx ? `${ctx.baseId}-tab-${id}` : undefined}
      hidden={!active}
      tabIndex={0}
      className={cx('ui-tabpanel', className)}
    >
      {children}
    </div>
  );
}
