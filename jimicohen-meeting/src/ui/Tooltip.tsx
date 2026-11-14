import { Children, cloneElement, useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent, PointerEvent, ReactElement, ReactNode, Ref } from 'react';
import { Portal } from './Portal';
import { useAnchoredPosition } from './overlay';
import type { Align, Side } from './overlay';
import { mergeRefs } from './util';

export interface TooltipProps {
  content: ReactNode;
  /** exactly one element that accepts a ref and pointer / focus handlers (any kit control, or a DOM element) */
  children: ReactElement;
  side?: Side;
  align?: Align;
  /** ms before it appears on hover */
  delay?: number;
  /** the child already has this text as its accessible name, so do not also describe it */
  labelled?: boolean;
  disabled?: boolean;
}

/** Short hint on hover (mouse) and keyboard focus. Never the only way to learn something essential. */
export function Tooltip({ content, children, side = 'top', align = 'center', delay = 350, labelled = false, disabled = false }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number>();
  const id = useId();
  const pos = useAnchoredPosition(open, anchorRef, tipRef, { side, align, offset: 8 });

  const clear = () => window.clearTimeout(timer.current);
  const show = (wait: number) => {
    clear();
    timer.current = window.setTimeout(() => setOpen(true), wait);
  };
  const hide = () => {
    clear();
    setOpen(false);
  };

  useEffect(() => clear, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const child = Children.only(children) as ReactElement<Record<string, unknown>> & { ref?: Ref<HTMLElement> };
  if (disabled || content === null || content === undefined || content === '') return child;

  const p = child.props as {
    onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
    onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
    onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
    onFocus?: (e: FocusEvent<HTMLElement>) => void;
    onBlur?: (e: FocusEvent<HTMLElement>) => void;
    'aria-describedby'?: string;
  };

  const trigger = cloneElement(child, {
    ref: mergeRefs(anchorRef, child.ref),
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      p.onPointerEnter?.(e);
      if (e.pointerType === 'mouse') show(delay);
    },
    onPointerLeave: (e: PointerEvent<HTMLElement>) => {
      p.onPointerLeave?.(e);
      hide();
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      p.onPointerDown?.(e);
      hide();
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      p.onFocus?.(e);
      let keyboard = true;
      try {
        keyboard = e.currentTarget.matches(':focus-visible');
      } catch {
        keyboard = true;
      }
      if (keyboard) show(80);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      p.onBlur?.(e);
      hide();
    },
    'aria-describedby': !labelled && open ? id : p['aria-describedby'],
  });

  return (
    <>
      {trigger}
      {open ? (
        <Portal>
          <div ref={tipRef} id={id} role="tooltip" className="ui-tooltip" data-side={pos.side} style={pos.style}>
            {content}
          </div>
        </Portal>
      ) : null}
    </>
  );
}
