// The help chat: who answers, the stream, the built-in answers when the model is not there, slow, down or silent, the
// retry on a refusal, every limit, what is taken out before a question leaves, the hand-over to a person with the
// conversation, that nothing else of a chat is stored, and the system prompt built from the same rules the pages
// print. The model is a fetch stub: these tests never reach the network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, Client, signUp, simple, tokenFor } from './helpers.ts';

const { db } = await boot();
const chat = await import('../src/server/chat.ts');
const kb = await import('../src/server/chatkb.ts');
const lib = await import('../src/lib/chat.ts');
const prov = await import('../src/lib/chatprovider.ts');
const policy = await import('../src/lib/policy.ts');
const { PRICING, usd } = await import('../src/lib/impact.ts');

// ---- Plumbing ------------------------------------------------------------------------------------------------------

const realFetch = globalThis.fetch;
type Call = { url: string; headers: Record<string, string>; body: any; signal?: AbortSignal };
let calls: Call[] = [];
function stub(handler: (call: Call, n: number) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const call: Call = { url: String(url), headers: Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
    calls.push(call);
    return handler(call, calls.length);
  }) as any;
}
const KEYS = ['SUPPORT_CHAT_API_KEY', 'SUPPORT_CHAT_BASE_URL', 'SUPPORT_CHAT_MODEL', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY', 'SUPPORT_CHAT_DAILY_LIMIT', 'SUPPORT_CHAT_PROVIDER_NAME', 'SUPPORT_CHAT_PROVIDER_COUNTRY'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
  chat.CHAT_TIMING.ms = 55_000;
});
const provider = (kind: 'openrouter' | 'moonshot' | 'custom' | 'none') => {
  for (const k of KEYS) delete process.env[k];
  if (kind === 'openrouter') process.env.OPENROUTER_API_KEY = 'or-test-key';
  if (kind === 'moonshot') process.env.MOONSHOT_API_KEY = 'ms-test-key';
  if (kind === 'custom') (process.env.SUPPORT_CHAT_API_KEY = 'custom-key'), (process.env.SUPPORT_CHAT_BASE_URL = 'https://llm.example.org/v1'), (process.env.SUPPORT_CHAT_MODEL = 'kimi-k3-local');
};

const enc = new TextEncoder();
const sse = (events: any[]) =>
  new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const piece = (content: string) => ({ choices: [{ delta: { content } }] });
const think = { choices: [{ delta: { reasoning_content: 'hmm' } }] };
const answerWith = (...parts: string[]) => () => sse([think, ...parts.map(piece), 'data: [DONE]\n\n']);

