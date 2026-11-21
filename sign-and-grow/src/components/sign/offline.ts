// When the signing page cannot reach the server: a phone in a lift, on a train, at the edge of the signal. Nothing
// counts as signed until the server has said so, the answers stay in the page and in the tab's own storage, and
// Finish is sent again by itself when the connection is back. Plain functions with no React, so they can be tested.

/**
 * Whether a failed request may not have reached us: no answer at all (the browser's "Failed to fetch"), or a 502,
 * 503 or 504 that is not ours. Every answer of our own server carries its own sentence (`error` in JSON), also a 503
 * it means, such as a public form with no signature free right now: that sentence is what to show, not "no
 * connection". A page from something in between (a proxy, the host's error page) brings no such sentence.
 */
export const isConnectionError = (e: any): boolean => !e?.status || ((e.status === 502 || e.status === 503 || e.status === 504) && typeof e.data?.error !== 'string');

/** The server says this person's part is already done: a Finish sent again after one that went through. */
export const isAlreadyFinished = (e: any): boolean => e?.status === 409 && (e.code === 'already_finished' || /already finished/i.test(e?.message || ''));

/**
 * After a Finish that brought no clear answer (none at all, or an error from our side that may have come after the
 * signature was recorded), what the server says now: 'done' when this person's part is finished, 'open' when it is
 * not, 'unknown' when the server cannot be asked either. `ask` fetches the signing page's data.
 */
export async function finishLanded(ask: () => Promise<any>): Promise<'done' | 'open' | 'unknown'> {
  try {
    return (await ask())?.recipient?.status === 'completed' ? 'done' : 'open';
  } catch {
    return 'unknown';
  }
}

/**
 * Said in the last step when Finish did not get through and that is known: the device was offline before it was
 * sent, or the server says nothing is signed yet. `online` is what the device says about itself.
 */
export const finishNotSent = (online: boolean, finish = 'Finish'): string => online
  ? `Not sent yet. We could not reach GrowSigning just now, and nothing is signed yet. Your answers are safe on this page. We keep trying by ourselves while this stays open, or choose ${finish} to try now.`
  : `Not sent yet. This device seems to be offline, so nothing was signed. Your answers are safe on this page. We send it by ourselves as soon as the connection is back, or choose ${finish} to try now.`;

/**
 * Said when Finish was sent but no answer came back and the server cannot be asked: it may well have gone through,
 * so nothing is promised either way. Trying again is safe: a second Finish of the same person signs nothing twice.
 */
export const finishUnknown = (online: boolean, finish = 'Finish'): string => online
  ? `We did not hear back from GrowSigning, so we cannot tell yet whether it went through. Nothing you typed is lost. We keep checking by ourselves while this stays open and send it again if it did not arrive, or choose ${finish} to try now.`
  : `This device seems to have lost its connection, so we cannot tell yet whether it went through. Nothing you typed is lost. We check as soon as the connection is back and send it again if it did not arrive, or choose ${finish} to try now.`;

/** Said once when saving stops getting through, not again on every try. */
export const saveNotSent = (online: boolean): string => online
  ? 'Not saved yet. We could not reach GrowSigning just now. Your answers are safe on this page, and we keep trying.'
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
