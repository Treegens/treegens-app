// A link to the sender's own payment page, shown to a signer after they press Finish ("Pay the deposit"). For a
// deposit, a retainer or a fee that is due when a document is signed, without a second tool and without Sign&Grow
// taking any part in the money. The server keeps it in src/server/routes-paylink.ts. Plain constants and functions
// with no environment in them, so the editor, the envelope page, the signing page and the server all quote them.
//
// Why it is guarded the way it is: a Pay button from somebody nobody knows is what scammers want. So it is offered
// only to an account that has earned trust (a payment that is old enough, or a person's word: hasNotPaid in
// src/server/envelopes.ts), it is checked again every time it would be shown, it only ever appears after Finish, it
// names the sender and the full address it opens, and it is never put in an email.

/** What the button says. A fixed short list: wording a sender types could imitate a bank or a bill. */
export const PAY_KINDS: Record<string, string> = { deposit: 'Pay the deposit', retainer: 'Pay the retainer', fee: 'Pay the fee', payment: 'Make the payment' };
export const payLabel = (kind: any): string => PAY_KINDS[String(kind)] || PAY_KINDS.deposit;
/** The longest address that is accepted. A real payment link is far shorter. */
export const PAY_URL_MAX = 500;

// Hosts that name no place on the public internet, or that hide where a link really goes.
const LOCAL = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example|onion)$/i;

/**
 * Checks an address a sender pasted and returns it as the browser will open it, with the host on its own, or what
 * is wrong with it in a sentence. `ownHost` is this server's own host name: a Pay button that leads back to us
 * would look like ours.
 */
export function checkPayUrl(raw: any, ownHost = ''): { href: string; host: string } | { error: string } {
  const s = String(raw ?? '').trim();
  const no = (why: string) => ({ error: `${why} Nothing was saved.` });
  if (!s) return no('Paste the address of your own payment page, starting with https://.');
  if (s.length > PAY_URL_MAX) return no(`That address is ${s.length} characters long, and the most that fits is ${PAY_URL_MAX}. Use the short link your payment provider gives you.`);
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
  if (!host.includes('.') || LOCAL.test(host)) return no(`"${host}" is not a site on the public internet, so a signer could not open it.`);
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(host.split('.').pop() || '')) return no(`"${host}" does not end in a real domain ending, such as .com or .org.`);
  const own = String(ownHost || '').toLowerCase();
  if (own && (host === own || host.endsWith(`.${own}`))) return no('That address leads to Sign&Grow itself. Use the address of your own payment page.');
  return { href: u.href, host };
}

/** What a signer reads above the button. The sender's name comes from their account, never from the link. */
export const payForSigner = (sender: string): string =>
  `${sender} asks you to pay here, on their own payment page. You have already finished: your signature does not depend on this payment, and it stays signed whether you pay now, later or not at all.`;
/** What a signer reads below the button. */
export const payNotUs = (sender: string): string =>
  `Sign&Grow takes no part in this payment. We do not see what you pay, cannot confirm that it was paid and cannot refund it. Questions about it go to ${sender}. If you did not expect to pay ${sender} anything, do not pay: ask them first, or report this request.`;
/** What a sender reads where they set it. */
export const PAY_FOR_SENDER = 'For a deposit, a retainer or a fee that is due when the document is signed. After they press Finish, each person who signs sees a button to this address, with your name and the full address on it. It is never put in our emails. Sign&Grow takes no part in the payment and cannot tell you whether anyone paid: your payment provider can.';
/** Why an account is not offered it yet. */
export const payNotYet = (trustDays: number): string =>
  `A link to your own payment page can be shown to signers once your account has a payment for the plan or a top-up that is at least ${trustDays} days old and was not refunded or disputed, or once a person on the Sign&Grow team has cleared it. That is because a Pay button from an account nobody knows yet is what scammers want.`;
