// Click-to-agree ("clickwrap"): terms a website's visitors accept with one click, and a record of who accepted which
// version and when. The server is src/server/clickwrap.ts (rules) and src/server/routes-clickwrap.ts (routes). Plain
// constants and functions with no environment in them, so the hosted page, the team's screens, the certificate, the
// emails and the server all say the same words. The monthly limit is in src/lib/policy.ts.

/** The longest terms written as text, in characters. A PDF is limited like any upload. */
export const TERMS_MAX_CHARS = 100_000;
export const NAME_MAX = 120;
export const LABEL_MAX = 200;
export const NOTE_MAX = 500;
export const DEFAULT_CHECKBOX = 'I have read these terms and I agree to them.';
export const DEFAULT_BUTTON = 'I agree';
/** How long a link the website signed may stay valid, at most. A link that has leaked can be used until then. */
export const WHO_MAX_DAYS = 30;
/** How long the terms may have stood open on a page before the press is refused and the page has to be loaded again. */
export const VIEW_MAX_HOURS = 24;

/** How a person's details came to us: signed by the website, typed by the visitor, or sent by the website's server. */
export type Identity = 'website' | 'typed' | 'api';
export type Via = 'hosted' | 'embed' | 'api';

export const IDENTITY_LABEL: Record<Identity, string> = {
  website: 'Given by the website in a signed link',
  typed: 'Typed by the visitor, not checked',
  api: 'Sent by the website through the API',
};
export const VIA_LABEL: Record<Via, string> = { hosted: 'Our page for these terms', embed: 'Shown inside a frame on another website', api: 'Recorded by the website through the API' };

/** The state of terms on the team's screens: not published, taking acceptances, closed by the team, or stopped for a reason the team is told. */
export const STATE_LABEL: Record<string, string> = { draft: 'Draft', live: 'Taking acceptances', closed: 'Closed', stopped: 'Not taking acceptances' };

/** What an acceptance is not, said on the team's screens and in the README. */
export const NOT_A_SIGNATURE = 'An acceptance is not a signature and uses none of your signatures. There is a monthly limit on acceptances per account instead.';

/** The line about the law, on the hosted page, the certificate and the team's screens. Never a promise that a click binds anyone. */
export const CLICK_LAW = 'Whether accepting terms with a click binds someone depends on the country, on the kind of agreement and on how the terms were shown. Rules differ, and some agreements need a signature or a particular form. Check what applies to yours.';

/** Said on the page before the click: everything the record will hold. `account` is the organisation the record is kept for. */
export function recordedBefore(identity: 'website' | 'typed', account: string): string {
  const who = identity === 'website' ? 'the name, email address and customer number the website gave us for you' : 'the name and email address you type';
  return `When you press the button, Sign&Grow records: these terms and their version, a fingerprint (SHA-256) of the exact terms on this page, ${who}, the date and time, your internet address, your browser, the page you came from, and how long the terms were open before you pressed. The record is kept for ${account || 'the organisation that wrote these terms'} and is never changed afterwards.`;
}

/** What a record shows and what it does not, by how it was made. The hosted page says the first two before the click. */
export function recordShows(identity: Identity, via: Via, embedHost = ''): { shows: string; not: string } {
  if (via === 'api' || identity === 'api')
    return { shows: 'The website recorded this acceptance itself, through the API, with the details it sent. Sign&Grow did not show these terms to the person and did not see a click: the record shows what the website said happened, and when it said so.', not: 'It does not show that the person saw the terms or pressed anything, or who that person really was.' };
  const details = identity === 'website' ? 'with the name, email address and customer number the website put in a signed link' : 'with the name and email address that were typed in';
  const where = via === 'embed' ? ` The terms were shown inside a frame on ${embedHost || 'another website'}, as the browser reported it.` : '';
  // Said as what the browser reported: Sign&Grow sees what a browser sends, never a screen or a hand.
  return { shows: `The browser that pressed reported that the box was ticked and the button pressed, on these exact terms and at this time, ${details}.${where}`, not: `It does not show who that person really was, that they read the terms, or whether a person or a program pressed. Sign&Grow did not check the name or the email address${identity === 'website' ? ': they are what the website knows about its visitor' : ''}.` };
}

/** Whether the press came from where the terms were handed out, as the certificate says it. */
export const VIEW_MATCH_LABEL: Record<string, string> = {
  same: 'The same internet address and browser that pressed the button.',
  address: 'The same browser, from another internet address. A phone that moves from wifi to its own network does this.',
  browser: 'Another browser at the same internet address.',
  both: 'Another internet address and another browser than the ones that pressed. The press did not come from where the terms were handed out; a program can do this.',
};

/** What the browser said about the button being covered, as the certificate prints it. */
export function coverLine(via: string, unobscured: number | boolean | null): string {
  if (unobscured === 1 || unobscured === true) return 'The browser reported that the whole button was in view and that nothing covered it or made it see-through, just before the press and again just after it. Only Chrome and Edge can tell this. It is what the browser sent; a program can send the same.';
  if (unobscured === 0 || unobscured === false) return 'The browser reported that the button was covered, or not wholly in view.';
  return via === 'embed' ? 'The browser in the frame did not report it. Only Chrome and Edge can tell, so the frame may have been covered or hidden without anyone noticing.'
    : 'Not checked: the terms were on our own page, not inside a frame on another website.';
}