let ipN = 1;
const visitor = () => {
  const c = new Client();
  c.ip = `198.51.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
  return c;
};
const ask = (c: Client, text: string, extra: any = {}, headers: Record<string, string> = {}) =>
  c.call('POST', '/public/chat', { messages: [...(extra.before || []), { role: 'user', content: text }], screen: extra.screen || 'help', ...(extra.link ? { link: extra.link } : {}) }, headers);
const events = (r: { data: any }) =>
  new TextDecoder().decode(r.data).split('\n\n').filter((s) => s.startsWith('data: ')).map((s) => JSON.parse(s.slice(6)));
const streamed = (r: { data: any }) => events(r).filter((e) => typeof e.d === 'string').map((e) => e.d).join('');

// ---- 1. Who answers -----------------------------------------------------------------------------------------------

test('the provider comes from the settings, first match wins, and the key never leaves the server', () => {
  const env = (o: Record<string, string>) => o;
  assert.equal(prov.chatProvider(env({})), null);
  const or = prov.chatProvider(env({ OPENROUTER_API_KEY: 'k' }))!;
  assert.deepEqual([or.baseUrl, or.model, or.style, or.name, or.keyVar], ['https://openrouter.ai/api/v1', 'moonshotai/kimi-k3-20260715', 'openrouter', 'OpenRouter', 'OPENROUTER_API_KEY']);
  const ms = prov.chatProvider(env({ MOONSHOT_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }))!;
  assert.deepEqual([ms.baseUrl, ms.model, ms.style, ms.name], ['https://api.moonshot.ai/v1', 'kimi-k3', 'moonshot', 'Moonshot AI']);
  // The generic key wins over both, and defaults to OpenRouter with Kimi K3.
  const gen = prov.chatProvider(env({ SUPPORT_CHAT_API_KEY: 'k', MOONSHOT_API_KEY: 'k' }))!;
  assert.deepEqual([gen.baseUrl, gen.model, gen.style, gen.keyVar], ['https://openrouter.ai/api/v1', 'moonshotai/kimi-k3-20260715', 'openrouter', 'SUPPORT_CHAT_API_KEY']);
  const own = prov.chatProvider(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://llm.example.org/v1/', SUPPORT_CHAT_MODEL: 'm' }))!;
  assert.deepEqual([own.baseUrl, own.model, own.style, own.name], ['https://llm.example.org/v1', 'm', 'plain', 'The service at llm.example.org']);
  assert.equal(prov.chatProvider(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'https://api.moonshot.ai/v1' }))!.style, 'moonshot');
  // The key never travels in the clear: plain http only to this machine itself.
  assert.equal(prov.chatProvider(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'http://llm.example.org/v1' })), null);
  assert.equal(prov.chatProvider(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'http://localhost:11434/v1' }))!.host, 'localhost:11434');
  assert.equal(prov.chatProvider(env({ SUPPORT_CHAT_API_KEY: 'k', SUPPORT_CHAT_BASE_URL: 'not a url' })), null);
  // A name and a country the operator states are what the security pages print.
  const named = prov.chatProvider(env({ OPENROUTER_API_KEY: 'k', SUPPORT_CHAT_PROVIDER_NAME: 'OpenRouter, Inc.', SUPPORT_CHAT_PROVIDER_COUNTRY: 'United States' }))!;
  assert.deepEqual([named.name, named.country], ['OpenRouter, Inc.', 'United States']);
  assert.ok(!JSON.stringify(named).includes('"k"'), 'the key itself is not in what the pages read');
  assert.equal(prov.chatDailyLimit(env({})), lib.CHAT_DAILY_DEFAULT);
  assert.equal(prov.chatDailyLimit(env({ SUPPORT_CHAT_DAILY_LIMIT: '0' })), 0);
  assert.equal(prov.chatDailyLimit(env({ SUPPORT_CHAT_DAILY_LIMIT: 'lots' })), lib.CHAT_DAILY_DEFAULT);
});

test('without a key the built-in answers answer at once, signed, and nothing leaves the server', async () => {
  provider('none');
  stub(() => assert.fail('no request may leave without a key'));
  const v = visitor();
  const info = await v.get('/public/chat');
  assert.equal(info.status, 200);
  assert.equal(info.data.ai, false);
  assert.equal(info.data.note, lib.CHAT_BUILTIN_NOTE);
  assert.equal(info.data.do_not_type, lib.CHAT_DO_NOT_TYPE);
  const r = await ask(v, 'How do I cancel my plan?');
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'builtin');
  assert.equal(r.data.why, 'off');
  assert.match(r.data.reply, /Settings, then Plan, then Cancel plan/);
  assert.equal(r.data.sig, chat.signAnswer(r.data.reply));
  assert.ok(r.data.tools.some((t: any) => t.href === '/help#cancel'));
  // An honest "not found" for what the built-in answers do not know, with a person offered.
  const odd = await ask(v, 'What colour is the moon on Tuesdays?');
  assert.equal(odd.data.reply, kb.NO_MATCH);
  assert.match(odd.data.reply, /Talk to a person/);
  assert.equal(calls.length, 0);
});

// ---- Streaming, and the request to the model -------------------------------------------------------------------------

test('the answer streams to the page, and the request asks for little thinking, sends no temperature and about 1200 tokens', async () => {
  provider('openrouter');
  stub(answerWith('You can cancel ', 'under Settings, then Plan.'));
  const v = visitor();
  const r = await ask(v, 'How do I cancel?', { screen: 'plan' });
  assert.equal(r.status, 200);
  const ev = events(r);
  assert.equal(ev[0].open, true);
  assert.equal(ev[0].mode, 'ai');
  assert.ok(ev.some((e) => e.think), 'thinking is passed on as a heartbeat, never as text');
  assert.equal(streamed(r), 'You can cancel under Settings, then Plan.');
  const done = ev.find((e) => e.done);
  assert.equal(done.sig, chat.signAnswer('You can cancel under Settings, then Plan.'));
  assert.ok(done.tools.some((t: any) => t.id === 'cancel'));
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(call.headers.authorization, 'Bearer or-test-key');
  assert.equal(call.headers['x-title'], 'Sign&Grow help');
  assert.equal(call.body.model, 'moonshotai/kimi-k3-20260715');
  assert.equal(call.body.stream, true);
  assert.equal(call.body.max_tokens, 1200);
  assert.ok(!('temperature' in call.body), 'Kimi K3 refuses any temperature but 1, so none is sent');
  assert.deepEqual(call.body.reasoning, { effort: 'low' });
  assert.ok(!('reasoning_effort' in call.body));
  assert.equal(call.body.messages[0].role, 'system');
  assert.match(call.body.messages[0].content, /The person is on the Plan page under Settings/);
  assert.deepEqual(call.body.messages.slice(1), [{ role: 'user', content: 'How do I cancel?' }]);
});

test('Moonshot and a host of the operator\'s own get the same request with their own spelling of "think less"', async () => {
  provider('moonshot');
  stub(answerWith('Hello.'));
  await ask(visitor(), 'Hi');
  assert.equal(calls[0].url, 'https://api.moonshot.ai/v1/chat/completions');
  assert.equal(calls[0].body.model, 'kimi-k3');
  assert.equal(calls[0].body.reasoning_effort, 'low');
  assert.ok(!('reasoning' in calls[0].body) && !('temperature' in calls[0].body));
  assert.ok(!calls[0].headers['x-title'], 'OpenRouter\'s attribution only goes to OpenRouter');
  provider('custom');
  stub(answerWith('Hello.'));
  await ask(visitor(), 'Hi');
  assert.equal(calls[0].url, 'https://llm.example.org/v1/chat/completions');
  assert.equal(calls[0].body.model, 'kimi-k3-local');
  assert.equal(calls[0].headers.authorization, 'Bearer custom-key');
});

test('a refusal (4xx) is asked once more without the tuning; a second refusal or a server error is the built-in answers', async () => {
  provider('openrouter');
  stub((_c, n) => (n === 1 ? new Response('{"error":"unknown parameter: reasoning"}', { status: 400 }) : answerWith('Second try worked.')()));
  const r = await ask(visitor(), 'How do refunds work?');
  assert.equal(streamed(r), 'Second try worked.');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.reasoning, { effort: 'low' });
  assert.ok(!('reasoning' in calls[1].body) && !('reasoning_effort' in calls[1].body), 'the second try has only the model and the messages');
  assert.deepEqual(calls[1].body.messages, calls[0].body.messages);

  stub(() => new Response('no', { status: 422 }));
  const twice = await ask(visitor(), 'How do refunds work?');
  assert.equal(calls.length, 2, 'once more, and no more');
  assert.equal(twice.data.mode, 'builtin');
  assert.equal(twice.data.why, 'down');
  assert.match(twice.data.reply, new RegExp(policy.refundRuleText(policy.refundDays()).slice(0, 40)));

  stub(() => new Response('overloaded', { status: 503 }));
  const down = await ask(visitor(), 'How do refunds work?');
  assert.equal(calls.length, 1, 'a server error is not a refusal of the tuning: no second try');
  assert.equal(down.data.why, 'down');
});

test('a provider that cannot be reached, is slow or says nothing is answered with the built-in answers, said as such', async () => {
  provider('openrouter');
  stub(() => Promise.reject(new TypeError('fetch failed')));
  const down = await ask(visitor(), 'I cannot find my signing link');
  assert.equal(down.data.mode, 'builtin');
  assert.equal(down.data.why, 'down');
  assert.match(down.data.reply, /Find my documents/);

  // Slow: nothing within the wait. The wait is 55 seconds; the test makes it short.
  chat.CHAT_TIMING.ms = 150;
  stub((c) => new Promise((_res, rej) => c.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
  const slow = await ask(visitor(), 'I cannot find my signing link');
  assert.equal(slow.data.why, 'slow');
  assert.match(slow.data.reply, /Find my documents/);

  // Slow half way: what came stays, and the end says it was cut short.
  stub((c) => new Response(new ReadableStream({
    start(ctl) {
      ctl.enqueue(enc.encode(`data: ${JSON.stringify(piece('The first half '))}\n\n`));
      c.signal!.addEventListener('abort', () => ctl.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const half = await ask(visitor(), 'Tell me about refunds');
  assert.equal(streamed(half), 'The first half ');
  assert.equal(events(half).find((e) => e.done).cut, true);
  chat.CHAT_TIMING.ms = 55_000;

  // Thinking and then nothing: the built-in answer in the same stream, marked as such.
  stub(() => sse([think, think, 'data: [DONE]\n\n']));
  const empty = await ask(visitor(), 'How do I cancel?');
  const fb = events(empty).find((e) => e.fallback);
  assert.ok(fb, 'an empty answer is replaced');
  assert.equal(fb.fallback.why, 'empty');
  assert.match(fb.fallback.reply, /Cancel plan/);
  assert.equal(fb.fallback.sig, chat.signAnswer(fb.fallback.reply));
  assert.equal(streamed(empty), '');

  // An error in the stream with nothing said is "down"; a host that answers one JSON object instead of a stream works.
  stub(() => sse([{ error: { message: 'provider crashed' } }]));
  assert.equal(events(await ask(visitor(), 'Hi')).find((e) => e.fallback).fallback.why, 'down');
  stub(() => new Response(JSON.stringify({ choices: [{ message: { content: 'All in one go.' } }] }), { headers: { 'content-type': 'application/json' } }));
  assert.equal(streamed(await ask(visitor(), 'Hi')), 'All in one go.');
});

test('what a model may never say is put right at the end of its answer, and em dashes never reach the page', async () => {
  provider('openrouter');
  stub(answerWith('Yes — your signature is valid in Germany.'));
  const r = await ask(visitor(), 'Is my signature valid in Germany?');
  const text = streamed(r);
  assert.ok(!text.includes('—'));
  assert.ok(text.endsWith(chat.CORRECT_VALID));
  assert.equal(events(r).find((e) => e.done).sig, chat.signAnswer(text), 'the signature covers the answer as the page shows it');
  assert.deepEqual(chat.backstop('Nobody can say whether it is valid there.'), []);
  assert.deepEqual(chat.backstop('A simple electronic signature is not legally binding everywhere.'), []);
  assert.deepEqual(chat.backstop('You will get a full refund tomorrow.'), [chat.CORRECT_REFUND]);
  assert.deepEqual(chat.backstop('The refund rule is on the help page.'), []);
});
