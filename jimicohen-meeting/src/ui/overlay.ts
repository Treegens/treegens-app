import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { focusableWithin, prefersReducedMotion, useIsoLayoutEffect, useLatest } from './util';

// ───────────── presence (keeps a closing overlay mounted for its exit animation) ─────────────

export interface Presence {
  mounted: boolean;
  /** put on the element as data-state so CSS can animate in and out */
  state: 'open' | 'closed';
}

export function usePresence(open: boolean, exitMs = 170): Presence {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const ms = prefersReducedMotion() ? 0 : exitMs;
    const timer = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(timer);
  }, [open, exitMs]);
  return { mounted: open || mounted, state: open ? 'open' : 'closed' };
}

// ───────────── scroll lock ─────────────

let lockCount = 0;
let restoreScroll: (() => void) | null = null;

export function useScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    lockCount += 1;
    if (lockCount === 1) {
      const root = document.documentElement;
      const prevOverflow = root.style.overflow;
      const prevPadding = root.style.paddingRight;
      const gap = window.innerWidth - root.clientWidth;
      root.style.overflow = 'hidden';
      if (gap > 0) root.style.paddingRight = `${gap}px`;
      restoreScroll = () => {
        root.style.overflow = prevOverflow;
        root.style.paddingRight = prevPadding;
      };
    }
    return () => {
      lockCount -= 1;
      if (lockCount === 0 && restoreScroll) {
        restoreScroll();
        restoreScroll = null;
      }
    };
  }, [active]);
}

// ───────────── layer stack (only the top overlay reacts to Escape / Tab) ─────────────

const layerStack: symbol[] = [];

function useLayer(active: boolean): () => boolean {
  const id = useRef<symbol>();
  if (!id.current) id.current = Symbol('layer');
  useEffect(() => {
    if (!active) return;
    const me = id.current!;
    layerStack.push(me);
    return () => {
      const i = layerStack.lastIndexOf(me);
      if (i >= 0) layerStack.splice(i, 1);
    };
  }, [active]);
  return () => layerStack[layerStack.length - 1] === id.current;
}

export interface DialogBehaviorOptions {
  open: boolean;
  onClose: () => void;
  panelRef: RefObject<HTMLElement>;
  /** element to focus on open; defaults to [data-autofocus], then the panel itself */
  initialFocusRef?: RefObject<HTMLElement>;
  closeOnEscape?: boolean;
}

/**
 * Modal dialog behaviour: scroll lock, focus moves in, Tab stays inside, Escape closes,
 * and focus returns to whatever had it before.
 */
export function useDialogBehavior({ open, onClose, panelRef, initialFocusRef, closeOnEscape = true }: DialogBehaviorOptions): void {
  const onCloseRef = useLatest(onClose);
  const isTop = useLayer(open);
  useScrollLock(open);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      if (panel.contains(document.activeElement) && document.activeElement !== panel) return;
      const target = initialFocusRef?.current ?? panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel;
      target.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(raf);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape' && closeOnEscape) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = focusableWithin(panel);
      if (!items.length) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closeOnEscape]);
}

/** Calls `onDismiss` on Escape or on a pointer press outside every given element. For menus and popovers. */
export function useDismiss(open: boolean, refs: RefObject<HTMLElement | null>[], onDismiss: (reason: 'escape' | 'outside') => void): void {
  const cb = useLatest(onDismiss);
  const isTop = useLayer(open);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (refs.some((r) => r.current && r.current.contains(target))) return;
      cb.current('outside');
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTop()) {
        e.stopPropagation();
        cb.current('escape');
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

// ───────────── anchored positioning ─────────────

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';

export interface AnchorOptions {
  side?: Side;
  align?: Align;
  /** gap between anchor and floating element, px */
  offset?: number;
  /** minimum distance to the viewport edge, px */
  padding?: number;
  /** make the floating element at least as wide as the anchor */
  matchWidth?: boolean;
}

export interface AnchoredPosition {
  style: CSSProperties;
  side: Side;
  ready: boolean;
}

interface Size {
  width: number;
  height: number;
}

export function computeAnchoredPosition(
  anchor: DOMRect,
  pop: Size,
  viewport: Size,
  { side = 'bottom', align = 'center', offset = 8, padding = 8 }: AnchorOptions,
): { top: number; left: number; side: Side } {
  const room: Record<Side, number> = {
    top: anchor.top,
    bottom: viewport.height - anchor.bottom,
    left: anchor.left,
    right: viewport.width - anchor.right,
  };
  const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
  const need = side === 'top' || side === 'bottom' ? pop.height + offset + padding : pop.width + offset + padding;
  let s = side;
  if (room[s] < need && room[opposite[s]] > room[s]) s = opposite[s];

  // Along the cross axis: honour the requested alignment, but flip start <-> end when that
  // would push the element off screen and the other alignment fits.
  const cross = (start: number, end: number, size: number, limit: number): number => {
    const fromStart = start;
    const fromEnd = end - size;
    const fits = (v: number) => v >= padding && v + size <= limit - padding;
    if (align === 'start') return fits(fromStart) || !fits(fromEnd) ? fromStart : fromEnd;
    if (align === 'end') return fits(fromEnd) || !fits(fromStart) ? fromEnd : fromStart;
    return start + (end - start) / 2 - size / 2;
  };

  let top = 0;
  let left = 0;
  if (s === 'top' || s === 'bottom') {
    top = s === 'top' ? anchor.top - pop.height - offset : anchor.bottom + offset;
    left = cross(anchor.left, anchor.right, pop.width, viewport.width);
  } else {
    left = s === 'left' ? anchor.left - pop.width - offset : anchor.right + offset;
    top = cross(anchor.top, anchor.bottom, pop.height, viewport.height);
  }
  left = Math.max(padding, Math.min(left, viewport.width - pop.width - padding));
  top = Math.max(padding, Math.min(top, viewport.height - pop.height - padding));
  return { top: Math.round(top), left: Math.round(left), side: s };
}

/** Keeps a fixed-position floating element attached to its anchor while it is open. */
export function useAnchoredPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  popRef: RefObject<HTMLElement | null>,
  options: AnchorOptions = {},
): AnchoredPosition {
  const { side = 'bottom', align = 'center', offset = 8, padding = 8, matchWidth = false } = options;
  const [pos, setPos] = useState<{ top: number; left: number; side: Side; minWidth?: number } | null>(null);

  useIsoLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    let frame = 0;
    const update = () => {
      const anchor = anchorRef.current;
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const rect = anchor.getBoundingClientRect();
      const minWidth = matchWidth ? rect.width : undefined;
      const size = { width: Math.max(pop.offsetWidth, minWidth ?? 0), height: pop.offsetHeight };
      const next = computeAnchoredPosition(rect, size, { width: window.innerWidth, height: window.innerHeight }, { side, align, offset, padding });
      setPos((prev) =>
        prev && prev.top === next.top && prev.left === next.left && prev.side === next.side && prev.minWidth === minWidth ? prev : { ...next, minWidth },
      );
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };
    update();
    schedule();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro && popRef.current) ro.observe(popRef.current);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
    };
  }, [open, side, align, offset, padding, matchWidth]);

  return {
    style: {
      position: 'fixed',
      top: pos?.top ?? 0,
      left: pos?.left ?? 0,
      minWidth: pos?.minWidth,
      visibility: pos ? 'visible' : 'hidden',
    },
    side: pos?.side ?? side,
    ready: pos !== null,
  };
}
