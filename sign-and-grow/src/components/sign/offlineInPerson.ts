// Signing in person where there is no signal, on the host's device (src/server/offlinesign.ts says what the server
// does). This file is what the device keeps and how: plain functions with no React, so tests run them with a pretend
// store and the WebCrypto of Node.
//
// - One copy per device, in its own IndexedDB database. Everything about the person and the document in it is
//   encrypted with AES-GCM under a key made from the host's PIN with PBKDF2 (SHA-256, PIN_ROUNDS rounds). Only the
//   dates it was got ready and ends, and the count of wrong PINs, are kept in the clear, so the device can wipe it
//   without the PIN.
// - PIN_TRIES wrong PINs in a row wipe it. So does OFFLINE_DAYS days, sending it, and the host removing it.
// - The result (what the person filled in, their signature, when the device's clock said they finished) is kept
//   encrypted the same way until it is sent. Nothing counts as signed until the server has said so.
import { OFFLINE_DAYS, PIN_MIN, PIN_ROUNDS, PIN_TRIES, OFFLINE_WORDS } from '../../lib/offlinesign.ts';

/** Where the copy lives: an IndexedDB database in the browser (idbBox), or anything that keeps values by name. */
export type Box = { get(k: string): Promise<any>; put(k: string, v: any): Promise<void>; clear(): Promise<void> };
export type Sealed = { iv: string; data: string };
export type Kept = { v: 1; prep_id: string; created_at: string; expires_at: string; salt: string; rounds: number; check: Sealed; pack: Sealed; result?: Sealed; saved_at?: string; tries: number };
/** What the server gave when it was got ready (POST /envelopes/:id/offline). */
export type Pack = { prep_id: string; created_at: string; expires_at: string; token: string; host: string; view: any; files: { id: string; name: string; pages: number; sha256: string; pdf: string }[] };
/** What the person did on the device. `device_at` is the device's own clock, which nobody checks. */
export type Result = { values: Record<string, string>; signature_png: string | null; initials_png: string | null; consent: Record<string, any>; device_at: string };

export const DB_NAME = 'growsigning-in-person';
const KEY = 'copy';
const DAY = 864e5;

const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
const subtle = () => globalThis.crypto.subtle;

/** Why this PIN cannot be used, or '' when it can. Said as what to do. */
export function pinProblem(pin: string, again?: string): string {
  if ((pin || '').length < PIN_MIN) return `Choose a PIN of at least ${PIN_MIN} numbers or letters.`;
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'That PIN is easy to guess. Choose one that is not the same number again and again or a run of numbers.';
  if (again !== undefined && again !== pin) return 'The two PINs are not the same. Type the same PIN twice.';
  return '';
}

/** The key made from the PIN. Slow on purpose: every guess at the PIN costs this much work. */
export async function keyFrom(pin: string, salt: Uint8Array, rounds = PIN_ROUNDS): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: rounds, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function seal(key: CryptoKey, value: any): Promise<Sealed> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))));
  return { iv: b64(iv), data: b64(data) };
}
export async function unseal(key: CryptoKey, s: Sealed): Promise<any> {
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(s.iv) as BufferSource }, key, unb64(s.data) as BufferSource);
  return JSON.parse(new TextDecoder().decode(plain));
}

/** What the device holds, without the PIN: nothing, a copy ready to sign, or a result waiting to be sent. Wipes an old one. */
export async function peek(box: Box, at = Date.now()): Promise<{ state: 'none' } | { state: 'ready' | 'saved'; expires_at: string; created_at: string; saved_at?: string; tries_left: number }> {
  let k: Kept | null = null;
  try {
    k = await box.get(KEY);
  } catch {
    return { state: 'none' };
  }
  if (!k || k.v !== 1) return { state: 'none' };
  if (tooOld(k, at)) {
    await box.clear();
    return { state: 'none' };
  }
  return { state: k.result ? 'saved' : 'ready', expires_at: k.expires_at, created_at: k.created_at, saved_at: k.saved_at, tries_left: PIN_TRIES - (k.tries || 0) };
}
/** At most OFFLINE_DAYS days, counted from when it was got ready, by the server's date and by the device's own. */
export const tooOld = (k: { expires_at: string; created_at: string }, at = Date.now()) => at > Date.parse(k.expires_at) || at - Date.parse(k.created_at) > OFFLINE_DAYS * DAY;

/**
 * Keeps a copy on the device under a PIN. One envelope per device: a copy already here is replaced, unless it holds a
 * result that has not been sent, which is never thrown away by this.
 */
export async function keep(box: Box, pin: string, pack: Pack, rounds = PIN_ROUNDS): Promise<CryptoKey> {
  const problem = pinProblem(pin);
  if (problem) throw new Error(problem);
  const had: Kept | null = await box.get(KEY).catch(() => null);
  if (had?.result && !tooOld(had)) throw new Error('This device still holds a signature that has not been sent. Send it first: open it with signal and type its PIN.');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await keyFrom(pin, salt, rounds);
  const kept: Kept = { v: 1, prep_id: pack.prep_id, created_at: pack.created_at, expires_at: pack.expires_at, salt: b64(salt), rounds, check: await seal(key, 'growsigning'), pack: await seal(key, pack), tries: 0 };
  await box.put(KEY, kept);
  return key;
}

export class PinError extends Error {
  code: 'wrong_pin' | 'wiped' | 'none';
  left: number;
  constructor(code: 'wrong_pin' | 'wiped' | 'none', message: string, left = 0) {
    super(message);
    this.code = code;
    this.left = left;
  }
}

