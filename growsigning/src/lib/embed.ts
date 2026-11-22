// Signing inside a customer's own website, and the sender's screen inside their app: the numbers and words that the
// server (src/server/embed.ts), Settings and the pages share.

/** How many websites an account may let show its signing pages and its sender screen. */
export const EMBED_ORIGINS_MAX = 5;
/** How long a link to the sender screen can be opened, once, after it was made. */
export const SENDER_VIEW_MINUTES = 5;
/** How long the sender screen works once it is open. It ends earlier when the draft is sent or the screen is closed. */
export const SENDER_SESSION_MINUTES = 60;

/** The messages a page in a frame sends to the website around it, and nothing else. */
export const FRAME_EVENTS = ['signing_complete', 'declined', 'saved', 'sent', 'closed'] as const;
export type FrameEvent = (typeof FRAME_EVENTS)[number];

/**
 * A website address reduced to what a browser compares: "https://portal.example.org" (with a port when it has one).
 * Anything else gives the reason in `why`. Only https, except http://localhost for trying it out.
 */
export function readOrigin(raw: unknown): { origin: string } | { why: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { why: 'Type the address of your website, such as https://portal.example.org.' };
  if (s.includes('*')) return { why: 'A star is not allowed. Add each website by its own address, such as https://portal.example.org.' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { why: 'That is not a website address. Type it with https:// in front, such as https://portal.example.org.' };
  }
  const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (u.protocol !== 'https:' && !local) return { why: 'The address has to start with https://. Websites without it cannot be added.' };
  if (u.username || u.password) return { why: 'The address has a name or a password in it. Type only https:// and the name of the website.' };
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { why: `Type only the website, without a page: ${u.origin}.` };
  if (s.length > 200) return { why: 'That address is longer than 200 characters. Type a shorter one.' };
  return { origin: u.origin.toLowerCase() };
}

/**
 * What an admin types in Settings, read kindly: "portal.example.org" is taken as https://portal.example.org (https is
 * the only kind a real website may use), and the address of a page is cut to its website. `note` says so, to be
 * shown in place. The API reads origins strictly with readOrigin().
 */
export function readTypedOrigin(raw: unknown): { origin: string; note?: string } | { why: string } {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (s && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !s.includes('*')) s = `https://${s.replace(/^\/+/, '')}`;
  let cut = '';
  try {
    const u = new URL(s);
    if (!u.username && !u.password && ((u.pathname && u.pathname !== '/') || u.search || u.hash)) {
      cut = u.origin;
      s = u.origin;
    }
  } catch {
    // Not an address at all: readOrigin says so in its own words.
  }
  const o = readOrigin(s);
  if ('why' in o) return o;
  return cut ? { origin: o.origin, note: `Added ${o.origin}, the website without the page.` } : o;
}

/** What Settings says under the card, and the developers page repeats. */
export const EMBED_SAYS = 'Your website can show the signing page and the sender screen inside its own pages. Only the websites listed here can, and only for links your app asks for through the API.';
/** What it does not do, said where it is set up. */
export const EMBED_NOT = 'It does not prove who the signer is: your website decides who it shows the page to. The signing record names the website the page was shown on.';

/**
 * Why a signing link for a frame is not made for someone with an access code or a one-time code: inside a frame on
 * another website the browser keeps nothing, so the page cannot remember that the code was typed.
 */
export const FRAME_NO_CODES = 'This person has an access code or a one-time code to type before the document opens, and a code cannot be typed inside a frame on another website: the browser does not let the page remember it. Ask for the link without "frame_origin" and open it in its own tab or window, or remove the code from this person.';
/** What the signing page says when a code was right but the frame forgot it (a code added after the link was made). */
export const FRAME_CODE_LOST = 'Your code was right, but this page cannot keep it while it is shown inside another website. Open the document in its own tab and type the code there. It is the same document.';
