'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// A dialog that behaves the way assistive technology expects: focus moves in, stays in, Escape closes it,
// and focus goes back to whatever opened it. On a phone it slides up from the bottom, within reach of a thumb.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const stack: string[] = [];
let locks = 0;

const focusables = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement);

export function Dialog({ title, children, onClose, wide, variant, light }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  /** "field" keeps the two action buttons side by side on a phone. */
  variant?: 'field';
  /** A lighter backdrop, for when the document behind should stay readable. */
  light?: boolean;
}) {
  const id = useId();
  const bg = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const root = bg.current!;
    const panel = box.current!;
    const opener = document.activeElement as HTMLElement | null;
    stack.push(id);

    // Everything behind the dialog is switched off, so neither Tab nor a screen reader's cursor can wander into it.
    const hidden: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === root || el.classList.contains('toasts') || el.hasAttribute('inert') || el.tagName === 'SCRIPT') continue;
      el.setAttribute('inert', '');
      hidden.push(el);
    }
    if (locks++ === 0) {
      // Stop the page behind from scrolling, and keep its width so nothing jumps when the scrollbar goes.
      const gap = window.innerWidth - document.documentElement.clientWidth;
      if (gap > 0) document.documentElement.style.paddingRight = `${gap}px`;
      document.documentElement.classList.add('sg-locked');
    }

    if (!panel.contains(document.activeElement)) (panel.querySelector<HTMLElement>('[data-autofocus]') || panel).focus({ preventScroll: true });

    const key = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables(panel);
      if (!list.length) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = list[0], last = list[list.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === panel || !panel.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !panel.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', key);

    // Keep the sheet above the on-screen keyboard instead of underneath it.
    const vv = window.visualViewport;
    const lift = () => {
      if (!vv) return;
      const gap = vv.scale > 1.01 ? 0 : Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--sg-kb', `${Math.round(gap)}px`);
    };
    vv?.addEventListener('resize', lift);
    vv?.addEventListener('scroll', lift);
    lift();

    return () => {
      document.removeEventListener('keydown', key);
      vv?.removeEventListener('resize', lift);
      vv?.removeEventListener('scroll', lift);
      stack.splice(stack.indexOf(id), 1);
      for (const el of hidden) el.removeAttribute('inert');
      if (--locks === 0) {
        document.documentElement.classList.remove('sg-locked');
        document.documentElement.style.paddingRight = '';
      }
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [id]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={bg} className={`modal-bg sg-dialog-bg${light ? ' light' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={`modal sg-dialog${wide ? ' wide' : ''}${variant === 'field' ? ' sg-two' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
        <div className="sg-dialog-head">
          <h2 id={id}>{title}</h2>
          <button type="button" className="sg-x" aria-label="Close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5 5 19" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
