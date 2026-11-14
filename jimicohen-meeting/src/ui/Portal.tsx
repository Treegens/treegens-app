import { createContext, useContext, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './util';

/**
 * Where overlays (modals, drawers, menus, tooltips, toasts) are rendered.
 *
 * undefined = no scope above us, fall back to document.body.
 * null      = a scope exists but its host element is not mounted yet.
 *
 * Overlays cannot simply portal to <body>: they would lose the scope's CSS variables.
 * <ThemeScope> and <AdminScope> therefore mount a body-level host that carries the same
 * class, variables and data attributes as the scope, and provide it here.
 */
export const PortalContext = createContext<HTMLElement | null | undefined>(undefined);

export function usePortalHost(): HTMLElement | null {
  const host = useContext(PortalContext);
  if (host !== undefined) return host;
  return typeof document === 'undefined' ? null : document.body;
}

export function Portal({ children }: { children: ReactNode }) {
  const host = usePortalHost();
  return host ? createPortal(children, host) : null;
}

export interface PortalHostProps {
  /** scope class for the host, e.g. "m-scope" or "a-scope" */
  className?: string;
  style?: CSSProperties;
  /** data attributes mirrored from the scope element */
  attrs?: Record<string, string>;
  children: ReactNode;
}

/** Mounts the body-level overlay host for a scope and provides it to everything below. */
export function PortalHost({ className, style, attrs, children }: PortalHostProps) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  return (
    <PortalContext.Provider value={host}>
      {children}
      {typeof document !== 'undefined'
        ? createPortal(<div ref={setHost} className={cx('ui-portal-root', className)} style={style} {...attrs} />, document.body)
        : null}
    </PortalContext.Provider>
  );
}
