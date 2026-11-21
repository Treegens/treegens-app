// The help chat: an AI helper that answers at once, with a person always one click away (src/server/chat.ts,
// src/server/routes-chat.ts, src/components/HelpChat.tsx). The rules, numbers and words that the dialog and the server
// share live here. Nothing in this file reads the environment or the database, so 'use client' files may import it.
//
// What the helper never does: act on anything, see a document, an account or a payment, or promise what the rules on
// our pages do not say. It points to the tools that exist. Who answers (a model, or the built-in answers) and from
// where is decided on the server (src/lib/chatprovider.ts reads the settings).

// ---- Limits --------------------------------------------------------------------------------------------------
// Counted in the database (chat_counts), so a restart does not reset them. Past any of them the built-in answers take
// over, and the person is told which limit it was and until when, in plain words. The built-in answers have no limit
// of their own beyond the flood guard of the route.
/** Questions to the model from one internet address in a minute, and in a day (UTC). */
export const CHAT_PER_ADDRESS_MINUTE = 8;
export const CHAT_PER_ADDRESS_DAY = 60;
/** Questions to the model from the signing page of one signing link in a day. */
export const CHAT_PER_LINK_DAY = 40;
/** Questions to the model from the people signed in to one account in a day. */
export const CHAT_PER_ACCOUNT_DAY = 300;
/** Questions to the model from everyone on this server in a day, unless SUPPORT_CHAT_DAILY_LIMIT says otherwise. */
export const CHAT_DAILY_DEFAULT = 2000;
/** How long the server waits for the model before the built-in answers take over. */
export const CHAT_TIMEOUT_SECONDS = 55;
/** How much of the conversation goes along with a question: the latest messages, each cut to this many characters. */
export const CHAT_KEEP_MESSAGES = 12;
export const CHAT_MESSAGE_CHARS = 1500;
/** The most of a conversation that can be attached to a help request. */
export const CHAT_ATTACH_LINES = 40;
export const CHAT_ATTACH_CHARS = 16000;
/** The longest answer relayed to the page. 1200 tokens is far less; a host that ignores that is cut off here. */
export const CHAT_ANSWER_CHARS = 8000;
/** The largest question the server reads, in bytes, with the conversation that goes with it. */
export const CHAT_BODY_BYTES = 512 * 1024;

export type ChatLimit = 'address_minute' | 'address_day' | 'link_day' | 'account_day' | 'daily';

/** Which limit was reached, in words, with what happens now. `until` is the moment it frees up, as a time of day. */
export function limitText(which: ChatLimit, until: string): string {
  const what: Record<ChatLimit, string> = {
    address_minute: `${CHAT_PER_ADDRESS_MINUTE} questions a minute from this internet connection`,
    address_day: `${CHAT_PER_ADDRESS_DAY} questions a day from this internet connection`,
    link_day: `${CHAT_PER_LINK_DAY} questions a day from this signing page`,
    account_day: `${CHAT_PER_ACCOUNT_DAY} questions a day from this account`,
    daily: 'the number of questions it can answer today for everyone',
  };
  return `The AI helper has reached its limit of ${what[which]}. Until ${until}, the answers come from our built-in help, which knows less. A person is still one click away: choose Talk to a person.`;
}

