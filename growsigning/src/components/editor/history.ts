'use client';
import { useCallback, useMemo, useRef, useState } from 'react';

type SetOptions = {
  /** Changes with the same tag made shortly after one another count as one step (typing, nudging, one drag). */
  tag?: string;
  /** How long changes with the same tag keep merging, in milliseconds. Use Infinity for a drag. */
  within?: number;
  /** false applies the change without making it a step of its own. */
  record?: boolean;
};

export type History<T> = {
  value: T;
  set: (next: T | ((current: T) => T), options?: SetOptions) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Starts over from a value, forgetting every earlier step. */
  reset: (value: T) => void;
  /** Applies the same change to the current value and to every remembered step. */
  mapAll: (fn: (value: T) => T) => void;
  /** The newest value, also inside event handlers that were created before the last render. */
  current: () => T;
};

const LIMIT = 200;

// A value with undo and redo. The newest value lives in a ref so several changes in one event (or one drag)
// always build on each other, and React state mirrors it for rendering.
export function useHistory<T>(initial: T): History<T> {
  const [value, setValue] = useState<T>(initial);
  const cur = useRef<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const mark = useRef<{ tag: string; at: number } | null>(null);

  const set = useCallback((next: T | ((current: T) => T), options: SetOptions = {}) => {
    const prev = cur.current;
    const val = typeof next === 'function' ? (next as (c: T) => T)(prev) : next;
    if (val === prev) return;
    if (options.record !== false) {
      const now = Date.now();
      const m = mark.current;
      const merge = !!options.tag && !!m && m.tag === options.tag && now - m.at <= (options.within ?? 1200);
      if (!merge) {
        past.current.push(prev);
        if (past.current.length > LIMIT) past.current.shift();
      }
      mark.current = options.tag ? { tag: options.tag, at: now } : null;
      future.current = [];
    }
    cur.current = val;
    setValue(val);
  }, []);

  const undo = useCallback(() => {
    if (!past.current.length) return;
    future.current.push(cur.current);
    cur.current = past.current.pop()!;
    mark.current = null;
    setValue(cur.current);
  }, []);

  const redo = useCallback(() => {
    if (!future.current.length) return;
    past.current.push(cur.current);
    cur.current = future.current.pop()!;
    mark.current = null;
    setValue(cur.current);
  }, []);

  const reset = useCallback((v: T) => {
    past.current = [];
    future.current = [];
    mark.current = null;
    cur.current = v;
    setValue(v);
  }, []);

  const mapAll = useCallback((fn: (value: T) => T) => {
    past.current = past.current.map(fn);
    future.current = future.current.map(fn);
    cur.current = fn(cur.current);
    setValue(cur.current);
  }, []);

  const current = useCallback(() => cur.current, []);

  // Every change above ends in setValue, so reading the stacks during render is always up to date.
  const canUndo = past.current.length > 0;
  const canRedo = future.current.length > 0;
  return useMemo(() => ({ value, set, undo, redo, canUndo, canRedo, reset, mapAll, current }), [value, set, undo, redo, canUndo, canRedo, reset, mapAll, current]);
}
