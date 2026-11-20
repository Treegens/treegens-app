// The help chat on the server: who answers, the limits, the call to the model and the stream back to the page
// (src/server/routes-chat.ts has the routes, src/lib/chat.ts the shared rules, src/server/chatkb.ts what it knows).
//
// What leaves this server: the system prompt (our own rules, from policy.ts) and the conversation as the browser
// sent it, after redact() has run on it once more here. Nothing that says who is asking: no account, no address, no
// signing link, no cookie. What stays: nothing of the chat at all, only the counts in chat_counts under keyed
// fingerprints, and the conversation a person chooses to attach to a help request (attachedChat, below). Nothing
// here writes a question or an answer to the database or to the log.
import { get, run, tx } from './db.ts';
import { hmac, safeEqual, now, baseUrl, str } from './util.ts';
import { addressKey } from './clickwrap.ts';
import { chatProvider, chatDailyLimit, type ChatProvider } from '../lib/chatprovider.ts';
import {
  CHAT_PER_ADDRESS_MINUTE, CHAT_PER_ADDRESS_DAY, CHAT_PER_LINK_DAY, CHAT_PER_ACCOUNT_DAY, CHAT_TIMEOUT_SECONDS, CHAT_KEEP_MESSAGES,
  CHAT_MESSAGE_CHARS, CHAT_ATTACH_LINES, CHAT_ATTACH_CHARS, redact, handOverReason, toolsFor, limitText,
  type ChatLimit, type ChatScreen, type ChatTurn, type HandOver, type Removed, type AttachedLine,
} from '../lib/chat.ts';
import { systemPrompt, builtInAnswer } from './chatkb.ts';

/** Kimi K3 thinks before it answers, and those tokens count: a small ceiling ends in an empty answer. */
export const MAX_COMPLETION_TOKENS = 1200;
/** The wait for the model. Tests make it short. */
export const CHAT_TIMING = { ms: CHAT_TIMEOUT_SECONDS * 1000 };

// ---- Answers the helper gave, recognised later -----------------------------------------------------------------
// Every answer goes out with a signature made with the server's secret. The page sends it back with the conversation,
// so an answer typed into the page by hand is not passed to the model as ours, and the people who answer a help
// request can tell what the helper really said from what was typed into the page.
export const signAnswer = (text: string) => hmac(`chat-answer:${text}`).slice(0, 32);
const signed = (text: string, sig: any) => typeof sig === 'string' && sig.length === 32 && safeEqual(sig, signAnswer(text));

// ---- The conversation as it arrives ----------------------------------------------------------------------------
export type Cleaned = { turns: ChatTurn[]; removed: Removed[]; question: string };
/** The latest messages, each cut short, the person's own words redacted, and only the answers we signed. */
export function cleanConversation(raw: unknown): Cleaned | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 200) return null;
  const removed = new Set<Removed>();
  const turns: ChatTurn[] = [];
  for (const m of raw.slice(-CHAT_KEEP_MESSAGES)) {
    if (!m || typeof m !== 'object') return null;
    const role = (m as any).role, content = (m as any).content;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return null;
    if (role === 'assistant') {
      if (signed(content, (m as any).sig)) turns.push({ role, content: content.slice(0, 4000) });
      continue;
    }
    const r = redact(content.slice(0, CHAT_MESSAGE_CHARS).trim());
    r.removed.forEach((k) => removed.add(k));
    if (r.text) turns.push({ role, content: r.text });
  }
  const last = turns[turns.length - 1];
  if (!last || last.role !== 'user') return null;
  return { turns, removed: [...removed], question: last.content };
}

