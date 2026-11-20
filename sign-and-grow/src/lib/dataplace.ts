// Where this server keeps data, and who else handles it. /security prints it in the block "Where your data is" and
// /security/processing prints it again in the data processing summary. Both read this one function, and the function
// reads the same settings the server runs on, so the pages cannot say something the server is not doing: a provider
// is listed because its switch is on (a mail server is set, payments are connected), not because someone remembered
// to write it down.
//
// What the software cannot know is where the machine stands and who the companies are. The operator states that in
// settings. Whatever they have not stated is said out loud as "not said, ask them", never left out, because silence
// on a page like this reads as "nothing to see".
//
// It reads the environment: server code and server components only.
import { signInProviders } from './signin.ts';
import { smsProvider } from './checks.ts';

type Env = Record<string, string | undefined>;
const val = (v: string | undefined): string | null => (v || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;

/** What a page prints in place of something the operator has not stated. `what` finishes the sentence. */
export const notSaid = (what: string): string => `The operator of this server has not said ${what}. Ask them.`;

export type Processor = {
  id: 'host' | 'mail' | 'payments' | 'google' | 'microsoft' | 'sms';
  /** The company, or null when the operator has not named it. */
  name: string | null;
  /** The country it handles the data in, or null when the operator has not stated it. */
  country: string | null;
  /** What it does for this server. */
  purpose: string;
  /** What reaches it. */
  data: string;
  /** Whose data, and when: so nobody reads "Google" and thinks their signers are sent there. */
  who: string;
  /** The sentences for what is not stated, ready to print. Empty when everything is. */
  missing: string[];
};

export type DataPlace = {
  /** Who runs this server, as they state it: a name and a country. A signed agreement is with them. */
  operator: string | null;
  /** Where the server and its files are, for example "Frankfurt, Germany". */
  region: string | null;
  /** The company whose machines it runs on. */
  host: string | null;
  /** Whether and where backups are kept, in the operator's words. */
  backups: string | null;
  /** Everyone else who handles data, in the order they matter. Only those whose switch is on. */
  processors: Processor[];
  /** Providers that are off on this server, in words, so their absence is a statement too. */
  off: string[];
  /** Every "not said" sentence on the page, in one list. Empty means the operator has stated everything asked for. */
  unstated: string[];
};

/**
 * Settings (all optional, all plain text that is printed as written):
 *   OPERATOR_NAME            who runs this server: legal name and country
 *   DATA_REGION              where the server and its files are: city or region, and country
 *   DATA_HOST                the hosting company
 *   DATA_BACKUPS             whether and where backups are kept, and for how long
 *   MAIL_PROVIDER_NAME, MAIL_PROVIDER_COUNTRY        the company behind SMTP_URL and where it handles email
 *   PAYMENT_PROVIDER_COUNTRY                         which Stripe company the account is with, and its country
 *   SMS_PROVIDER_NAME, SMS_PROVIDER_COUNTRY          the text message provider (the name is known when it is Twilio)
 */
export function dataPlace(env: Env = process.env): DataPlace {
  const operator = val(env.OPERATOR_NAME);
  const region = val(env.DATA_REGION);
  const host = val(env.DATA_HOST);
  const backups = val(env.DATA_BACKUPS);
  const processors: Processor[] = [];
  const off: string[] = [];
  const need = (v: string | null, what: string) => (v ? [] : [notSaid(what)]);

  processors.push({
    id: 'host', name: host, country: region,
    purpose: 'Runs the server and stores the database and every file.',
    data: 'Everything: documents, signed PDFs, signatures, names, email addresses, internet addresses, audit trails and our copies of emails.',
    who: 'Everyone who sends or signs here.',
    missing: [...need(host, 'which company hosts it'), ...need(region, 'where it is hosted')],
  });

  if (val(env.SMTP_URL)) {
    const name = val(env.MAIL_PROVIDER_NAME), country = val(env.MAIL_PROVIDER_COUNTRY);
    processors.push({
      id: 'mail', name, country,
      purpose: 'Delivers every email this server sends.',
      data: 'The recipient\'s email address and name, the sender\'s name, the subject and the sender\'s message, the signing link, and the signed PDF when it is small enough to attach.',
      who: 'Everyone who is emailed: signers, people who get a copy, and account holders.',
      missing: [...need(name, 'which company delivers its email'), ...need(country, 'in which country its mail provider handles email')],
    });
  } else off.push('No mail server is set up on this server, so no email leaves it.');

  if (val(env.STRIPE_SECRET_KEY)) {
    const country = val(env.PAYMENT_PROVIDER_COUNTRY);
    processors.push({
      id: 'payments', name: 'Stripe', country,
      purpose: 'Takes payments, sends its own receipts and handles refunds.',
      data: 'The email address of the person who pays, the name and number of their account here, what they bought, and what they type on Stripe\'s own payment page (card, billing address, a tax number). Never a document, a signer or an audit trail. A full card number never reaches this server.',
      who: 'Only people who pay for a plan or a top-up. Signers never.',
      missing: need(country, 'which Stripe company and country its payments go through'),
    });
  } else off.push('Payments are not connected on this server, so nothing goes to a payment provider.');

  for (const p of signInProviders(env)) {
    const name = p === 'google' ? 'Google' : 'Microsoft';
    processors.push({
      id: p, name, country: `United States (head office). Which of its companies and data centres handle a sign-in depends on the person's own ${name} account.`,
      purpose: `Signs a person in who chooses "Continue with ${name}".`,
      data: `Nothing about documents. ${name} learns that the person signed in to this site, and tells us their name, their email address and its own id for them. We keep no token of theirs and call no other API of theirs.`,
      who: `Only account holders who choose to sign in with ${name}. Signers never.`,
      missing: [],
    });
  }
  if (!signInProviders(env).length) off.push('Signing in with Google or Microsoft is switched off on this server.');

  const sms = smsProvider(env);
  if (sms === 'twilio' || sms === 'hook') {
    const name = sms === 'twilio' ? 'Twilio' : val(env.SMS_PROVIDER_NAME), country = val(env.SMS_PROVIDER_COUNTRY);
    processors.push({
      id: 'sms', name, country,
      purpose: 'Delivers text messages: a one-time code, or a notice with a link, when the sender chose that for a signer.',
      data: 'The mobile number the sender typed for that signer, and the text of the message.',
      who: 'Only signers whose sender asked for a text message.',
      missing: [...need(name, 'which company delivers its text messages'), ...need(country, 'in which country its text message provider handles text messages')],
    });
  } else off.push('Text messages are switched off on this server, so no phone number goes to a text message provider.');

  const unstated = [...need(operator, 'who they are'), ...processors.flatMap((p) => p.missing), ...need(backups, 'whether and where backups are kept')];
  return { operator, region, host, backups, processors, off, unstated };
}

/** Logged once when a production server starts with nothing stated, because the security page then says so to everyone. */
export function dataPlaceWarning(env: Env = process.env): string | null {
  if (env.NODE_ENV !== 'production') return null;
  const d = dataPlace(env);
  if (!d.unstated.length) return null;
  return `\n[config] The page /security tells visitors what you have not stated about where data is: ${d.unstated.length} thing${d.unstated.length === 1 ? '' : 's'}. Set OPERATOR_NAME, DATA_REGION, DATA_HOST and DATA_BACKUPS${val(env.SMTP_URL) ? ', MAIL_PROVIDER_NAME and MAIL_PROVIDER_COUNTRY' : ''}${val(env.STRIPE_SECRET_KEY) ? ', PAYMENT_PROVIDER_COUNTRY' : ''} (see .env.example). Until then the page says: "${d.unstated[0]}"\n`;
}
