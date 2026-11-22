// A link to the sender's own payment page, shown to a signer after they press Finish ("Pay the deposit"). For a
// deposit, a retainer or a fee that is due when a document is signed, without a second tool and without GrowSigning
// taking any part in the money. The server keeps it in src/server/routes-paylink.ts. Plain constants and functions
// with no environment in them (but payNotYet, which asks BILLING_MODE where it can read it), so the editor, the envelope page, the signing page and the server all quote them.
//
// Why it is guarded the way it is: a Pay button from somebody nobody knows is what scammers want. So it is offered
// only to an account that has earned trust (a payment that is old enough, or a person's word: hasNotPaid in
// src/server/envelopes.ts), it is checked again every time it would be shown, it only ever appears after Finish, it
// names the person whose payment page it is and the full address it opens, and the address is never put in an email,
// a certificate, an export or a webhook: the audit trail names it by a fingerprint (payPrint in src/server/paydrop.ts).
// It belongs to the person who set it, so it goes when they leave the team. Nobody on the sender's own team is asked.
import { isDeploymentBilling } from './billingmode.ts';

/** What the button says. A fixed short list: wording a sender types could imitate a bank or a bill. */
export const PAY_KINDS: Record<string, string> = { deposit: 'Pay the deposit', retainer: 'Pay the retainer', fee: 'Pay the fee', payment: 'Make the payment' };
export const payLabel = (kind: any): string => PAY_KINDS[String(kind)] || PAY_KINDS.deposit;
/** The longest address that is accepted, counted the way the browser opens it (a letter outside the basic Latin alphabet is written out as up to 6 characters there). A real payment link is far shorter. */
export const PAY_URL_MAX = 500;

// Hosts that name no place on the public internet: names kept for private networks and for tests.
const LOCAL = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|arpa|alt|corp|private|test|invalid|example|onion)$/i;
// Services whose whole job is to answer with the address written in the name: 192.168.1.1.nip.io is the signer's own
// router. Only the name is read here. Where a name really leads is asked of the DNS on the server, when the link is
// saved and again each time it would be shown (src/server/paydns.ts), which also catches the ones not listed.
const ANSWERS_ANYTHING = ['nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me', 'vcap.me', 'traefik.me', 'localho.st', 'fuf.me', 'local.gd'];
/**
 * Link shorteners and forwarding services. An address on one of them shows one name and sends people on to another,
 * so the name on the button would not be where the money goes. Refused, with every name under them. A payment
 * provider's own short links (square.link, paypal.me) stay allowed: they lead to that provider's own pages.
 */
export const PAY_SHORTENERS = ['bit.ly', 'bitly.com', 'j.mp', 'tinyurl.com', 'tiny.cc', 'tiny.one', 't.co', 't.ly', 'goo.gl', 'g.co', 'ow.ly', 'is.gd', 'v.gd',
  'buff.ly', 'rebrand.ly', 'rb.gy', 'cutt.ly', 'shorturl.at', 'short.gy', 's.id', 'bl.ink', 'lnkd.in', 'fb.me', 'l.facebook.com', 'lm.facebook.com',
  'l.instagram.com', 'l.messenger.com', 'href.li', 'adf.ly', 'shorte.st', 'trib.al', 'dlvr.it', 'ift.tt', 'qr.ae', 'soo.gd', 'clck.ru', 'u.to', 'vk.cc',
  'surl.li', 'tr.im', 'x.co', 'po.st', 'mcaf.ee', 'su.pr', 'db.tt', 'amzn.to', 'wp.me', 'gg.gg', 'urlz.fr', '2.gp', 'chilp.it', 'out.reddit.com',
  'outgoing.prod.mozaws.net', 'urldefense.com', 'urldefense.proofpoint.com', 'safelinks.protection.outlook.com', 'slack-redir.net', 'exit.sc', 'away.vk.com'];
