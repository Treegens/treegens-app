// WhatsApp and codes by phone call: the words the pages, the certificate and the server share, and (from the
// settings section down) whether this server's operator has set either of them up. WhatsApp is switched off for
// every account by WHATSAPP_OFFERED below, whatever is set: the owner's decision. Its code is kept, asleep. Plain constants and functions
// down to the settings section, safe in a 'use client' file. The settings functions read the environment: server
// code and server components only. The sending itself is in src/server/whatsapp.ts and src/server/voice.ts.

/** The tick the sender has to set before we send anyone the link by WhatsApp. It is written to the audit trail. */
export const WA_AGREE = 'They agreed to get messages about this by WhatsApp';

/** Said under the WhatsApp choice in the editor, before anyone relies on it. */
export const WA_HOW = 'We send their signing link by WhatsApp as well as email, and reminders and the finished link too. They can reply STOP.';

/** What becomes of a WhatsApp message, in the words the sender reads. "Read" is never shown: it proves nothing. */
export const WA_STATUS_WORDS: Record<string, string> = {
  queued: 'Being sent',
  sent: 'Sent',
  delivered: 'Delivered to the phone',
  failed: 'Could not be sent',
  outbox: 'Not sent: this machine only writes it to the outbox',
  stopped: 'Not sent: they replied STOP',
};
export const waStatusWord = (s: any): string => WA_STATUS_WORDS[String(s)] || 'Being sent';

