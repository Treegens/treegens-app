import { route } from './router.ts';
import { bad, rateLimit } from './util.ts';
import { find, look } from './routes-sign.ts';
import { requestCode, checkCode, codeProblem, gateOf, passCookie } from './signercode.ts';

// The one-time code on the signing page: ask for one, type it in, and the way out when it never arrives. Like
// everything under /sign/:token these are authorised by the link alone, so what they answer is written for whoever
// holds the link, who may not be the person the document is for: never the code, never the full address or number.
// The rules are in signercode.ts.

// The access code comes first when the sender set one, so somebody who has only the link cannot make us send a
// text or an email.
const afterAccessCode = (locked: boolean) => {
  if (locked) throw bad('Enter the access code first.', 401);
};

// "Send me the code" and "Send a new code". The answer says where it went (masked), how long the code works and
// when a new one can be asked for.
route('POST', '/sign/:token/code', async (c) => {
  const { e, r, locked, gate, actor } = find(c, false);
  afterAccessCode(locked);
  // A device that has passed already needs no code. The screen simply opens the document.
  if (!gate) return { sent: false, passed: true };
  return requestCode(e, r, actor);
}, 'public');

// The code somebody typed. Reading the body means waiting, so the link is looked up again after it and nothing is
// waited for between that look and the check: two tries at the same moment are counted one after the other.
route('POST', '/sign/:token/code/check', async (c) => {
  find(c, false);
  const body = await c.body();
  const { e, r, locked, gate, actor } = look(c, false);
  afterAccessCode(locked);
  if (!gate) return { ok: true };
  const out = await checkCode(e, r, body.code, actor);
  c.cookies.push(passCookie(r, c.secure));
  return out;
}, 'public');

// "This is not my number" and "I do not get the code": tells the sender, who is the only one who can fix it.
route('POST', '/sign/:token/code/problem', async (c) => {
  find(c, false);
  const body = await c.body();
  const { e, r, locked, gate, actor } = look(c, false);
  afterAccessCode(locked);
  if (!gate) throw bad('This document is already open on this device, so there is no code to wait for.', 409);
  // A few times a day is plenty to be heard, and keeps a link from being used to fill the sender's inbox.
  rateLimit(`codeproblem:${r.id}`, 3, 86400_000);
  return codeProblem(e, r, body.what, actor);
}, 'public');
