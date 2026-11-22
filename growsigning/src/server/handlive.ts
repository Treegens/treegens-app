// Who holds the device now, when people sign in person one after the other on it. The host clicks "Host signing
// now" for Pat, Pat asks something privately, then the host hands the same laptop to Quinn. Without more, Quinn is one
// press of Back away from Pat's signing page, and from Pat's private questions and the host's answers to them.
//
// So a browser remembers, in a cookie of its own (ts_hand), the in-person signers it was handed to, the latest last.
// An in-person signer's private threads are shown, and can be written in, only while they are that latest one. In
// the host's own browser, signed in to their account, only a real hand-over changes the list: "Host signing now"
// locks the account (handover.ts) and starts the list again with that one person, and typing the password to unlock
// clears it. Going Back to an earlier page in a locked browser changes nothing. In a browser that is not the host's
// (a tablet with the link from the host's email, the signer's own phone after scanning the code) a person whose page
// opens there for the first time while they still have to sign becomes the latest; going Back to someone who was
// already handed this browser never makes them the latest again.
//
// What this covers is the comments of the in-person signing pages in that browser. It does not stop the next person
// from going Back to an earlier person's unfinished signing page: the host is asked to stay with the device.
import { type Ctx } from './router.ts';
import { get } from './db.ts';
import { hmac, now, safeEqual, sha256 } from './util.ts';
import { cookie, readCookie, sessionEnd, SESSION_COOKIE } from './auth.ts';

export const HAND_COOKIE = 'ts_hand';
// Enough for a front desk's day. The oldest are forgotten first; they are never the latest anyway.
const MOST = 20;
const keyOf = (r: any) => `${r.id}.${Number(r.person_gen) || 0}`;
const sign = (list: string[]) => hmac(`hand:${list.join('!')}`);

// The people this browser was handed to, oldest first, or null when it has no list (or one we did not write).
function handList(req: Request): string[] | null {
  const raw = readCookie(req, HAND_COOKIE) || '';
  const i = raw.lastIndexOf('*');
  if (i < 1) return null;
  const list = raw.slice(0, i).split('!').filter(Boolean);
  return list.length && safeEqual(raw.slice(i + 1), sign(list)) ? list : null;
}
function setList(c: Ctx, list: string[]) {
  const l = list.slice(-MOST);
  // A day is longer than any sitting at a desk, and the list means nothing once everyone has signed.
  c.cookies.push(cookie(HAND_COOKIE, `${l.join('!')}*${sign(l)}`, 86_400, c.secure));
}
export const clearHand = (c: Ctx) => c.cookies.push(cookie(HAND_COOKIE, '', 0, c.secure));

// A browser whose session was handed over (locked) by its owner: the host's device while someone else holds it.
function lockedHere(req: Request): boolean {
  const t = readCookie(req, SESSION_COOKIE);
  const s = t ? get('SELECT * FROM sessions WHERE id=? AND expires_at > ? AND locked_at IS NOT NULL', sha256(t), now()) : null;
  return !!s && sessionEnd(s) > Date.now();
}

// Called when an in-person signer's page opens (GET /sign/:token). `handedNow`: the host's browser was locked for
// this person just now, which is a hand-over the host made on purpose.
export function noteHand(c: Ctx, e: any, r: any, handedNow: boolean): void {
  if (r?.role !== 'inperson') return;
  if (handedNow) return setList(c, [keyOf(r)]);
  if (r.status === 'completed' || e?.status !== 'sent' || lockedHere(c.req)) return;
  const list = handList(c.req) || [];
  if (!list.includes(keyOf(r))) setList(c, [...list, keyOf(r)]);
}

// Whether the person of this in-person link is the one holding this browser now. A browser with no list (a program
// using the link, or a browser that never opened the signing page) counts as theirs, unless it is the host's locked
// browser: there, only the person it was handed to is.
export function holdsDevice(c: Ctx, r: any): boolean {
  if (r?.role !== 'inperson') return true;
  const list = handList(c.req);
  if (!list) return !lockedHere(c.req);
  return list[list.length - 1] === keyOf(r);
}