/** Words a person can reply with to stop WhatsApp messages from an account, and to have them again. */
export const WA_STOP_WORDS = ['stop', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit', 'stopp', 'arret', 'arrêt', 'alto', 'pare'];
export const WA_START_WORDS = ['start', 'unstop', 'resume'];
export const isStopWord = (s: any) => WA_STOP_WORDS.includes(String(s ?? '').trim().toLowerCase().replace(/[.!]+$/, ''));
export const isStartWord = (s: any) => WA_START_WORDS.includes(String(s ?? '').trim().toLowerCase().replace(/[.!]+$/, ''));

/**
 * The message texts. With the Meta WhatsApp Business Platform the operator registers these as templates (named in
 * WHATSAPP_TEMPLATE_INVITE, _REMIND, _DONE and _DEADLINE) with three numbered blanks: {{1}} the sender, {{2}} the
 * document, {{3}} the link, each used once and in that order, and each text starts and ends with fixed words (Meta
 * does not take a template that starts or ends with a blank). Without approved templates WhatsApp does not deliver a message nobody asked for, so the
 * README prints exactly these texts for the operator to submit.
 */
export const WA_TEXTS: Record<'invite' | 'remind' | 'deadline' | 'done', string> = {
  invite: 'Hello. {sender} asked you to sign {subject} with GrowSigning. Open it here: {link} Reply STOP to get no more of these WhatsApp messages.',
  remind: 'Reminder: {sender} is waiting for you to sign {subject}. Open it here: {link} Reply STOP to get no more of these WhatsApp messages.',
  deadline: 'Closing soon: {sender} asked you to sign {subject}, and it closes soon. Open it here: {link} Reply STOP to get no more of these WhatsApp messages.',
  done: 'Complete: {sender} sent you {subject}, and it is now complete. Your copy is here: {link} Reply STOP to get no more of these WhatsApp messages.',
};
export const fillWa = (kind: keyof typeof WA_TEXTS, v: { sender: string; subject: string; link: string }) =>
  WA_TEXTS[kind].replace(/\{sender\}/g, v.sender).replace(/\{subject\}/g, v.subject).replace(/\{link\}/g, v.link);

/** The button under the code box, for a code by text message, when this server can place calls. */
export const CALL_ME = 'Call me with the code';
/** What a code by phone call shows, and what it does not. Printed on the security page when calls are on. */
export const CALL_PROVES = 'Shows that someone answered that phone line at the moment the document was opened, not who they are. It is for landlines and for people who cannot read a text: the same code, the same tries and the same limits as a code by text message.';

// ---- Settings (server only from here) ------------------------------------------------------------

type Env = Record<string, string | undefined>;
const set = (v: string | undefined) => !!(v || '').trim();

/**
 * The one switch for WhatsApp. The owner decided: no WhatsApp on any account, free or paid. While this is false,
 * whatsappProvider() is null whatever WHATSAPP_* or TWILIO_WHATSAPP_* settings an operator puts on the server, so
 * nothing offers WhatsApp, the API refuses it, nothing is ever sent and the webhook answers 404. Setting env on
 * Render cannot bring it back: only a change to this line, in code, can.
 */
export const WHATSAPP_OFFERED: boolean = false;

/** The WhatsApp settings found on this server. While WHATSAPP_OFFERED is false they are all ignored. */
export const WHATSAPP_SETTINGS = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE_INVITE', 'WHATSAPP_TEMPLATE_REMIND', 'WHATSAPP_TEMPLATE_DONE',
  'WHATSAPP_TEMPLATE_DEADLINE', 'WHATSAPP_TEMPLATE_LANGUAGE', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_DAILY_PER_ACCOUNT', 'WHATSAPP_DEV_OUTBOX', 'TWILIO_WHATSAPP_FROM'] as const;
export const whatsappSettingsFound = (env: Env = process.env): string[] => WHATSAPP_SETTINGS.filter((k) => set(env[k]));

/**
 * How this server sends WhatsApp messages, or null. Always null while WHATSAPP_OFFERED is false. Then WhatsApp does
 * not exist in the product: nothing offers it and the API refuses it.
 *   'meta'    WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TEMPLATE_INVITE (the Meta WhatsApp Business Platform)
 *   'twilio'  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM (a Twilio WhatsApp sender)
 *   'outbox'  WHATSAPP_DEV_OUTBOX=1 on a machine that is not production: messages are only written to the outbox
 */
export function whatsappProvider(env: Env = process.env): 'meta' | 'twilio' | 'outbox' | null {
  if (!WHATSAPP_OFFERED) return null;
  if (set(env.WHATSAPP_TOKEN) && set(env.WHATSAPP_PHONE_NUMBER_ID) && set(env.WHATSAPP_TEMPLATE_INVITE)) return 'meta';
  if (set(env.TWILIO_ACCOUNT_SID) && set(env.TWILIO_AUTH_TOKEN) && set(env.TWILIO_WHATSAPP_FROM)) return 'twilio';
  if (env.WHATSAPP_DEV_OUTBOX === '1' && (env.NODE_ENV !== 'production' || env.DEV_OUTBOX === '1')) return 'outbox';
  return null;
}

/** The most WhatsApp messages one account can cause in 24 hours (WHATSAPP_DAILY_PER_ACCOUNT, default 100). 0 lets none through. */
export const waDailyPerAccount = (env: Env = process.env): number => {
  const n = Number((env.WHATSAPP_DAILY_PER_ACCOUNT ?? '').trim() === '' ? NaN : env.WHATSAPP_DAILY_PER_ACCOUNT);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 100;
};

/**
 * Whether this server can call a number and read a code: VOICE_ENABLED=1 with Twilio (TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN and TWILIO_FROM, a number that can make calls), or the outbox on a machine that is not
 * production (with SMS_DEV_OUTBOX=1, since a call stands in for a text). A call counts against the same daily limit
 * as text messages.
 */
export function voiceProvider(env: Env = process.env): 'twilio' | 'outbox' | null {
  if (env.VOICE_ENABLED !== '1') return null;
  if (set(env.TWILIO_ACCOUNT_SID) && set(env.TWILIO_AUTH_TOKEN) && set(env.TWILIO_FROM)) return 'twilio';
  if (env.SMS_DEV_OUTBOX === '1' && (env.NODE_ENV !== 'production' || env.DEV_OUTBOX === '1')) return 'outbox';
  return null;
}

/** Said once when a server starts with WhatsApp settings (they are ignored) or calls half set up, or null. */
export function channelsWarning(env: Env = process.env): string | null {
  const out: string[] = [];
  const found = whatsappSettingsFound(env);
  if (!WHATSAPP_OFFERED && found.length) out.push(`[config] WHATSAPP SETTINGS ARE IGNORED (found: ${found.join(', ')}). GrowSigning offers WhatsApp to no account, free or paid, and nothing is sent by WhatsApp whatever is set. You can remove these settings.`);
  const meta = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE_INVITE'].filter((k) => set(env[k]));
  if (WHATSAPP_OFFERED && meta.length && meta.length < 3 && whatsappProvider(env) !== 'twilio') out.push(`[config] WHATSAPP IS SWITCHED OFF, because the Meta settings are incomplete (found: ${meta.join(', ')}). It needs WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TEMPLATE_INVITE.`);
  if (whatsappProvider(env) === 'meta' && !set(env.WHATSAPP_APP_SECRET)) out.push('[config] WHATSAPP_APP_SECRET is not set, so replies (STOP) and delivery reports from WhatsApp cannot be checked and are refused. Set it, or nobody can stop the messages by replying.');
  if (env.VOICE_ENABLED === '1' && !voiceProvider(env)) out.push('[config] VOICE_ENABLED=1 IS IGNORED, because calls need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (a number that can make calls).');
  return out.length ? `\n${out.join('\n')}\n` : null;
}