// Big sites with a page whose only job is to send people on to an address written in the link (www.google.com/url).
const FORWARDS: [RegExp, RegExp][] = [
  [/^(www\.)?google\.[a-z.]+$/, /^\/(url|amp\/)/], [/^(www\.|m\.)?youtube\.com$/, /^\/redirect/], [/^(www\.|m\.)?facebook\.com$/, /^\/(l|flx\/warn)/],
  [/^(www\.)?bing\.com$/, /^\/ck\//], [/^(www\.)?duckduckgo\.com$/, /^\/l\//], [/^(www\.)?vk\.com$/, /^\/away/], [/^steamcommunity\.com$/, /^\/linkfilter/], [/^t\.umblr\.com$/, /^\/redirect/],
];
const under = (host: string, list: string[]) => list.find((d) => host === d || host.endsWith(`.${d}`));

/**
 * Checks an address a sender pasted and returns it as the browser will open it, with the host on its own, or what
 * is wrong with it in a sentence. `ownHost` is this server's own host name: a Pay button that leads back to us
 * would look like ours.
 */
export function checkPayUrl(raw: any, ownHost = ''): { href: string; host: string } | { error: string } {
  const s = String(raw ?? '').trim();
  const no = (why: string) => ({ error: `${why} Nothing was saved.` });
  if (!s) return no('Paste the address of your own payment page, starting with https://.');
  if (s.length > PAY_URL_MAX) return no(`That address is ${s.length} characters long, and the most that fits is ${PAY_URL_MAX}. Use the address your payment provider gives you for this page, with nothing added to it.`);
  // Spaces and invisible characters are where a second address hides. A browser would quietly drop some of them.
  if (/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/.test(s)) return no('That address has a space or an invisible character in it. Copy it again from your payment provider.');
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return no('That is not a web address. It should look like https://pay.example.com/your-page.');
  }
  if (u.protocol !== 'https:') return no('The address has to start with https://, so the page is protected on the way. Payment providers always give one.');
  // https://yourbank.com@other.site opens other.site. Nobody needs a name or a password in a payment link.
  if (u.username || u.password) return no('That address has a name or a password in front of the @ sign, which makes it open a different site than it seems to. Use the plain address of your payment page.');
  if (u.port) return no(`That address names a port (:${u.port}). Payment pages do not need one: use the address without it.`);
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[')) return no('That address is a number instead of a name. Use the address with the name of your payment provider or your own site in it.');
  if (!host.includes('.') || LOCAL.test(host) || under(host, ANSWERS_ANYTHING)) return no(`"${host}" is not a site on the public internet, so a signer could not open it.`);
  // Letters, digits and hyphens only, in parts of up to 63: "*" or "_" make a name no browser opens as a site.
  if (host.length > 253 || !host.split('.').every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return no(`"${host}" is not a name a site can have. Copy the address again from your payment provider.`);
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(host.split('.').pop() || '')) return no(`"${host}" does not end in a real domain ending, such as .com or .org.`);
  const own = String(ownHost || '').toLowerCase();
  if (own && (host === own || host.endsWith(`.${own}`))) return no('That address leads to GrowSigning itself. Use the address of your own payment page.');
  // The button names the host it opens. A shortener or a forwarding page would make that name a lie.
  const fwd = under(host, PAY_SHORTENERS) || (FORWARDS.some(([h, p]) => h.test(host) && p.test(u.pathname)) ? `${host}${u.pathname}` : '');
  if (fwd) return no(`"${fwd}" is a link shortener or a forwarding page: it shows one name and sends people on to another, so a signer could not see where they would pay. Use the full address of the payment page itself, as your payment provider gives it.`);
  // Counted again the way it is stored and shown: 470 Cyrillic letters are 494 typed characters and 2844 written out.
  if (u.href.length > PAY_URL_MAX) return no(`Written out the way a browser opens it, that address is ${u.href.length} characters long (a letter outside the basic Latin alphabet takes up to 6), and the most that fits is ${PAY_URL_MAX}. Use the address your payment provider gives you for this page.`);
  return { href: u.href, host };
}

/**
 * An audit line about a payment link as the certificate prints it. Lines are named by a fingerprint since 2026-11-20,
 * but lines written before that held the address, and the certificate is emailed: there the address is left out.
 */
export const payLineForPrint = (action: string, detail: string): string =>
  /payment link/i.test(action) ? String(detail).replace(/https?:\/\/[^\s"()]+?(?=[\s"()]|[.,](?:\s|$)|$)/gi, '[the address, kept on the document page]') : detail;

/** What a signer reads above the button. The sender's name comes from their account, never from the link. */
export const payForSigner = (sender: string): string =>
  `${sender} asks you to pay here, on their own payment page. You have already finished: your signature does not depend on this payment, and it stays signed whether you pay now, later or not at all.`;
/** What a signer reads with the address. A page can send people on to another page, and that cannot be checked from here. */
export const payWhere = (sender: string): string =>
  `The button opens exactly this address. GrowSigning does not check where that site sends you after that: before you pay, check that the page asking for money belongs to ${sender}.`;
/** What a signer reads when where the payment page leads could not be checked just now (a slow or failing lookup). */
export const payLater = (sender: string): string =>
  `${sender} also asks for a payment after signing, on their own payment page. We could not check where that page leads just now, so it is not shown yet. Open this page again in a few minutes. You have already finished, and your signature does not depend on it.`;
/** What a signer reads below the button. */
export const payNotUs = (sender: string): string =>
  `GrowSigning takes no part in this payment. We do not see what you pay, cannot confirm that it was paid and cannot refund it. Questions about it go to ${sender}. If you did not expect to pay ${sender} anything, do not pay: ask them first, or report this request.`;
/** What a sender reads where they set it. */
export const PAY_FOR_SENDER = 'For a deposit, a retainer or a fee that is due when the document is signed. After they press Finish, each person who signs sees a button to this address, with your name and the full address on it. Nobody on your own team is asked to pay. The address is never put in our emails, certificates or exports. The button opens exactly this address, and GrowSigning does not check where that page sends people next, so give the address of the payment page itself, not a short link. The link is yours: if you leave the team, it is taken off. GrowSigning takes no part in the payment and cannot tell you whether anyone paid: your payment provider can.';
/** Why an account is not offered it yet. */
export const payNotYet = (trustDays: number, deployment = isDeploymentBilling()): string => deployment
  // A server run under a government agreement takes no payments, so only a person can clear an account there.
  ? 'A link to your own payment page can be shown to signers once a person who runs this server has cleared your account. That is because a Pay button from an account nobody knows yet is what scammers want.'
  : `A link to your own payment page can be shown to signers once your account has a payment for the plan or a top-up that is at least ${trustDays} days old and was not refunded or disputed, or once a person on the GrowSigning team has cleared it. That is because a Pay button from an account nobody knows yet is what scammers want.`;
