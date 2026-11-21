'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { Modal } from '@/components/ui';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The shared Modal closes on Escape and on a click outside. This adds what a keyboard user also needs:
// focus moves into the dialog, Tab stays inside it, and focus goes back to where it was when the dialog closes.
export function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const box = inner.current?.closest('.modal') as HTMLElement | null;
    if (!box) return;
    if (!box.contains(document.activeElement)) {
      const first = box.querySelector<HTMLElement>('[data-autofocus]') || box.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
    box.addEventListener('keydown', trap);
    return () => {
      box.removeEventListener('keydown', trap);
      if (before && document.contains(before)) before.focus();
    };
  }, []);
  return (
    <Modal title={title} onClose={onClose} wide={wide}>
      <div ref={inner} className="sn-dialog">{children}</div>
    </Modal>
  );
}