// ---- Limits ------------------------------------------------------------------------------------------------------
// Counted in the database, so they hold across a restart and across the processes of one server. The keys are keyed
// fingerprints: the table holds no internet address, no signing link and no account id.
const fp = (kind: string, v: string) => `${kind}:${hmac(`chat-limit:${kind}:${v}`).slice(0, 32)}`;
/** The key a count is kept under: 'ip' with an internet address, 'link' with a recipient's id, 'account' with an account's. */
export const countKey = (kind: 'ip' | 'link' | 'account', v: string) => fp(kind, kind === 'ip' ? addressKey(v) : v);
type Bucket = { which: ChatLimit; key: string; slot: string; max: number; until: Date };
export type Who = { ip: string; link?: string | null; account?: string | null };
function bucketsFor(who: Who, t = new Date()): Bucket[] {
  const day = `d:${t.toISOString().slice(0, 10)}`, minute = `m:${t.toISOString().slice(0, 16)}`;
  const nextMinute = new Date(Math.floor(t.getTime() / 60_000) * 60_000 + 60_000);
  const nextDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1));
  const ip = countKey('ip', who.ip);
  return [
    { which: 'address_minute', key: ip, slot: minute, max: CHAT_PER_ADDRESS_MINUTE, until: nextMinute },
    { which: 'address_day', key: ip, slot: day, max: CHAT_PER_ADDRESS_DAY, until: nextDay },
    ...(who.link ? [{ which: 'link_day' as const, key: countKey('link', who.link), slot: day, max: CHAT_PER_LINK_DAY, until: nextDay }] : []),
    ...(who.account ? [{ which: 'account_day' as const, key: countKey('account', who.account), slot: day, max: CHAT_PER_ACCOUNT_DAY, until: nextDay }] : []),
    { which: 'daily', key: 'all', slot: day, max: chatDailyLimit(), until: nextDay },
  ];
}
const g = globalThis as any;
/** One more question for the model, if every limit has room: all of them are counted at once, or none. */
export function admit(who: Who): { ok: true } | { ok: false; which: ChatLimit; until: Date } {
  const out = tx(() => {
    const list = bucketsFor(who);
    for (const b of list) {
      const n = get('SELECT n FROM chat_counts WHERE key=? AND slot=?', b.key, b.slot)?.n || 0;
      if (n >= b.max) return { ok: false as const, which: b.which, until: b.until };
    }
    for (const b of list) run('INSERT INTO chat_counts (key, slot, n, at) VALUES (?,?,1,?) ON CONFLICT(key, slot) DO UPDATE SET n=n+1, at=excluded.at', b.key, b.slot, now());
    return { ok: true as const };
  });
  // Old counts go: nothing is needed after the day it counts for. At most once an hour.
  if (!g.__chatPruned || Date.now() - g.__chatPruned > 3600_000) {
    g.__chatPruned = Date.now();
    run('DELETE FROM chat_counts WHERE at < ?', new Date(Date.now() - 2 * 864e5).toISOString());
  }
  if (!out.ok && out.which === 'daily' && g.__chatFullDay !== new Date().toISOString().slice(0, 10)) {
    g.__chatFullDay = new Date().toISOString().slice(0, 10);
    console.warn(`[chat] The help chat reached SUPPORT_CHAT_DAILY_LIMIT (${chatDailyLimit()}) for today. Until midnight UTC everyone gets the built-in answers.`);
  }
  return out;
}

// ---- What every answer carries -----------------------------------------------------------------------------------
export type Extras = { person: HandOver | null; tools: { id: string; label: string; href: string }[]; removed: Removed[] };
export function extrasFor(c: Cleaned, answer = ''): Extras {
  return { person: handOverReason(c.turns), tools: toolsFor(c.question, answer), removed: c.removed };
}
/** The built-in answer, as the route sends it. `why` says why it is not the model. */
export function builtIn(c: Cleaned, why: 'off' | 'limit' | 'down' | 'slow' | 'empty', note?: string) {
  const { reply } = builtInAnswer(c.question);
  return { mode: 'builtin' as const, why, reply, sig: signAnswer(reply), ...(note ? { note } : {}), ...extrasFor(c, reply) };
}

