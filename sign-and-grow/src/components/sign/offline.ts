// When the signing page cannot reach the server: a phone in a lift, on a train, at the edge of the signal. Nothing
// counts as signed until the server has said so, the answers stay in the page and in the tab's own storage, and
// Finish is sent again by itself when the connection is back. Plain functions with no React, so they can be tested.

/**
 * Whether a failed request never reached us: no answer at all (the browser's "Failed to fetch"), or an answer from
 * something in between that could not reach the server. Any other answer came from the server and means what it says.
 */
export const isConnectionError = (e: any): boolean => !e?.status || e.status === 502 || e.status === 503 || e.status === 504;

/** Said in the last step when Finish did not get through. `online` is what the device says about itself. */
export const finishNotSent = (online: boolean, finish = 'Finish and send'): string => online
  ? `Not sent yet. We could not reach Sign&Grow just now, so nothing was signed. Your answers are safe on this page. We keep trying by ourselves while this stays open, or choose ${finish} to try now.`
  : `Not sent yet. This device seems to be offline, so nothing was signed. Your answers are safe on this page. We send it by ourselves as soon as the connection is back, or choose ${finish} to try now.`;

/** Said once when saving stops getting through, not again on every try. */
export const saveNotSent = (online: boolean): string => online
  ? 'Not saved yet. We could not reach Sign&Grow just now. Your answers are safe on this page, and we keep trying.'
  : 'Not saved yet. This device seems to be offline. Your answers are safe on this page, and we save them as soon as the connection is back.';

/** How often Finish is tried again while the device says it is online but the server did not answer. */
export const FINISH_RETRY_MS = 15_000;

// ---- Answers not saved yet, kept in the tab ----
// A reload while the connection is bad would otherwise lose what was typed since the last save. They are kept under
// the name on the request (`who`): when the sender has put another person on it, nothing is given back. Cleared once
// the server has them, and when the page is done with them (finished, declined, passed on).
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
const key = (token: string) => `sg:answers:${token}`;

export function keepAnswers(token: string, who: string | null | undefined, values: Record<string, string>, store?: Store) {
  try {
    (store || sessionStorage).setItem(key(token), JSON.stringify({ who: who ?? null, values }));
  } catch {
    /* Private mode or a full store: the answers stay in the page only. */
  }
}

/** The kept answers for fields that still exist (`ids`), or null when there are none for this person. */
export function readAnswers(token: string, who: string | null | undefined, ids: Iterable<string>, store?: Store): Record<string, string> | null {
  try {
    const k = JSON.parse((store || sessionStorage).getItem(key(token)) || 'null');
    if (!k || typeof k.values !== 'object' || k.who !== (who ?? null)) return null;
    const out: Record<string, string> = {};
    for (const id of ids) if (typeof k.values[id] === 'string') out[id] = k.values[id];
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

export function dropAnswers(token: string, store?: Store) {
  try {
    (store || sessionStorage).removeItem(key(token));
  } catch {
    /* nothing kept, nothing to clear */
  }
}