// ---- Where the person is -------------------------------------------------------------------------------------
// The page says which kind of screen it is and nothing else: never a document, a name, an address, a signing link or
// a code. The model is told this one line so its answer fits.
export const CHAT_SCREENS = {
  signing: 'the signing page of a document that was sent to them',
  editor: 'the editor, where a sender prepares and sends a document',
  plan: 'the Plan page under Settings, where an account pays, stops or refunds',
  help: 'the help page',
  app: 'a page of the app, signed in to their account',
  public: 'a public page of the website',
} as const;
export type ChatScreen = keyof typeof CHAT_SCREENS;
export const chatScreen = (v: unknown): ChatScreen => (typeof v === 'string' && Object.hasOwn(CHAT_SCREENS, v) ? (v as ChatScreen) : 'public');
/** The kind of screen from the address bar, without anything that is in it. */
export function screenOf(path: string, search = ''): ChatScreen {
  if (/^\/sign\//.test(path)) return 'signing';
  if (/^\/app\/envelopes\/new(\/|$)|^\/app\/(envelopes|templates)\/[^/]+\/edit/.test(path)) return 'editor';
  if (/^\/app\/settings/.test(path) && /[?&]tab=billing(&|$)/.test(search)) return 'plan';
  if (/^\/help(\/|$)/.test(path)) return 'help';
  if (/^\/app(\/|$)/.test(path)) return 'app';
  return 'public';
}
/** The questions offered before anything is typed, by screen. */
// Three for each screen, in the words of the person on it.
export const CHAT_STARTERS: Record<ChatScreen, string[]> = {
  signing: ['I cannot sign today', 'My name is spelled wrong', 'How do I get a copy later?'],
  editor: ['How do signatures work, and what is free?', 'Can I fix a document after sending?', 'Why can I not send?'],
  plan: ['Can I get a refund?', 'How do I cancel?', 'What happens to my documents when I cancel?'],
  help: ['I cannot find my signing link', 'Is this email really from GrowSigning?', 'I cannot log in'],
  app: ['How do I send my first document?', 'They never got my email', 'Who has not signed yet?'],
  public: ['How much does it cost?', 'Is this email really from GrowSigning?', 'I cannot find my signing link'],
};

// ---- What the person is told before they type ---------------------------------------------------------------
/** Said behind "What we keep" in the chat, and on /security. */
export const CHAT_DO_NOT_TYPE = 'Do not type passwords, card numbers, signing links or the codes from our emails. We take out what looks like one before your question is sent, but we cannot catch everything.';
/** What is kept of a chat, said at the top and on /security. True of the code: see src/server/chat.ts. */
export const CHAT_KEPT = 'We keep nothing of this chat. Only a count of questions is kept, under a fingerprint of your internet address (and of the signing link or the account, where there is one), for up to two days, to hold the limits. If you send the chat to a person, it becomes part of your help request.';
/** The same, for /security and /security/processing. */
export const CHAT_KEPT_PAGE = 'Nothing of what is asked or answered is stored or logged. Only a count of questions is kept, under a keyed fingerprint of the internet address (and of the signing link or the account, where there is one), for up to two days, to hold the limits. A chat that someone chooses to send with a help request becomes part of that request, and goes with it.';
/** Under the title when a model answers. */
export const CHAT_AI_NOTE = 'An AI helper answers here at once. It can be wrong: the rules on our pages are what count, and it gives no legal advice.';
/** Under the title when no model is set up on this server, or none can answer now. */
/** The one line above the conversation, on every screen, and only when a model answers. No model or host is named. */
export const CHAT_SHORT_AI = 'Answers are written by AI and can be wrong. Do not type passwords or card numbers.';
/** With no model, nothing is above the conversation. This is its first grey line, before anything is asked. */
export const CHAT_SHORT_BUILTIN = 'These answers come from our help pages.';
export const CHAT_BUILTIN_NOTE = 'Answers here come from our help pages, chosen by the words you type. They can miss the point: the rules on our pages are what count.';

// ---- Taking out what must not be sent -----------------------------------------------------------------------
// Run in the browser before a question leaves it and again on the server before it goes to the model, so neither a
// changed page nor an old one can send these on. It errs on the side of taking out too much. What it took out is said
// to the person ("We took out what looked like a card number").
export type Removed = 'link' | 'email' | 'card' | 'code' | 'password';
export const REMOVED_WORDS: Record<Removed, string> = {
  link: 'a private link', email: 'an email address', card: 'a card number', code: 'a code', password: 'a password',
};
const CODE_CH = 'A-HJ-NP-Z2-9';
const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
};
// A path or a query that carries a secret: the pages whose address is a key (a signing link, a help request's
// private link, a password reset, a stop link, an email confirmation), or any piece that reads like a random key.
const PRIVATE_PATH = /\/(sign|help\/request|reset|billing\/stop|verify-email|change-email|two-step-reset|archive-confirm|agree)\b/i;
const KEYLIKE = /[A-Za-z0-9_-]{16,}/;
const keyish = (s: string) => KEYLIKE.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s);
// Everyday words that follow "password" in a question about it ("my password is not working", "password reset
// email"), so they are not taken for the password itself.
const COMMON_AFTER_PASSWORD = new Set(`a about after again all also an and any anymore are aren't as at be because been before being blank
blocked both box boxes but button by can can't cannot case change changed changes changing characters correct could did didn't different
do does doesn't don't either email emails empty entered error errors etc every expired expires expiry fails failed failing field fields
for forgot forgotten form from had has have he help here hidden hint hints how i if in incorrect invalid is isn't it its just keeps kept
length letters link links locked log login long lost mail manager managers me missing my name needed never new no nor not now number
numbers of ok okay old on once only or our page passcode password passwords phone pin please pw pwd policy problem problems prompt protected protection recovery refused rejected
required requirement requirements reset resets right rule rules safe same saved screen secure security sent set setting settings she
short should shown sign since so some still strength strong symbols than thanks thank that the their then there these they this those
though to today too twice typed until update updated username visible was wasn't we weak were what when where which while who why will
with without won't would wrong yes yesterday you your`.split(/\s+/));