// What a model may never say, whatever it was asked or told, put right at the end of its answer. It writes in the
// person's language and these checks read English, so they are a backstop for the instructions, not a guarantee.
const SAYS_VALID = /\b(is|are|will be|would be)\s+(legally\s+)?(valid|binding|enforceable)\b|\bwill\s+(definitely\s+)?hold\s+up\b|\blegally\s+binding\b/i;
const NOT_BEFORE = /\b(not|never|no one can say|cannot say|can't say|whether)\b[^.]{0,40}$/i;
const PROMISES_REFUND = /\b(you will|you'll|we will|we'll|i will|i'll)\s+(get|receive|be given|issue|send you|refund)\b[^.]{0,30}\brefund|\brefund (is|has been) (approved|guaranteed|on its way)\b/i;
export const CORRECT_VALID = 'To be clear: the helper cannot say whether a signature is valid or will hold up. That depends on the law where you are and on the kind of document. A lawyer can tell you.';
export const CORRECT_REFUND = 'To be clear: the helper cannot promise a refund. The refund rule on the help page is what counts, and anything outside it is for a person to decide.';
export function backstop(answer: string): string[] {
  const out: string[] = [];
  const m = SAYS_VALID.exec(answer);
  if (m && !NOT_BEFORE.test(answer.slice(Math.max(0, m.index - 60), m.index))) out.push(CORRECT_VALID);
  if (PROMISES_REFUND.test(answer)) out.push(CORRECT_REFUND);
  return out;
}
// Em dashes never reach the page, whatever the model writes.
const plain = (s: string) => s.replace(/\s*\u2014\s*/g, ', ');

// ---- The model -------------------------------------------------------------------------------------------------------
function callModel(p: ChatProvider, screen: ChatScreen, turns: ChatTurn[], tuned: boolean, signal: AbortSignal): Promise<Response> {
  // No temperature: Kimi K3 refuses every value but 1, and leaving it out takes each host's own default.
  const body: Record<string, unknown> = {
    model: p.model, stream: true, max_tokens: MAX_COMPLETION_TOKENS,
    messages: [{ role: 'system', content: systemPrompt(screen) }, ...turns],
  };
  // Little thinking for a support answer. The two hosts spell it differently; a host that knows neither refuses the
  // request, and it is asked once more without it.
  if (tuned) {
    if (p.style === 'openrouter') body.reasoning = { effort: 'low' };
    else body.reasoning_effort = 'low';
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${(process.env[p.keyVar] || '').trim()}` };
  // OpenRouter's optional attribution names this site, never the person.
  if (p.style === 'openrouter') Object.assign(headers, { 'http-referer': baseUrl(), 'x-title': 'Sign&Grow help' });
  return globalThis.fetch(`${p.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
}

/**
 * Asks the model and streams its answer to the page as Server-Sent Events, or answers with the built-in answers when
 * there is no model, a limit is reached, or the model is down, slow or says nothing. Events, one JSON object each:
 *   {open, mode: 'ai', person, tools, removed}  first
 *   {think: true}                               while the model thinks (keeps the connection alive)
 *   {d: "text"}                                 the answer, piece by piece
 *   {done, sig, cut?}                           the end; `cut` when it stopped part way after CHAT_TIMING
 *   {fallback: {...built-in answer}}            instead of an answer, when the model said nothing in time
 */
export async function answer(c: Cleaned, screen: ChatScreen, who: Who): Promise<Response | (ReturnType<typeof builtIn> & { limit?: { which: ChatLimit; until: string } })> {
  const p = chatProvider();
  if (!p || !(process.env[p.keyVar] || '').trim()) return builtIn(c, 'off');
  const ok = admit(who);
  if (!ok.ok) {
    const until = `${ok.until.toISOString().slice(11, 16)} UTC`;
    return { ...builtIn(c, 'limit', limitText(ok.which, until)), limit: { which: ok.which, until: ok.until.toISOString() } };
  }
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), abort.abort()), CHAT_TIMING.ms);
  let res: Response;
  try {
    res = await callModel(p, screen, c.turns, true, abort.signal);
    if (!res.ok && res.status >= 400 && res.status < 500) {
      res.body?.cancel().catch(() => {});
      res = await callModel(p, screen, c.turns, false, abort.signal);
    }
  } catch {
    clearTimeout(timer);
    return builtIn(c, timedOut ? 'slow' : 'down');
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    // The status only: never what was asked.
    console.warn(`[chat] ${p.name} answered ${res.status}. The built-in answers took over.`);
    res.body?.cancel().catch(() => {});
    return builtIn(c, 'down');
  }
  return relay(res, c, () => clearTimeout(timer), () => timedOut, abort);
}

function relay(upstream: Response, c: Cleaned, finish: () => void, late: () => boolean, abort: AbortController): Response {
  const reader = upstream.body!.getReader();
  const asJson = (upstream.headers.get('content-type') || '').includes('application/json');
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let text = '';
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The page may have gone away meanwhile (cancel below): then there is nobody left to send to.
      let gone = false;
      const send = (o: object) => {
        if (gone) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
        } catch {
          gone = true;
        }
      };
      const first = extrasFor(c);
      send({ open: true, mode: 'ai', ...first });
      let buffer = '', lastThink = 0, broke = false;
      const take = (piece: string) => {
        const clean = plain(piece);
        if (!clean) return;
        text += clean;
        send({ d: clean });
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (asJson) continue;
          const parts = buffer.split('\n');
          buffer = parts.pop() ?? '';
          for (const line of parts) {
            const data = line.startsWith('data:') ? line.slice(5).trim() : '';
            if (!data || data === '[DONE]') continue;
            let o: any;
            try {
              o = JSON.parse(data);
            } catch {
              continue;
            }
            if (o?.error) {
              broke = true;
              continue;
            }
            const delta = o?.choices?.[0]?.delta;
            if (typeof delta?.content === 'string' && delta.content) take(delta.content);
            else if (delta?.reasoning_content || delta?.reasoning) {
              if (Date.now() - lastThink > 1500) (lastThink = Date.now()), send({ think: true });
            }
          }
        }
        // A host that answered with one JSON object instead of a stream.
        if (asJson) {
          try {
            const m = JSON.parse(buffer)?.choices?.[0]?.message?.content;
            if (typeof m === 'string') take(m);
          } catch {}
        }
      } catch {
        broke = true;
      } finally {
        finish();
        reader.releaseLock();
      }
      if (!text.trim()) {
        // Nothing came: the built-in answer in its place, said as such.
        const b = builtIn(c, late() ? 'slow' : broke ? 'down' : 'empty');
        send({ fallback: b });
      } else {
        for (const line of backstop(text)) take(`\n\n${line}`);
        const tools = toolsFor(c.question, text);
        send({ done: true, sig: signAnswer(text), tools, ...(late() || broke ? { cut: true } : {}) });
      }
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      // The page went away: stop the model too, so nothing more is paid for.
      finish();
      abort.abort();
      reader.cancel().catch(() => {});
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
}

