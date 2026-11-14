import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { Portal } from './Portal';
import { cx } from './util';

export type ToastTone = 'success' | 'error' | 'info' | 'warning';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** ms on screen. 0 keeps it until dismissed. Default 4500 (errors 7000). */
  duration?: number;
  /** one inline action, e.g. Undo */
  action?: { label: string; onClick: () => void };
  /** reuse an id to replace a toast instead of stacking a second one */
  id?: string;
}

export interface ToastApi {
  show: (options: ToastOptions) => string;
  success: (title: ReactNode, description?: ReactNode) => string;
  error: (title: ReactNode, description?: ReactNode) => string;
  info: (title: ReactNode, description?: ReactNode) => string;
  warning: (title: ReactNode, description?: ReactNode) => string;
  dismiss: (id: string) => void;
}

interface ToastItem extends ToastOptions {
  id: string;
  tone: ToastTone;
  leaving?: boolean;
}

const noop: ToastApi = {
  show: () => '',
  success: () => '',
  error: () => '',
  info: () => '',
  warning: () => '',
  dismiss: () => undefined,
};

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Brief, non-blocking feedback: `const toast = useToast(); toast.success('Saved')`.
 * <ThemeScope> and <AdminScope> already include the provider.
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx && import.meta.env.DEV) console.warn('useToast() was called outside <ThemeScope> / <AdminScope>. Nothing will be shown.');
  return ctx ?? noop;
}

const ICONS: Record<ToastTone, ReactNode> = {
  success: <CircleCheck size={18} />,
  error: <CircleAlert size={18} />,
  info: <Info size={18} />,
  warning: <TriangleAlert size={18} />,
};

let seq = 0;
const MAX_VISIBLE = 4;
const EXIT_MS = 180;

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const duration = item.duration ?? (item.tone === 'error' ? 7000 : 4500);
  const [paused, setPaused] = useState(false);
  const remaining = useRef(duration);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!duration || paused || item.leaving) return;
    startedAt.current = Date.now();
    const timer = window.setTimeout(() => onDismiss(item.id), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(800, remaining.current - (Date.now() - startedAt.current));
    };
  }, [duration, paused, item.id, item.leaving, onDismiss]);

  return (
    <li
      className={cx('ui-toast', `ui-toast--${item.tone}`)}
      data-state={item.leaving ? 'closed' : 'open'}
      role={item.tone === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="ui-toast__icon" aria-hidden="true">
        {ICONS[item.tone]}
      </span>
      <div className="ui-toast__text">
        <p className="ui-toast__title">{item.title}</p>
        {item.description ? <p className="ui-toast__desc">{item.description}</p> : null}
      </div>
      {item.action ? (
        <button
          type="button"
          className="ui-toast__action"
          onClick={() => {
            item.action?.onClick();
            onDismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      <button type="button" className="ui-toast__close" aria-label="Dismiss" onClick={() => onDismiss(item.id)}>
        <X size={16} aria-hidden="true" />
      </button>
    </li>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((t) => window.clearTimeout(t));
  }, []);

  const dismiss = useCallback((id: string) => {
    setItems((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setItems((list) => list.filter((t) => t.id !== id));
    }, EXIT_MS);
    timers.current.add(timer);
  }, []);

  const show = useCallback((options: ToastOptions) => {
    const id = options.id ?? `t${++seq}`;
    const item: ToastItem = { ...options, id, tone: options.tone ?? 'info' };
    setItems((list) => {
      const without = list.filter((t) => t.id !== id);
      return [...without, item].slice(-MAX_VISIBLE);
    });
    return id;
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      dismiss,
      success: (title, description) => show({ title, description, tone: 'success' }),
      error: (title, description) => show({ title, description, tone: 'error' }),
      info: (title, description) => show({ title, description, tone: 'info' }),
      warning: (title, description) => show({ title, description, tone: 'warning' }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Portal>
        <ol className="ui-toasts" role="list" aria-label="Notifications">
          {items.map((item) => (
            <ToastView key={item.id} item={item} onDismiss={dismiss} />
          ))}
        </ol>
      </Portal>
    </ToastContext.Provider>
  );
}
