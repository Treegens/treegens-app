// Signing in person where there is no signal: the numbers and the words that the server (src/server/offlinesign.ts),
// the device (src/components/sign/offlineInPerson.ts) and the pages share. No imports beyond dates, no side effects.
import { momentText } from './dates.ts';

/** How long a copy got ready on a device may wait, in days. Then the device wipes it and the server refuses it. */
export const OFFLINE_DAYS = 7;
/** The shortest PIN a host may choose. A PIN guards the copy on the device, so a longer one is better. */
export const PIN_MIN = 6;
/** Wrong PINs in a row before the device wipes its copy. */
export const PIN_TRIES = 5;
/** Rounds of PBKDF2 (SHA-256) that make the key from the PIN: slow on purpose, so each guess costs time. */
export const PIN_ROUNDS = 600_000;

/** The fields a person can fill in on the device. Anything else needs GrowSigning to answer, so it needs a connection. */
export const OFFLINE_FIELD_TYPES = ['signature', 'initials', 'text', 'number', 'date', 'company', 'title', 'first_name', 'last_name', 'checkbox', 'radio', 'dropdown', 'date_signed', 'full_name', 'email'];

const at = (iso: string | null | undefined) => momentText(iso || null) || 'an unknown time';

/** For /help: where there will be no signal, someone who signs in person can sign on the host's device. */
export const OFFLINE_HELP = `If you will meet someone who signs in person where there is no signal, open the document in GrowSigning while you still have signal, choose More next to them, then "Get ready to sign without signal", on the device they will sign on. Nothing is signed until that device has signal again. People who sign by link need a connection.`;

export const OFFLINE_WORDS = {
  /** The menu line on the envelope page. */
  action: 'Get ready to sign without signal',
  /** What is kept on the device, and for how long, said before the PIN is chosen. */
  kept: (name: string) => `This device keeps the document, ${name}'s part and, once they finish, their signature, locked with a PIN you choose. It is wiped once it is sent, when you remove it, or after ${OFFLINE_DAYS} days.`,
  /** The line after Finish on the device. Nothing is signed before the server has it. */
  saved: 'Saved on this phone. It is sent when the phone has signal again. Nothing is signed until then.',
  /** The line once the server has it. */
  sent: (name: string) => `Sent. ${name} has signed, and the copy on this phone is wiped.`,
  /** What the record and the certificate say. `ts` writes a moment; the default is "22 November 2026 at 14:03 UTC". */
  record: (deviceAt: string | null, received: string, ts: (s: string) => string = at) =>
    `Signed in person on the host's device without a connection. ${deviceAt ? `The device's clock said ${ts(deviceAt)}; this was not checked.` : 'The device did not say what its clock said.'} The server received it at ${ts(received)}.`,
  unknown: (name: string) => `This copy for ${name} is not known to GrowSigning, so nothing was signed. Open the envelope with a connection and let ${name} sign there.`,
  ended: (name: string, why: string) => `This copy for ${name} had ended, so nothing was signed.${why ? ` ${why}` : ''} Open the envelope with a connection and let ${name} sign there.`,
  tooOld: (name: string) => `This copy for ${name} was more than ${OFFLINE_DAYS} days old, so nothing was signed. Open the envelope with a connection and let ${name} sign again.`,
  closed: (name: string) => `The envelope is no longer open for ${name}, so nothing was signed. Open the envelope with a connection to see why.`,
  changed: (name: string) => `Nothing was signed for ${name}, because the document was changed after this phone got it ready. Open the envelope with a connection and let ${name} sign it again.`,
};