export function redact(input: string): { text: string; removed: Removed[] } {
  const removed = new Set<Removed>();
  const take = (kind: Removed, word: string) => (removed.add(kind), `[${word} removed]`);
  let t = String(input ?? '');
  // Links: a web address with a private page or a key in it. An address of a public page stays.
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi, (url) => {
    const rest = url.replace(/^(?:https?:\/\/|www\.)[^/?#]*/i, '');
    return PRIVATE_PATH.test(rest) || rest.split(/[/?#=&]/).some(keyish) ? take('link', 'link') : url;
  });
  // The same pages written without the site in front, and a bare key such as a signing link's own secret or an API key.
  t = t.replace(/(^|[\s(])\/(?:sign|help\/request|reset|billing\/stop|verify-email|change-email|two-step-reset)\/\S+/gi, (_m, pre) => `${pre}${take('link', 'link')}`);
  t = t.replace(/\b[A-Za-z0-9_-]{24,}\b/g, (m) => (keyish(m) ? take('code', 'code') : m));
  // Email addresses.
  t = t.replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g, () => take('email', 'email address'));
  // Card numbers: 13 to 19 digits, in groups or not. 15 and 16 digits always (that is nearly every card); the other
  // lengths only when the check digit fits, so a long phone number with its country code stays.
  t = t.replace(/(?<![\d.,])\d(?:[ -]?\d){12,18}(?![\d.,]\d)/g, (m) => {
    const d = m.replace(/\D/g, '');
    return d.length === 15 || d.length === 16 || luhn(d) ? take('card', 'card number') : m;
  });
  // The same with full stops between the groups (4242.4242.4242.4242, or 3782.822463.10005). Amounts are written in
  // groups of three, never four, so they stay.
  t = t.replace(/(?<![\d.,])(?:\d{4}(?:\.\d{4}){2}\.\d{1,7}|\d{4}\.\d{6}\.\d{4,5})(?![.,]?\d)/g, (m) => {
    const d = m.replace(/\D/g, '');
    return d.length >= 13 && (d.length === 15 || d.length === 16 || luhn(d)) ? take('card', 'card number') : m;
  });
  // The three digits on the back of a card.
  t = t.replace(/\b(cvv2?|cvc2?|csc)\b(\s*(?:is|:|=|-)?\s*)\d{3,4}\b/gi, (_m, w, sep) => `${w}${sep}${take('card', 'card security code')}`);
  // The security code from our emails: 12 characters of the alphabet nobody can misread, as typed or in groups of 4.
  // In groups split by spaces it is taken only when it has a digit, so three shouted words stay.
  t = t.replace(new RegExp(`\\b[${CODE_CH}]{4}([- ]?)[${CODE_CH}]{4}\\1[${CODE_CH}]{4}\\b`, 'g'), (m, sep) => (sep !== ' ' || /\d/.test(m) ? take('code', 'code') : m));
  t = t.replace(new RegExp(`\\b[${CODE_CH}]{4}-[${CODE_CH}]{4}-[${CODE_CH}]{4}\\b`, 'gi'), () => take('code', 'code'));
  // The same typed in lower case, run together or in groups of four: taken when it mixes letters and digits, so an
  // ordinary twelve-letter word stays.
  t = t.replace(new RegExp(`\\b[${CODE_CH}]{4}( ?)[${CODE_CH}]{4}\\1[${CODE_CH}]{4}\\b`, 'gi'), (m) => (/\d/.test(m) && /[a-z]/i.test(m) ? take('code', 'code') : m));
  // Recovery codes of two-step login (five and five, lower case, with a digit in them) and one-time codes (six digits).
  t = t.replace(/\b[a-hj-np-z2-9]{5}-[a-hj-np-z2-9]{5}\b/gi, (m) => (/\d/.test(m) ? take('code', 'code') : m));
  t = t.replace(/(?<![\d.,$€£+]|\d[ -])\b\d{3}[ -]?\d{3}\b(?![.,]\d|[ -]\d)/g, (m) => (/^\d{6}$/.test(m) || /\bcode\b/i.test(t) ? take('code', 'code') : m));
  // A login written out as "name / password" (the name may already be taken out above).
  t = t.replace(/\b(log ?in|user ?name|user|e-?mail|account)(\s*(?:is|:|=)?\s*)(\[email address removed\]|[^\s/,|[\]]+)(\s*[/|]\s*)([^\s"'”’]+)/gi, (m, w, s1, name, s2, v) => {
    const core = v.replace(/[.,!?;)]+$/, ''), tail = v.slice(core.length);
    return core && !/^\[/.test(core) && !COMMON_AFTER_PASSWORD.has(core.toLowerCase()) ? `${w}${s1}${name}${s2}${take('password', 'password')}${tail}` : m;
  });
  // A password, an access code or a PIN after the word that names it. A value that reads like one (it has a digit, a
  // sign or a capital inside, or comes after a colon, an equals sign or in quotes) always goes. After "password" and
  // its kin, a plain word goes too ("my password is sunshine"), unless it is an everyday word that says something
  // about the password, so "my password is not working" and "password reset" stay as they are.
  // The word for a password in German, French, Spanish and Portuguese counts too, for a value that reads like one.
  // In double quotes it may be several words ("my password is "blue sky at night"").
  t = t.replace(/(?<![\p{L}\d])(pass(?:word|code|phrase|wort)?|pwd|pw|kennwort|mot de passe|contraseña|contrasena|senha|clave)(?![\p{L}\d])(\s*(?:(?:ist|is|was|war|est|es|é|è)(?=\s)|:|=)?\s*)["“][^"“”\n]{1,80}["”]/giu, (_m, w, sep) => `${w}${sep}${take('password', 'password')}`);
  t = t.replace(/(?<![\p{L}\d])(pass(?:word|code|phrase|wort)?|pwd|pw|access code|pin|kennwort|mot de passe|contraseña|contrasena|senha|clave)(?![\p{L}\d])(\s*(?:(?:ist|is|was|war|est|es|é|è)(?=\s)|:|=)?\s*)(["'“‘]?)([^\s"'”’]+)\3/giu, (m, w, sep, q, v) => {
    // Something already taken out above ("[code removed]") is not a password.
    if (/removed\]/.test(v) || /^\[/.test(v)) return m;
    // Full stops and commas at the end belong to the sentence, not to the value.
    const core = v.replace(/[.,!?;)]+$/, ''), tail = v.slice(core.length);
    if (!core) return m;
    const everyday = COMMON_AFTER_PASSWORD.has(core.toLowerCase()) || /^work\w*$/i.test(core);
    const strong = /[:=]/.test(sep) || !!q || /\d/.test(core) || /[^\p{L}]/u.test(core) || /[a-z][A-Z]|[A-Z]{2}/.test(core);
    const named = /^(password|passcode|passphrase|pwd)$/i.test(w) && /^[A-Za-z]{3,}$/.test(core);
    return (strong || named) && !everyday ? `${w}${sep}${take('password', 'password')}${!q && /^[.,]$/.test(tail) ? tail : ''}` : m;
  });
  // Anything else that reads like a strong password: a word of 8 or more characters that mixes small letters with
  // capitals or digits and a sign such as ! # $ or %.
  t = t.replace(/(?<![\w[/.:#=&?-])[A-Za-z0-9!#$%^&*?~+=_@]{8,64}(?![\w\]/:=&-]|\.\w)/g, (m) =>
    /[a-z]/.test(m) && /[A-Z0-9]/.test(m) && /[!#$%^&*?~+=_]/.test(m.slice(0, -1)) && !/@[\w-]+\./.test(m) ? take('password', 'password') : m);
  return { text: t, removed: [...removed] };
}
/** "We took out what looked like a card number and a code before sending." */
export const removedText = (kinds: Removed[]): string =>
  kinds.length ? `We took out what looked like ${kinds.map((k) => REMOVED_WORDS[k]).join(' and ').replace(/ and (?=[^]* and )/g, ', ')} before sending. The helper never needs one.` : '';

// ---- When a person should take over -------------------------------------------------------------------------
// The helper offers a person by itself for these, and the dialog then shows the hand-over above the answer. The
// model is told the same list, but this does not depend on it: the server decides from the words of the conversation.
export type HandOver = 'not_me' | 'security' | 'locked' | 'money' | 'legal' | 'person' | 'upset' | 'again';
const SIGNS: [HandOver, RegExp][] = [
  ['not_me', /\b(did ?n[o']?t sign|never signed|not me|was ?n[o']?t me|someone (?:else )?signed|signed (?:in|on|under) my (?:name|behalf)|forg(?:ed|ery|ing)|fake signature|impersonat\w*|dispute\w*|identity theft)\b/],
  ['security', /\b(hack\w*|phish\w*|scam\w*|breach\w*|stolen|compromised|suspicious|fraud\w*|malware|virus|someone (?:got|logged|signed) into|security (?:problem|issue|hole|bug|flaw)|vulnerab\w*|leak(?:ed)?)\b/],
  ['locked', /\b(locked out|lock(?:ed)? me out|(?:cannot|can ?not|can'?t|unable to|could ?n[o']?t) (?:log|sign) ?in|lost (?:my )?(?:phone|authenticator|recovery codes?)|two[- ]step|2fa|account (?:is |was |got )?(?:locked|blocked|suspended|paused|closed)|reset (?:link|email) (?:does ?n[o']?t|never|did ?n[o']?t))\b/],
  ['money', /\b(refund\w*|charged|overcharg\w*|double[- ]?charg\w*|chargeback|billed|money back|my money|owe[sd]?|i paid|we paid|paid for|unknown charge|(?:a|the|this|that) charge|charge on my|taken from my|took my money)\b/],
  ['legal', /\b(legal\w*|lawyer\w*|attorney\w*|court\w*|sue|suing|lawsuit|enforceab\w*|binding|hold up|stand up|admissible|validity|(?:signature|document|contract|agreement|it|this|that) (?:is |be |still )?valid|gdpr|hipaa|notar\w*|liab\w*|jurisdiction)\b/],
  // Advice on whether to sign, or on what a document says, is legal advice too.
  ['legal', /\b(should (?:i|we) (?:sign|accept|agree)|(?:is it|would it be) (?:safe|wise|ok|okay|a good idea|smart|risky) to (?:sign|accept|agree)|(?:do|would) you (?:recommend|advise)|qualified (?:electronic )?signatures?|advanced (?:electronic )?signatures?|eidas|esign act|ueta|what does (?:this|the|that|my) (?:clause|contract|nda|agreement|term|section) mean|(?:nda|contract|agreement|clause|terms) (?:is |look |looks |seem |seems )?(?:fair|safe|standard|normal|ok|okay)\b)/],
  ['person', /\b(human|real person|someone real|(?:human|live|support|real) agent|representative|(?:talk|speak|chat) (?:to|with) (?:someone|somebody|a person|a human|you|support)|customer service|support team|call me)\b/],
  ['upset', /\b(angry|furious|ridiculous|terrible|horrible|awful|worst|useless|pathetic|disgust\w*|unacceptable|fed up|sick of|outrage\w*|wtf|damn|shit\w*|fuck\w*|crap|stupid|hate|scammed)\b|!!|\?\?\?/],
  // The most common words for the same in French, German, Spanish, Portuguese and Italian. Other languages, and other
  // words, rely on the model, which is told the same list.
  ['not_me', /(?<!\p{L})(pas sign\p{L}*|jamais sign\p{L}*|nicht unterschrieben|nie unterschrieben|no (?:he|lo|la) firmad[oa]|nunca firm\p{L}*|não assinei|nunca assinei|non ho firmato|mai firmato|falsifi\p{L}*|gefälscht)(?!\p{L})/u],
  ['money', /(?<!\p{L})(rembours\p{L}*|(?:rück)?erstattung|geld zurück|abgebucht|reembols\p{L}*|rimbors\p{L}*|cobr(?:ó|o|aron|ado|ada)|prélev\p{L}*|débit(?:é|ée))(?!\p{L})/u],
  ['legal', /(?<!\p{L})(valables?|valides?|juridique\p{L}*|avocat\p{L}*|tribunal|tribunaux|contraignant\p{L}*|gültig|rechtsgültig|rechtlich\p{L}*|rechtsverbindlich|verbindlich|anwalt|anwältin|gericht\p{L}*|válid[ao]s?|valid[ao]s?|legalmente|jur[ií]dic\p{L}*|abogad[ao]s?|advogad[ao]s?|avvocat[oi]|tribunale|vinculante|vincolante|dois-je signer|soll ich unterschreiben|debo firmar|devo assinar|devo firmare)(?!\p{L})/u],
];
const NOT_HELPED = /\b(did ?n[o']?t help|not help\w*|does ?n[o']?t (?:help|work)|did ?n[o']?t work|still (?:not|does|doesn|can|cannot|have|the same|no)|not what i (?:asked|meant)|wrong|no[,.!]? (?:that|it)|that'?s not|you (?:do not|don'?t) (?:understand|get it)|not (?:true|right|correct)|again)\b/;
export type ChatTurn = { role: 'user' | 'assistant'; content: string };
const shouting = (s: string) => {
  const letters = s.replace(/[^A-Za-z]/g, '');
  return letters.length >= 12 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7;
};
/** Why a person should take over, from the latest question and what came before it, or null. */
export function handOverReason(turns: ChatTurn[]): HandOver | null {
  const users = turns.filter((t) => t.role === 'user');
  const last = users[users.length - 1]?.content || '';
  const text = last.toLowerCase().replace(/[’‘]/g, "'");
  for (const [why, re] of SIGNS) if (re.test(text)) return why;
  if (shouting(last)) return 'upset';
  // A second answer that did not help: two answers given, and the person says the latest did not.
  const answers = turns.filter((t) => t.role === 'assistant' && t.content.trim()).length;
  if (answers >= 2 && NOT_HELPED.test(text)) return 'again';
  // The same question asked a third time.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (users.length >= 3 && users.filter((u) => norm(u.content) === norm(last)).length >= 3) return 'again';
  return null;
}
/** What the dialog says above the button when it offers a person by itself. */
export const HAND_OVER_TEXT: Record<HandOver, string> = {
  not_me: 'If someone signed in your name, a person should look at it now. You can also choose "I did not sign this, or this was not me" on the signing page or on Check an email: that marks the document as disputed and deletes nothing.',
  security: 'A security problem goes to a person. Tell them what you saw. Do not send passwords or codes, not even to us.',
  locked: 'Being locked out is something a person can sort out with you. The form works without signing in.',
  money: 'Money is something a person should check. The helper cannot see or change payments. A person can, and they answer in writing.',
  legal: 'The helper gives no legal advice: it cannot say whether you should sign something, or whether a signature is enough for your document. A person can tell you what GrowSigning does. A lawyer can tell you what that means where you are.',
  person: 'Of course. A person reads every message and answers by email.',
  upset: 'Sorry this has been hard. A person can take it from here.',
  again: 'This is not getting you anywhere, sorry. A person can take it from here.',
};
/** The topic the contact form starts on, so the request goes to the right queue at once. */
export function handOverTopic(why: HandOver | null, screen: ChatScreen, lastQuestion = ''): string {
  if (why === 'not_me') return 'not-me';
  if (why === 'security') return 'suspicious';
  if (why === 'locked') return 'cannot-log-in';
  if (why === 'money') return /charged|overcharg|double|taken|unknown charge|did ?n[o']?t (?:buy|order)|after (?:i )?cancel/i.test(lastQuestion) ? 'charged-wrongly' : 'billing';
  if (screen === 'signing') return 'signing';
  if (screen === 'editor') return 'sending';
  if (screen === 'plan') return 'billing';
  return 'other';
}

// ---- The tools that exist -----------------------------------------------------------------------------------
// The helper takes no action. It names these, and the dialog shows a button for each one that fits the question.
// `read`: the link opens something to read, not a tool that does something, and its button says so ("Read: ...").
// `page`: what the link is about is a control of the signing page itself, so on that page the dialog offers the
// control (the `acts` of an answer) and not a link away from it.
export type ChatTool = { id: string; label: string; href: string; what: string; words: RegExp; read?: boolean; page?: boolean };
export const CHAT_TOOLS: ChatTool[] = [
  { id: 'find-documents', label: 'Find my documents', href: '/help#find-documents', what: 'emails a link to every document sent to an address: waiting, signed or completed. Works without an account.',
    words: /\b(lost|cannot find|can'?t find|could ?n[o']?t find|missing|link|resend|send (?:it|me) again|where is my (?:document|link|copy|contract|email)|copy|deleted the email|never got)\b/ },
  { id: 'find-subscription', label: 'Find my subscription', href: '/help#find-subscription', what: 'emails every paid plan tied to an address, each with a link that stops it without logging in.',
    words: /\b(subscription|cancel\w*|stop (?:paying|billing|the plan)|renew\w*|charge\w*|unknown charge)\b/ },
  { id: 'stop-by-card', label: 'Stop billing with my card', href: '/help#stop-by-card', what: 'stops a plan with the last four digits of the card and the account email, or the date and amount of a charge. For someone who no longer has the mailbox.',
    words: /\b(card|no longer have|lost access|old (?:job|email)|charge\w*|stop billing|cannot log ?in)\b/ },
  { id: 'check', label: 'Check an email', href: '/check', what: 'tells whether an email from us is real, from the 12 character security code near its bottom, before anything in it is clicked.',
    words: /\b(scam\w*|real|genuine|phish\w*|suspicious|fake|security code|is this (?:email|request)|really from|did not expect|unexpected)\b/ },
  { id: 'verify', label: 'Verify a document', href: '/verify', what: 'tells whether a PDF is unchanged since signing finished here, or looks up a printed copy by its envelope ID. It does not say who was behind each signature.',
    words: /\b(verify|unchanged|tamper\w*|authentic|fingerprint|original|changed since|printed copy|envelope id)\b/ },
  { id: 'fix-name', label: 'Fix my name', href: '/help#while-signing', read: true, page: true, what: 'on the signing page: tap your name where the document shows it, or choose Other actions and Pass to someone else, where "Not spelled right? Fix my name" is. It is also in the step "Check your name", which opens at Finish when the name typed for the signature is not the name on the document. A small slip is corrected at once; anything more is sent to the sender to confirm.',
    words: /\b(my name|name (?:is )?(?:wrong|spelled|misspel\w*)|misspel\w*|typo in my name|spelling)\b/ },
  { id: 'more-time', label: 'Ask for more time', href: '/help#more-time', read: true, page: true, what: 'on the signing page: "Ask the sender for more time", under Other actions, or on the page a passed deadline shows. The sender decides.',
    words: /\b(expired|deadline|more time|ran out|too late|extend\w*|extension|closed before)\b/ },
  { id: 'refunds', label: 'The refund rule', href: '/help#refunds', read: true, what: 'the whole refund rule, and where the button is (Settings, Plan).', words: /\b(refund\w*|money back)\b/ },
  { id: 'cancel', label: 'How to cancel', href: '/help#cancel', read: true, what: 'the three ways to stop a plan: one button on the Plan page, the stop link in payment emails, and the two tools without logging in.', words: /\b(cancel\w*|stop (?:the )?plan|unsubscribe)\b/ },
  { id: 'locked-out', label: 'I cannot log in', href: '/help#locked-out', read: true, what: 'resetting a password, a lost authenticator phone, a login made with Google or Microsoft.', words: /\b(log ?in|sign ?in|password|locked|two[- ]step|2fa|authenticator)\b/ },
  { id: 'not-me', label: 'I did not sign this', href: '/help#not-me', read: true, what: 'what to do when you are named on a document you did not sign.', words: /\b(did ?n[o']?t sign|never signed|not me|forg\w+|dispute\w*)\b/ },
  { id: 'security', label: 'Security and trust', href: '/security', read: true, what: 'who can see documents, where the data is, what is deleted and what is kept.', words: /\b(who can see|privacy|private|data|stored|where.*(?:data|server)|encrypt\w*|delet\w*|gdpr)\b/ },
  { id: 'pricing', label: 'Pricing', href: '/pricing', read: true, what: 'the prices and the rules on when signatures expire.', words: /\b(price\w*|pricing|cost\w*|how much|expensive)\b/ },
];
/**
 * The tools that fit a question, then those the answer names, at most three. A link that only opens reading is
 * labelled "Read: ...", so no button looks like it does something it does not. On the signing page nothing about a
 * price or a plan is offered, nor a link to read about a control that is on that very page.
 */
export function toolsFor(question: string, answer = '', screen: ChatScreen = 'public'): { id: string; label: string; href: string }[] {
  const low = (s: string) => String(s || '').toLowerCase().replace(/[’‘]/g, "'");
  const q = low(question), a = low(answer);
  const SENDER_ONLY = ['pricing', 'find-subscription', 'stop-by-card', 'refunds', 'cancel'];
  // Signed in to an account, "they never got it" is about the people someone sent to: Find my documents is for a
  // person looking for their own. And "the order people sign in" is not about logging in.
  const sender = screen === 'app' || screen === 'editor' || screen === 'plan';
  const fits = CHAT_TOOLS.filter((x) =>
    (screen !== 'signing' || (!x.page && !SENDER_ONLY.includes(x.id))) &&
    !(sender && x.id === 'find-documents' && !/\b(?:my signing link|sent to me|i signed|i was sent)\b/.test(q)) &&
    !(x.id === 'locked-out' && /\border\b/.test(q)));
  const hit = [...fits.filter((x) => x.words.test(q)), ...fits.filter((x) => !x.words.test(q) && a.includes(x.label.toLowerCase()))];
  return hit.slice(0, 3).map(({ id, label, href, read }) => ({ id, label: read ? `Read: ${label}` : label, href }));
}
/** Only these addresses are ever made into links in an answer. Anything else a model writes stays plain text. */
export const CHAT_LINKABLE = new Set(['/help', '/check', '/verify', '/security', '/security/processing', '/security/certificate', ...CHAT_TOOLS.map((t) => t.href)]);

// ---- The conversation, attached to a help request -----------------------------------------------------------
// What the person sees before they send it, and what the people who answer read. `sig` is what the server signed
// when it gave an answer, so the people who answer can tell an answer the helper really gave from one typed in.
export type ChatLine = { from: 'you' | 'helper'; text: string; sig?: string };
export type AttachedLine = { from: 'you' | 'helper'; text: string; checked: boolean };