// ---- A conversation attached to a help request ---------------------------------------------------------------------
/**
 * What a person chose to send to a person with their help request: their own lines redacted once more, the helper's
 * lines marked as checked when the server signed them, at most CHAT_ATTACH_LINES lines and CHAT_ATTACH_CHARS
 * characters. Null when there is nothing. Stored as JSON on the request (support_requests.chat), and nowhere else.
 */
export function attachedChat(raw: unknown): AttachedLine[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out: AttachedLine[] = [];
  let size = 0;
  for (const m of raw.slice(-CHAT_ATTACH_LINES)) {
    if (!m || typeof m !== 'object') continue;
    const from = (m as any).from === 'helper' ? 'helper' : (m as any).from === 'you' ? 'you' : null;
    const text0 = str((m as any).text, 4000).trim();
    if (!from || !text0) continue;
    const text = from === 'you' ? redact(text0).text : text0;
    if (size + text.length > CHAT_ATTACH_CHARS) break;
    size += text.length;
    out.push({ from, text, checked: from === 'helper' && signed(text0, (m as any).sig) });
  }
  return out.length ? out : null;
}
/** The attached conversation of a request, for the people who answer it. */
export function attachedOf(t: any): AttachedLine[] | null {
  if (!t?.chat) return null;
  try {
    const l = JSON.parse(t.chat);
    return Array.isArray(l) && l.length ? l : null;
  } catch {
    return null;
  }
}
