// Whether an email can leave this server for the mail provider without encryption, and what /security, the README
// and the sender's screens say about it. The server reads the same rule when it sets up the mail library
// (src/server/mail.ts), so a page cannot claim more than the server does.
//
// What it covers: one hop, from this server to the mail server named in SMTP_URL (the relay of the mail provider).
// What it does not cover: how the provider carries the email on to each recipient's mail server. That is decided by
// the provider and the recipient's side (MTA-STS, DANE, REQUIRETLS), not by this software. And it is never end to end
// encryption: the provider and the recipient's mail service can read every email.
//
// It reads the environment: server code and server components only.

type Env = Record<string, string | undefined>;

/** SMTP_REQUIRE_TLS=1: the mail library refuses to hand an email over unless the connection is encrypted first. */
export const smtpRequireTls = (env: Env = process.env): boolean => /^(1|true|yes|on)$/i.test(String(env.SMTP_REQUIRE_TLS || '').trim());

/**
 * How this server talks to its mail server. 'none': there is no mail server (SMTP_URL is not set). 'implicit': the
 * address is smtps://, encrypted from the first byte. 'required': SMTP_REQUIRE_TLS, so nothing is handed over before
 * STARTTLS has encrypted the connection. 'optional': encrypted when the mail server offers STARTTLS, otherwise not.
 */
export function mailTls(env: Env = process.env): 'none' | 'implicit' | 'required' | 'optional' {
  const url = String(env.SMTP_URL || '').trim();
  if (!url) return 'none';
  if (/^smtps:/i.test(url)) return 'implicit';
  return smtpRequireTls(env) ? 'required' : 'optional';
}

/** The certificate check of the mail server was switched off in SMTP_URL (tls.rejectUnauthorized=false). */
export const mailCertUnchecked = (env: Env = process.env): boolean => /[?&]tls\.rejectUnauthorized=(false|0)\b/i.test(String(env.SMTP_URL || ''));

const BEYOND = 'That covers the one step from this server to the mail provider. How the provider carries each email on to the recipient\'s mail server is decided by the provider and by the recipient\'s side (MTA-STS or REQUIRETLS there), not by this software. It is not end to end encryption: the mail provider and the recipient\'s mail service can read the emails, as they can every email.';

/**
 * The point on /security. `not` is true when it belongs under "What this is not". Null on a server without a mail
 * server: it sends no email, so there is nothing to say.
 */
export function mailTlsPoint(env: Env = process.env): { title: string; text: string; not: boolean } | null {
  const how = mailTls(env);
  if (how === 'none') return null;
  const cert = mailCertUnchecked(env) ? ' This server does not check the mail provider\'s certificate, so someone in between could pose as the provider.' : '';
  if (how === 'optional')
    return { not: true, title: 'Encryption on the way to our mail provider is not required here.', text: `This server hands emails to its mail provider over an encrypted connection when the provider offers one (STARTTLS), and otherwise unencrypted. The people who run it can make encryption a condition (SMTP_REQUIRE_TLS).${cert} ${BEYOND}` };
  return { not: false, title: 'Emails leave this server only over an encrypted connection.', text: `${how === 'implicit' ? 'This server talks to its mail provider over TLS from the start.' : 'This server hands an email to its mail provider only after the connection is encrypted (STARTTLS). If the provider does not offer that, the email is not handed over: it is kept and tried again, and the sender sees that it has not gone.'}${cert} ${BEYOND}` };
}

/** What a sender reads on the envelope page when the mail server would not encrypt the connection, instead of the library's words. */
export const TLS_REFUSED = 'Our mail provider\'s server did not encrypt the connection, and this server sends nothing unencrypted, so the email was not handed over. The people who run this service need to fix that';

/** The words for a mail library error, when it is that refusal. */
export const tlsRefusal = (e: any, env: Env = process.env): string | null =>
  smtpRequireTls(env) && (e?.code === 'ETLS' || /STARTTLS/i.test(String(e?.message || ''))) ? TLS_REFUSED : null;
