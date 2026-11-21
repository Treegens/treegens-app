// Writing a document in the app (src/server/writedoc.ts). Four routes, for the writing view and for the API:
//   GET  /write          what the view may offer: whether the AI can be asked here, and to whom the text goes
//   POST /write/draft    a draft from a description, streamed (only with the AI on)
//   POST /write/change   the text after a change asked in words, streamed (only with the AI on)
//   POST /write/render   the text as a PDF, stored like an uploaded file, with the fields its tags make
//   GET  /write/source/:file  the text a file was written from, to edit it again
import { route, type Ctx } from './router.ts';
import { get } from './db.ts';
import { bad, rateLimit, str } from './util.ts';
import { writeInfo, writeAiOn, admitWrite, checkAsk, askModel, storeWritten, writtenSource, cleanTitle } from './writedoc.ts';
import { WRITE_TEXT_MAX, type Paper } from '../lib/writedoc.ts';

// The body of a writing call is the text and a few words around it: a larger one is refused while it is read.
const BODY_MAX = 4 * WRITE_TEXT_MAX + 16_384;
async function body(c: Ctx): Promise<any> {
  if (Number(c.req.headers.get('content-length') || 0) > BODY_MAX) throw bad('That is more text than a document written here can have. Make it shorter first.', 413);
  const reader = c.req.body?.getReader();
  if (!reader) throw bad('Send a JSON body.');
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX) {
      reader.cancel().catch(() => {});
      throw bad('That is more text than a document written here can have. Make it shorter first.', 413);
    }
    parts.push(value);
  }
  try {
    const b = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw 0;
    return b;
  } catch {
    throw bad('Send a JSON body.');
  }
}

route('GET', '/write', (c) => writeInfo(c.account.id, c.user.id));

// The draft and the change: only for a confirmed address on an account whose AI is on, and within the limits.
async function ask(c: Ctx, kind: 'draft' | 'change') {
  if (!writeAiOn(c.account.id)) throw bad('Asking the AI to write is not available here. You can still write the document yourself, or start from one of the starters.', 403, { code: 'ai_off' });
  if (!get('SELECT email_verified v FROM users WHERE id=?', c.user.id)?.v) throw bad('Confirm your email address first: type the 6-digit code we emailed you, or press the button in that email. Then you can ask the AI to write. Typing and the starters work now.', 403, { code: 'confirm_email' });
  const b = await body(c);
  const a = checkAsk({ ...b, kind });
  try {
    rateLimit(`write-flood:${c.account.id}`, 20, 60_000);
  } catch {
    throw bad('That is a lot of requests at once. Wait a minute, then ask again. Typing still works.', 429);
  }
  const ok = admitWrite({ ip: c.ip, account: c.account.id });
  if (!ok.ok) throw bad(ok.text, 429, { code: 'limit' });
  return askModel(a, c.req.signal);
}
route('POST', '/write/draft', (c) => ask(c, 'draft'));
route('POST', '/write/change', (c) => ask(c, 'change'));

route('POST', '/write/render', async (c) => {
  const b = await body(c);
  try {
    rateLimit(`write-render:${c.account.id}`, 30, 60_000);
  } catch {
    throw bad('That is a lot of documents at once. Wait a minute, then try again.', 429);
  }
  const paper: Paper = b.paper === 'letter' ? 'letter' : 'a4';
  // `ai` is what the view says about its own text: it only decides what the sender is told about it later.
  return storeWritten(c.account.id, { title: cleanTitle(b.title), text: str(b.text, WRITE_TEXT_MAX + 1), paper, ai: b.ai === true && writeAiOn(c.account.id) });
});

route('GET', '/write/source/:file', (c) => {
  const s = writtenSource(c.params.file, c.account.id);
  if (!s) throw bad('This document was not written here, so there is no text to edit. Replace the file instead.', 404);
  return s;
});
