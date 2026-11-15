/**
 * Embed mode (`?embed=1`): the page runs inside an iframe on someone else's site.
 * Page chrome is hidden, the themed backdrop is off, and the frame reports its content height
 * to the parent so the host page can size the iframe without scrollbars.
 *
 * Messages posted to the parent window (all carry `source: 'meeting'`):
 *   { type: 'meeting:height', height }                       whenever the content height changes
 *   { type: 'meeting:booked', bookingId, start, end, redirectUrl? }   after a booking is made
 *   { type: 'meeting:rescheduled' | 'meeting:cancelled', bookingId }
 *   { type: 'meeting:escape' }                               Escape was pressed in here and nothing in here used it
 */
import { useEffect } from 'react';
import type { RefObject } from 'react';

export function isEmbedSearch(search: string): boolean {
  const v = new URLSearchParams(search).get('embed');
  return v === '1' || v === 'true';
}

function inFrame(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

export function postToParent(message: Record<string, unknown>): void {
  if (typeof window === 'undefined' || !inFrame()) return;
  try {
    // The parent is an arbitrary site, and the message carries nothing secret.
    window.parent.postMessage({ source: 'meeting', ...message }, '*');
  } catch {
    // ignore
  }
}

/**
 * A key pressed inside the frame never reaches the page around it. A popup that "closes with
 * Escape" would stop doing so the moment the visitor clicks into the calendar, so the key is
 * passed on as a message. Not when something in here used it: the time zone dialog and menus
 * stop the event before it gets this far.
 */
export function useEmbedEscape(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key !== 'Escape' && e.key !== 'Esc') || e.defaultPrevented || e.isComposing) return;
      postToParent({ type: 'meeting:escape' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

/** Reports the height of `ref` to the parent window while `enabled`. */
export function useEmbedAutoHeight(enabled: boolean, ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let last = -1;
    let frame = 0;
    const report = () => {
      frame = 0;
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      postToParent({ type: 'meeting:height', height });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(report);
    };
    report();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(el);
    window.addEventListener('load', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener('load', schedule);
    };
  }, [enabled, ref]);
}

/** Keeps `embed=1` on in-app links so navigation inside the iframe stays chrome-free. */
export function withEmbed(path: string, embed: boolean): string {
  if (!embed) return path;
  return `${path}${path.includes('?') ? '&' : '?'}embed=1`;
}
