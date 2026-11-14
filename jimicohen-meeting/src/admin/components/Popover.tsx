import { cloneElement, useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent, ReactElement, ReactNode, Ref } from 'react';
import { Portal, cx, focusableWithin, mergeRefs, useAnchoredPosition, useDismiss } from '../../ui';
import type { Align, Side } from '../../ui';

export interface PopoverProps {
  /** one element that accepts a ref and onClick (Button, IconButton) */
  trigger: ReactElement;
  /** names the panel for screen readers */
  label: string;
  side?: Side;
  align?: Align;
  className?: string;
  /** content; call `close()` when done */
  children: (close: () => void) => ReactNode;
}

/**
 * A small anchored panel for a handful of controls (copy hours to other days, quick pickers).
 * Focus moves in on open and returns to the trigger on close. Escape and outside presses close it.
 */
export function Popover({ trigger, label, side = 'bottom', align = 'end', className, children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const pos = useAnchoredPosition(open, triggerRef, panelRef, { side, align, offset: 6 });

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useDismiss(open, [panelRef, triggerRef], (reason) => close(reason === 'escape'));

  useEffect(() => {
    if (!open || !pos.ready) return;
    const first = focusableWithin(panelRef.current)[0];
    (first ?? panelRef.current)?.focus({ preventScroll: true });
  }, [open, pos.ready]);

  const t = trigger as ReactElement<Record<string, unknown>> & { ref?: Ref<HTMLElement> };
  const tp = t.props as { onClick?: (e: MouseEvent<HTMLElement>) => void };
  const triggerEl = cloneElement(t, {
    ref: mergeRefs(triggerRef, t.ref),
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': open ? panelId : undefined,
    onClick: (e: MouseEvent<HTMLElement>) => {
      tp.onClick?.(e);
      setOpen((v) => !v);
    },
  });

  return (
    <>
      {triggerEl}
      {open ? (
        <Portal>
          <div ref={panelRef} id={panelId} role="dialog" aria-label={label} tabIndex={-1} className={cx('ui-menu adm-popover', className)} data-side={pos.side} style={pos.style}>
            {children(() => close(true))}
          </div>
        </Portal>
      ) : null}
    </>
  );
}
