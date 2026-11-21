import { route, type Ctx } from './router.ts';
import { get } from './db.ts';
import { bad, rateLimit, str, HttpError } from './util.ts';
import { addressKey } from './clickwrap.ts';
import { answer, cleanConversation } from './chat.ts';
import { chatProvider, chatModelOn } from '../lib/chatprovider.ts';
import { chatScreen, CHAT_AI_NOTE, CHAT_BUILTIN_NOTE, CHAT_DO_NOT_TYPE, CHAT_KEPT, CHAT_PER_ADDRESS_MINUTE, CHAT_PER_ADDRESS_DAY, CHAT_PER_LINK_DAY, CHAT_PER_ACCOUNT_DAY, CHAT_BODY_BYTES } from '../lib/chat.ts';

// The help chat (src/server/chat.ts). These two routes are for the app's own help dialog and are NOT part of the
// public API: they are left out of src/server/openapi.ts on purpose, an API key is refused, and their shape may
// change with the dialog. Anyone may use them, signed in or not, because the people who need help most often cannot
// sign in. The limits are what keeps that affordable.

const FLOOD = 'That is a lot of questions at once. Wait a minute, then ask again. If something is urgent, choose Talk to a person: the form works without the helper.';

// The page, never a key or another site, asks: the dialog posts JSON from our own pages. A post from another site
// with a visitor's browser would spend this server's questions in their name.
function fromOurPage(c: Ctx) {
  if (c.auth?.via === 'api_key') throw new HttpError(403, 'An API key cannot use the help chat. It is for people, in the app and on our pages.');
  const o = c.req.headers.get('origin');
  if (o) {
    let host = '';
    try {
      host = new URL(o).host;
    } catch {}
    if (host !== new URL(c.origin).host) throw new HttpError(403, 'Cross-site request blocked.');
  }
  if (!/^application\/json\b/i.test(c.req.headers.get('content-type') || '')) throw bad('Send the question as JSON.', 415);
}

// The question with its conversation is a few kilobytes; the dialog never sends more than CHAT_BODY_BYTES. The route is
// open to anyone, so a larger body is refused while it is read, before it is parsed or kept in memory whole.
const TOO_LONG = 'This conversation is too long to send. Choose Start again and ask your question on its own, or choose Talk to a person.';
async function smallBody(c: Ctx): Promise<any> {
  const declared = Number(c.req.headers.get('content-length') || 0);
  if (declared > CHAT_BODY_BYTES) throw bad(TOO_LONG, 413);
  const reader = c.req.body?.getReader();
  if (!reader) throw bad('Send a JSON body.');
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CHAT_BODY_BYTES) {
      reader.cancel().catch(() => {});
      throw bad(TOO_LONG, 413);
    }
    parts.push(value);
  }
  try {
    const b = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!b || typeof b !== 'object') throw 0;
    return b;
  } catch {
    throw bad('Send a JSON body.');
  }
}

// What the dialog shows before anything is typed: whether a model answers here, and the limits in numbers.
route('GET', '/public/chat', (c) => {
  if (c.auth?.via === 'api_key') throw new HttpError(403, 'An API key cannot use the help chat. It is for people, in the app and on our pages.');
  const p = chatProvider();
  const ai = chatModelOn();
  return {
    ai, provider: ai ? p!.name : null, note: ai ? CHAT_AI_NOTE : CHAT_BUILTIN_NOTE, do_not_type: CHAT_DO_NOT_TYPE, kept: CHAT_KEPT,
    limits: { per_address_minute: CHAT_PER_ADDRESS_MINUTE, per_address_day: CHAT_PER_ADDRESS_DAY, per_link_day: CHAT_PER_LINK_DAY, per_account_day: CHAT_PER_ACCOUNT_DAY },
  };
}, 'public');

// One question. Body: { messages: [{ role: 'user' | 'assistant', content, sig? }], screen, link? }. `link` is the
// signing link's own secret, sent only by the signing page, only to this server and only to count its limit: it is
// looked up here and never goes further. An unknown one counts for nothing.
route('POST', '/public/chat', async (c) => {
  fromOurPage(c);
  try {
    rateLimit(`chat-flood:${addressKey(c.ip)}`, 60, 60_000);
  } catch {
    throw bad(FLOOD, 429);
  }
  const b = await smallBody(c);
  const conv = cleanConversation(b.messages);
  if (!conv) throw bad('Type a question first.');
  const token = str(b.link, 200);
  const signer = token ? get('SELECT id FROM recipients WHERE token=?', token) : null;
  return answer(conv, chatScreen(b.screen), { ip: c.ip, link: signer?.id || null, account: c.account?.id || null, gone: c.req.signal });
}, 'public');
