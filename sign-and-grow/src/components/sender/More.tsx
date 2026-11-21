'use client';
// "More": the one place a screen, or one item on it, keeps what most people do not need today (charter P4).
// The button carries data-more ("screen" or "item"), is closed every time the page opens, says whether it is open
// (aria-expanded) and which element it opened (aria-controls). Escape closes it and puts the keyboard back on the
// button; so does a click anywhere else, and choosing a line.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';

export type MenuLine = {
  key: string; label: string; danger?: boolean; disabled?: boolean; title?: string;
  /** A link: opens in a new tab when `newTab` is set, downloads when `download` is. */
  href?: string; newTab?: boolean; download?: boolean; route?: boolean;
  onPick?: () => void;
};

/** Open and closed, with the ways out a keyboard and a finger expect. `ref` goes on the element around button and panel. */
export function useMoreState() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const away = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', key);
    document.addEventListener('mousedown', away);
    document.addEventListener('touchstart', away);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('mousedown', away);
      document.removeEventListener('touchstart', away);
    };
  }, [open]);
  return { open, setOpen, box, button };
}

/** A menu of lines: the page's More, or the More of one row. Renders nothing when there is no line to show. */
export function MoreMenu({ kind, lines, label, small }: { kind: 'screen' | 'item'; lines: MenuLine[]; label: string; small?: boolean }) {
  const { open, setOpen, box, button } = useMoreState();
  const id = useId();
  if (!lines.length) return null;
  const pick = (l: MenuLine) => {
    setOpen(false);
    l.onPick?.();
  };
  return (
    <div className={`mo${open ? ' open' : ''}`} ref={box}>
      <button ref={button} type="button" className={`btn${small ? ' sm' : ''} mo-btn`} data-more={kind} aria-expanded={open} aria-controls={open ? id : undefined} aria-label={label} onClick={() => setOpen(!open)}>More</button>
      {open && (
        <div className="mo-menu" id={id} role="group" aria-label={label}>
          {lines.map((l) => l.href && !l.disabled
            ? l.route
              ? <Link key={l.key} href={l.href} className={`mo-line${l.danger ? ' danger' : ''}`} onClick={() => setOpen(false)}>{l.label}</Link>
              : <a key={l.key} href={l.href} className={`mo-line${l.danger ? ' danger' : ''}`} onClick={() => setOpen(false)} {...(l.newTab ? { target: '_blank', rel: 'noreferrer' } : {})}>{l.label}</a>
            : <button key={l.key} type="button" className={`mo-line${l.danger ? ' danger' : ''}`} disabled={l.disabled} title={l.title} onClick={() => pick(l)}>{l.label}</button>)}
        </div>
      )}
    </div>
  );
}

/**
 * The More of one item whose inside is not a plain menu (a person on the document page: what happened to their
 * email, and the few things to do about it). The panel opens in place, under the item's line.
 */
export function MorePanel({ label, panelId, open, onToggle, buttonRef }: { label: string; panelId: string; open: boolean; onToggle: () => void; buttonRef?: (el: HTMLButtonElement | null) => void }) {
  return <button ref={buttonRef} type="button" className="btn sm mo-btn" data-more="item" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={label} onClick={onToggle}>More</button>;
}

/** A folded section of the page: closed every time the page opens (data-fold). `count` is said in the summary. */
export function Fold({ title, count, id, children, note }: { title: string; count?: number | null; id?: string; children: ReactNode; note?: ReactNode }) {
  return (
    <details className="card sn-fold" data-fold="" id={id}>
      <summary><span>{title}{typeof count === 'number' ? ` (${count})` : ''}</span>{note}</summary>
      <div className="sn-fold-in">{children}</div>
    </details>
  );
}