/** What a frame on another website can and cannot guarantee, on the team's screen and in the README. */
export const EMBED_CAN = 'The box and the button are inside our frame. The page around the frame cannot tick the box or press the button with its own code, and it cannot read or change what the frame shows. Only the address that ends in ?embed=1 may be shown in a frame at all, so an acceptance through a frame is always recorded as one, with the page the browser said the frame was on.';
export const EMBED_CANNOT = 'It cannot stop the page around it from hiding the frame, making it very small or covering it with something else so a visitor presses without seeing the terms. Where the browser can tell (Chrome and Edge), the button can be pressed only while all of it is in view and nothing covers it or makes it see-through, checked just before the press and again at it, and the record says what the browser reported. A change made in the last tenth of a second before a press can still be missed, and other browsers cannot tell at all. A program can also open our page itself, so a website that holds the agreement\'s key can make acceptances that look like clicks. Only acceptances the website sends through the API are marked as recorded by the website.';

/** The parts of the signed link a website makes for a visitor, as the snippet and the developer page explain it. */
export const WHO_FIELDS: { key: string; what: string }[] = [
  { key: 'id', what: 'Your own id for the person, such as a customer number. Up to 200 characters. Give id or email, or both.' },
  { key: 'name', what: 'Their name as you have it. Optional.' },
  { key: 'email', what: 'Their email address. Optional, and needed for them to get a copy by email.' },
  { key: 'exp', what: `When the link stops working, in seconds since 1 January 1970 (Unix time, not milliseconds). Required, and at most ${WHO_MAX_DAYS} days ahead.` },
];

/** The lines a website's server runs to make the signed link, in Node. `secret` stands where the agreement's key goes. */
export const whoSnippet = (origin: string, slug: string): string => [
  "import crypto from 'node:crypto';",
  '// On your server. Never put the key in a page or an app.',
  "const who = Buffer.from(JSON.stringify({ id: customer.id, name: customer.name, email: customer.email, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');",
  "const sig = crypto.createHmac('sha256', process.env.AGREEMENT_KEY).update(who).digest('base64url');",
  `const link = \`${origin}/agree/${slug}?who=\${who}&sig=\${sig}\`;`,
].join('\n');
/** The frame to paste into a page. `query` is "who=...&sig=..." or empty. */
export const iframeSnippet = (origin: string, slug: string, query = ''): string =>
  `<iframe src="${origin}/agree/${slug}?embed=1${query ? `&${query}` : ''}" title="Terms to accept" style="width:100%;height:520px;border:0"></iframe>`;
/** The script, which makes the frame, sizes it to its content and tells the page when the visitor accepted. */
export const scriptSnippet = (origin: string, slug: string): string =>
  `<script src="${origin}/clickwrap.js" data-agreement="${slug}" data-who="WHO" data-sig="SIG" async></script>`;

// ---- Simple formatting -------------------------------------------------------------------------------------------
// Terms are written as plain text. A line that starts with "# " is a heading ("## " a smaller one), lines that start
// with "- " or "* " are a list, "1. " a numbered list, **two stars** around words make them bold, and an empty line
// starts a new paragraph. Nothing else is read: no links, no HTML, so terms cannot carry a button or a script.

export type Span = { text: string; bold?: boolean };
export type Block = { kind: 'h1' | 'h2' | 'p' | 'ul' | 'ol'; items: Span[][] };

const spans = (s: string): Span[] => s.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((p) => (/^\*\*[^*]+\*\*$/.test(p) ? { text: p.slice(2, -2), bold: true } : { text: p }));

export function termBlocks(text: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'p', items: [spans(para.join(' '))] });
    para = [];
  };
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    const ol = /^\d{1,3}[.)]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (h) (flush(), out.push({ kind: h[1].length === 1 ? 'h1' : 'h2', items: [spans(h[2])] }));
    else if (ul || ol) {
      flush();
      const kind = ul ? 'ul' : 'ol';
      const last = out[out.length - 1];
      const item = spans((ul || ol)![1]);
      if (last?.kind === kind) last.items.push(item);
      else out.push({ kind, items: [item] });
    } else if (/^\s{2,}/.test(raw) && (out[out.length - 1]?.kind === 'ul' || out[out.length - 1]?.kind === 'ol') && !para.length) {
      // An indented line under a list item carries on that item.
      const last = out[out.length - 1];
      last.items[last.items.length - 1].push({ text: ' ' }, ...spans(line));
    } else para.push(line);
  }
  flush();
  return out;
}
/** The words of the terms without the formatting marks, for the certificate's text and for the scam filter. */
export const termsPlain = (text: string): string =>
  termBlocks(text).map((b) => b.items.map((it, i) => `${b.kind === 'ul' ? '• ' : b.kind === 'ol' ? `${i + 1}. ` : ''}${it.map((s) => s.text).join('')}`).join('\n')).join('\n\n');

/** The monthly count in words, for the team's screens. */
export const usageLine = (used: number, limit: number, resets: string): string =>
  limit <= 0 ? 'This server records no acceptances at all: its operator set the monthly limit to 0.'
    : `${used} of ${limit} acceptances used this month, counted for the whole account. The count starts again on ${resets}.`;
