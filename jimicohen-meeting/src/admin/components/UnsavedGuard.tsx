/**
 * Unsaved-changes guard for the dashboard.
 *
 *   const guard = useUnsavedGuard(dirty);   // inside a page with a draft
 *   guard.allowNext();                      // right before a navigation that follows a save
 *
 * While any page reports `dirty`, leaving it asks first. That covers links and navigate()
 * calls, the browser's back and forward buttons, and closing or reloading the tab.
 * A change of query string or hash on the same path (tabs, filters) never asks.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { UNSAFE_NavigationContext, useLocation } from 'react-router-dom';
import type { To } from 'react-router-dom';
import { setPopStateInterceptor } from '../../lib/historyGuard';
import { ConfirmDialog } from '../../ui';

interface GuardApi {
  setDirty: (key: string, dirty: boolean) => void;
  /** let the next in-app navigation through without asking */
  allowNext: () => void;
  /** run `proceed` now when nothing is unsaved, otherwise ask first */
  confirmLeave: (proceed: () => void) => void;
}

const GuardContext = createContext<GuardApi | null>(null);

function pathOf(to: To): string | null {
  const raw = typeof to === 'string' ? to : to.pathname ?? null;
  if (raw === null || raw === '') return null;
  try {
    return new URL(raw, window.location.href).pathname;
  } catch {
    return null;
  }
}

const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

export function UnsavedGuardProvider({ children }: { children: ReactNode }) {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const location = useLocation();
  const keys = useRef(new Set<string>());
  const [dirty, setDirtyState] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const allowOnce = useRef(false);
  const historyIdx = useRef<number | null>(null);
  const popSkip = useRef<'swallow' | 'allow' | null>(null);

  // React Router keeps a running index in history.state; remember where we are.
  useEffect(() => {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    historyIdx.current = typeof idx === 'number' ? idx : null;
  }, [location]);

  const setDirty = useCallback((key: string, value: boolean) => {
    if (value) keys.current.add(key);
    else keys.current.delete(key);
    setDirtyState(keys.current.size > 0);
  }, []);

  const allowNext = useCallback(() => {
    allowOnce.current = true;
    // Only meant for the navigation that immediately follows.
    window.setTimeout(() => {
      allowOnce.current = false;
    }, 0);
  }, []);

  const confirmLeave = useCallback((proceed: () => void) => {
    if (keys.current.size === 0) proceed();
    else setPending(() => proceed);
  }, []);

  // Closing or reloading the tab.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Links and navigate() calls.
  useEffect(() => {
    if (!dirty) return;
    const nav = navigator;
    const original = { push: nav.push, replace: nav.replace };
    const wrap =
      (fn: typeof nav.push): typeof nav.push =>
      (to, state, opts) => {
        const target = pathOf(to);
        const samePage = target === null || trim(target) === trim(window.location.pathname);
        if (samePage || keys.current.size === 0) {
          fn.call(nav, to, state, opts);
          return;
        }
        if (allowOnce.current) {
          allowOnce.current = false;
          fn.call(nav, to, state, opts);
          return;
        }
        setPending(() => () => fn.call(nav, to, state, opts));
      };
    nav.push = wrap(original.push);
    nav.replace = wrap(original.replace);
    return () => {
      nav.push = original.push;
      nav.replace = original.replace;
    };
  }, [dirty, navigator]);

  // Back and forward buttons. The interceptor from lib/historyGuard runs before the router's
  // own listener, so the router never sees a navigation the person has not confirmed yet.
  // (A listener added here would run after the router's: the page, and the draft on it, could
  // be gone before the question is even asked.)
  useEffect(() => {
    if (!dirty) return;
    const onPopState = (e: PopStateEvent) => {
      if (popSkip.current === 'allow') {
        popSkip.current = null;
        return;
      }
      if (popSkip.current === 'swallow') {
        popSkip.current = null;
        e.stopImmediatePropagation();
        return;
      }
      const from = historyIdx.current;
      const to = (e.state as { idx?: unknown } | null)?.idx;
      if (keys.current.size === 0 || from === null || typeof to !== 'number' || to === from) return;
      const delta = to - from;
      e.stopImmediatePropagation();
      popSkip.current = 'swallow';
      window.history.go(-delta);
      setPending(() => () => {
        popSkip.current = 'allow';
        window.history.go(delta);
      });
    };
    popSkip.current = null;
    const release = setPopStateInterceptor(onPopState);
    return () => {
      release();
      popSkip.current = null;
    };
  }, [dirty]);

  const api = useMemo<GuardApi>(() => ({ setDirty, allowNext, confirmLeave }), [setDirty, allowNext, confirmLeave]);

  return (
    <GuardContext.Provider value={api}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          const go = pending;
          keys.current.clear();
          setDirtyState(false);
          setPending(null);
          go?.();
        }}
        title="Leave without saving?"
        description="You have changes on this page that are not saved yet. If you leave now they will be lost."
        confirmLabel="Leave page"
        cancelLabel="Keep editing"
        tone="danger"
      />
    </GuardContext.Provider>
  );
}

export interface UnsavedGuardHandle {
  allowNext: () => void;
  confirmLeave: (proceed: () => void) => void;
}

const NOOP: UnsavedGuardHandle = { allowNext: () => undefined, confirmLeave: (proceed) => proceed() };

/** Report whether this page has unsaved changes. Safe to call outside the provider (it does nothing there). */
export function useUnsavedGuard(dirty: boolean): UnsavedGuardHandle {
  const api = useContext(GuardContext);
  const key = useId();
  useEffect(() => {
    if (!api) return;
    api.setDirty(key, dirty);
    return () => api.setDirty(key, false);
  }, [api, key, dirty]);
  return api ?? NOOP;
}
