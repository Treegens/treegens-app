import { cloneElement, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactElement, ReactNode, Ref } from 'react';
import { Check } from 'lucide-react';
import { Portal } from './Portal';
import { useAnchoredPosition, useDismiss } from './overlay';
import type { Align, Side } from './overlay';
import { cx, mergeRefs } from './util';

export type MenuItem =
  | {
      type?: 'item';
      /** stable key. Defaults to the index. */
      id?: string;
      label: ReactNode;
      icon?: ReactNode;
      /** quiet text on the right (a shortcut, a value) */
      hint?: ReactNode;
      onSelect?: () => void;
      /** renders the item as a link */
      href?: string;
      /** open the link in a new tab */
      external?: boolean;
      danger?: boolean;
      disabled?: boolean;
      /** show a tick: the item is the current choice */
      checked?: boolean;
    }
  | { type: 'separator' }
  | { type: 'label'; label: ReactNode };

export interface MenuProps {
  /** one element that accepts a ref and onClick: a Button or IconButton */
  trigger: ReactElement;
  items: MenuItem[];
  /** names the menu for screen readers */
  label?: string;
  side?: Side;
  align?: Align;
  /** menu is at least as wide as the trigger */
  matchWidth?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

/**
 * Dropdown of actions. Opens on click, Enter, Space or ArrowDown. Arrow keys, Home, End
 * and first-letter typing move between items. Escape closes and returns focus.
 */
export function Menu({ trigger, items, label, side = 'bottom', align = 'end', matchWidth = false, onOpenChange, className }: MenuProps) {
  const [open, setOpenState] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusFirst = useRef<'first' | 'last'>('first');
  const typed = useRef({ text: '', at: 0 });
  const menuId = useId();
  const pos = useAnchoredPosition(open, triggerRef, menuRef, { side, align, offset: 6, matchWidth });

  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useDismiss(open, [menuRef, triggerRef], (reason) => close(reason === 'escape'));

  const enabledItems = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []);

  useEffect(() => {
    if (!open || !pos.ready) return;
    const list = enabledItems();
    const target = focusFirst.current === 'last' ? list[list.length - 1] : list[0];
    (target ?? menuRef.current)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pos.ready]);

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = enabledItems();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      close(false);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      const now = Date.now();
      typed.current = { text: now - typed.current.at > 600 ? e.key.toLowerCase() : typed.current.text + e.key.toLowerCase(), at: now };
      const match = list.find((el) => (el.textContent ?? '').trim().toLowerCase().startsWith(typed.current.text));
      match?.focus();
    }
  };

  const t = trigger as ReactElement<Record<string, unknown>> & { ref?: Ref<HTMLElement> };
  const tp = t.props as { onClick?: (e: MouseEvent<HTMLElement>) => void; onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void };
  const triggerEl = cloneElement(t, {
    ref: mergeRefs(triggerRef, t.ref),
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: (e: MouseEvent<HTMLElement>) => {
      tp.onClick?.(e);
      focusFirst.current = 'first';
      setOpen(!open);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      tp.onKeyDown?.(e);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focusFirst.current = e.key === 'ArrowUp' ? 'last' : 'first';
        setOpen(true);
      }
    },
  });

  return (
    <>
      {triggerEl}
      {open ? (
        <Portal>
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            className={cx('ui-menu', className)}
            data-side={pos.side}
            style={pos.style}
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item, i) => {
              if (item.type === 'separator') return <div key={`sep-${i}`} role="separator" className="ui-menu__sep" />;
              if (item.type === 'label') {
                return (
                  <div key={`label-${i}`} className="ui-menu__label" role="presentation">
                    {item.label}
                  </div>
                );
              }
              const role = item.checked !== undefined ? 'menuitemradio' : 'menuitem';
              const cls = cx('ui-menu__item', item.danger && 'is-danger');
              const inner = (
                <>
                  {item.icon ? (
                    <span className="ui-menu__icon" aria-hidden="true">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className="ui-menu__text">{item.label}</span>
                  {item.hint ? <span className="ui-menu__hint">{item.hint}</span> : null}
                  {item.checked ? <Check className="ui-menu__check" size={16} aria-hidden="true" /> : null}
                </>
              );
              const select = () => {
                if (item.disabled) return;
                close(true);
                item.onSelect?.();
              };
              if (item.href && !item.disabled) {
                return (
                  <a
                    key={item.id ?? i}
                    role={role}
                    aria-checked={item.checked}
                    href={item.href}
                    tabIndex={-1}
                    className={cls}
                    onClick={select}
                    {...(item.external ? { target: '_blank', rel: 'noopener noreferrer' } : null)}
                  >
                    {inner}
                  </a>
                );
              }
              return (
                <button
                  key={item.id ?? i}
                  type="button"
                  role={role}
                  aria-checked={item.checked}
                  aria-disabled={item.disabled || undefined}
                  tabIndex={-1}
                  className={cls}
                  onClick={select}
                >
                  {inner}
                </button>
              );
            })}
          </div>
        </Portal>
      ) : null}
    </>
  );
}
