import { route, type Ctx } from './router.ts';
import { get } from './db.ts';
import { bad, rateLimit, str, HttpError } from './util.ts';
import { addressKey } from './clickwrap.ts';
import { answer, cleanConversation } from './chat.ts';
import { chatProvider } from '../lib/chatprovider.ts';
import { chatScreen, CHAT_AI_NOTE, CHAT_BUILTIN_NOTE, CHAT_DO_NOT_TYPE, CHAT_KEPT, CHAT_PER_ADDRESS_MINUTE, CHAT_PER_ADDRESS_DAY, CHAT_PER_LINK_DAY, CHAT_PER_ACCOUNT_DAY } from '../lib/chat.ts';
import { chatDailyLimit } from '../lib/chatprovider.ts';

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

// What the dialog shows before anything is typed: whether a model answers here, and the limits in numbers.
route('GET', '/public/chat', (c) => {
  if (c.auth?.via === 'api_key') throw new HttpError(403, 'An API key cannot use the help chat. It is for people, in the app and on our pages.');
  const p = chatProvider();
  const ai = !!p && !!(process.env[p.keyVar] || '').trim() && chatDailyLimit() > 0;
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
  const b = await c.body();
  const conv = cleanConversation(b.messages);
  if (!conv) throw bad('Type a question first.');
  const token = str(b.link, 200);
  const signer = token ? get('SELECT id FROM recipients WHERE token=?', token) : null;
  return answer(conv, chatScreen(b.screen), { ip: c.ip, link: signer?.id || null, account: c.account?.id || null });
}, 'public');