/** Opens the copy with the PIN. A wrong PIN is counted before the key is tried; the last one wipes the copy. */
export async function unlock(box: Box, pin: string, at = Date.now()): Promise<{ key: CryptoKey; pack: Pack; result: Result | null }> {
  const k: Kept | null = await box.get(KEY).catch(() => null);
  if (!k || tooOld(k, at)) {
    if (k) await box.clear();
    throw new PinError('none', `Nothing is ready on this device any more. A copy is kept for ${OFFLINE_DAYS} days at most. Get it ready again with signal.`);
  }
  const tries = (k.tries || 0) + 1;
  await box.put(KEY, { ...k, tries });
  const key = await keyFrom(pin || '', unb64(k.salt), k.rounds);
  try {
    if ((await unseal(key, k.check)) !== 'growsigning') throw new Error('no');
  } catch {
    if (tries >= PIN_TRIES) {
      await box.clear();
      throw new PinError('wiped', `That was ${PIN_TRIES} wrong PINs, so the copy on this device was wiped. Nothing was signed. Get it ready again with signal.`);
    }
    const left = PIN_TRIES - tries;
    throw new PinError('wrong_pin', `That PIN is not right. ${left === 1 ? 'One more try' : `${left} more tries`}, then the copy on this device is wiped.`, left);
  }
  await box.put(KEY, { ...k, tries: 0 });
  return { key, pack: await unseal(key, k.pack), result: k.result ? await unseal(key, k.result) : null };
}

/** Keeps what the person did, encrypted, with the device's clock. Nothing is signed by this. */
export async function saveResult(box: Box, key: CryptoKey, result: Result): Promise<void> {
  const k: Kept | null = await box.get(KEY);
  if (!k) throw new Error('The copy on this device is gone, so this could not be saved. Get it ready again with signal.');
  await box.put(KEY, { ...k, result: await seal(key, result), saved_at: result.device_at });
}

/** Removes everything this device keeps for signing in person. */
export const wipe = (box: Box) => box.clear();

export type Sent = { state: 'sent' | 'waiting' | 'refused'; text: string; kept?: boolean };
/**
 * Sends the result by the signing link. `post` is fetch-like: it resolves with the answer, or rejects when there is
 * no connection. Sent or refused, the copy is wiped (a refused one can never be accepted later); with no answer, it
 * stays and waits.
 */
export async function sendResult(box: Box, pack: Pack, result: Result, post: (url: string, body: any) => Promise<{ status: number; data: any }>): Promise<Sent> {
  const name = pack.view?.recipient?.name || 'this person';
  let res: { status: number; data: any };
  try {
    res = await post(`/api/sign/${encodeURIComponent(pack.token)}/offline-finish`, { prep_id: pack.prep_id, device_at: result.device_at, values: result.values, signature_png: result.signature_png, initials_png: result.initials_png, consent: result.consent });
  } catch {
    return { state: 'waiting', text: OFFLINE_WORDS.saved };
  }
  if (res.status === 200 || (res.status === 409 && res.data?.code === 'already_finished')) {
    await wipe(box);
    return { state: 'sent', text: OFFLINE_WORDS.sent(name) };
  }
  // An answer that is not ours (a captive Wi-Fi page, a proxy) is no answer: try again later.
  if (typeof res.data?.error !== 'string' || res.status >= 500 || res.status === 429) return { state: 'waiting', text: OFFLINE_WORDS.saved };
  // A copy the server will never take (changed, ended, too old, unknown, closed) is wiped. Anything else (a field
  // the server finds empty, say) keeps it, so the person can look again with the host: nothing is lost.
  const final = String(res.data?.code || '').startsWith('offline_') || [403, 404, 410].includes(res.status);
  if (final) await wipe(box);
  return { state: 'refused', text: res.data.error, kept: !final };
}

/** The browser's IndexedDB as a Box: one database for this, so wiping it deletes the database itself. */
export function idbBox(): Box {
  const open = () => new Promise<IDBDatabase>((ok, no) => {
    const q = indexedDB.open(DB_NAME, 1);
    q.onupgradeneeded = () => q.result.createObjectStore('kept');
    q.onsuccess = () => ok(q.result);
    q.onerror = () => no(q.error);
  });
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((ok, no) => {
        const q = f(db.transaction('kept', mode).objectStore('kept'));
        q.onsuccess = () => ok(q.result);
        q.onerror = () => no(q.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    put: async (k, v) => void (await run('readwrite', (s) => s.put(v, k))),
    clear: () => new Promise<void>((ok) => {
      const q = indexedDB.deleteDatabase(DB_NAME);
      q.onsuccess = q.onerror = q.onblocked = () => ok();
    }),
  };
}

/** Whether this browser can keep a copy at all. Without it, the action is simply not offered. */
export const canKeep = (): boolean => {
  try {
    return typeof indexedDB !== 'undefined' && !!globalThis.crypto?.subtle && typeof window !== 'undefined' && window.isSecureContext !== false;
  } catch {
    return false;
  }
};

/** Set while the device is handed over without signal: the app locks the account on the server first thing (AppShell). */
export const HANDED_KEY = 'sg:in-person-handed';

/**
 * Called by the app before it shows anything: when the device was handed over without signal, the account is locked
 * on the server first (POST /offline/:prep/hand-over), so the person holding it meets the lock screen, not the account.
 */
export async function lockIfHanded(): Promise<void> {
  let prep: string | null = null;
  try {
    prep = localStorage.getItem(HANDED_KEY);
  } catch {
    return;
  }
  if (!prep) return;
  try {
    const res = await fetch(`/api/offline/${encodeURIComponent(prep)}/hand-over`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
    // Locked now, or nothing left to lock (signed out, the copy gone): either way the flag has done its work.
    if (res.status !== 0 && res.status < 500) localStorage.removeItem(HANDED_KEY);
  } catch {
    /* no signal: the app cannot load anything of the account either */
  }
}
