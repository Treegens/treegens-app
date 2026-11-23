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
  kept: (name: string) => `This device keeps the document and ${name}'s part, locked with a PIN you choose, for up to ${OFFLINE_DAYS} days. It is wiped once it is sent, or when you remove it. Nothing is signed until the device has signal again.`,
  /** A device keeps one person's part at a time: said when it already holds one. */
  replaces: 'This device already holds a document for someone to sign in person. A device keeps one person at a time, so getting this one ready replaces it.',
  /** The heading after Finish on the device. Nothing is signed before the server has it. */
  savedTitle: 'Saved on this device',
  /** The line under it, and while it waits. */
  waiting: 'It is sent when the device has signal again. Nothing is signed until then.',
  /** Both together, for a line on its own. */
  saved: 'Saved on this device. It is sent when the device has signal again. Nothing is signed until then.',
  /** The line once the server has it. */
  sent: (name: string) => `Sent. ${name} has signed, and the copy on this device is wiped.`,
  /**
   * Said above the consent words on the device: what is recorded, and when, when nobody can reach GrowSigning while
   * the person signs. The consent words themselves stay as they are recorded (their version), and this says how they apply.
   */
  consentNote: (host: string) => `You sign on ${host}'s device without a connection. Its own clock is recorded, and it is not checked. When the device has signal again, GrowSigning records when it receives your signature, and the IP address of the network the device uses then. Decline stops here: nothing is signed and nothing is sent.`,
  /** The page could not be kept to open without signal (a browser that does not keep it, private browsing). */
  notKept: 'This device could not keep this page to open without signal. Keep this page open until you meet the person: closing it or reloading it with no signal does not bring it back.',
  /** What the record and the certificate say. `ts` writes a moment; the default is "22 November 2026 at 14:03 UTC". */
  record: (deviceAt: string | null, received: string, ts: (s: string) => string = at) =>
    `Signed in person on the host's device without a connection. ${deviceAt ? `The device's clock said ${ts(deviceAt)}; this was not checked.` : 'The device did not say what its clock said.'} The server received it at ${ts(received)}.`,
  unknown: (name: string) => `This copy for ${name} is not known to GrowSigning, so nothing was signed. Open the document with a connection and let ${name} sign there.`,
  ended: (name: string, why: string) => `This copy for ${name} had ended, so nothing was signed.${why ? ` ${why}` : ''} Open the document with a connection and let ${name} sign there.`,
  tooOld: (name: string) => `This copy for ${name} was more than ${OFFLINE_DAYS} days old, so nothing was signed. Open the document with a connection and let ${name} sign again.`,
  closed: (name: string) => `The document is no longer open for ${name}, so nothing was signed. Open the document with a connection to see why.`,
  changed: (name: string) => `Nothing was signed for ${name}, because the document was changed after it was kept on this device. Open the document with a connection and let ${name} sign it again.`,
  /**
   * The server refused it for another reason (an answer it does not take, say). The copy stays on the device, so the
   * person can look again while they are there, or the host removes it.
   */
  keptAfterRefusal: (name: string) => `The copy is still on this device. If ${name} is with you, let them change their part and finish again. If not, remove it, and let ${name} sign with a connection.`,
};
