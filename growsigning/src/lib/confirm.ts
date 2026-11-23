// Confirming the email address of a new login with a 6-digit code, typed in the tab the person signed up in.
// The rules the server keeps (src/server/confirmcode.ts) and the words the app shows (src/components/ConfirmEmail.tsx)
// come from here, so both say the same.

/** Digits in a code. */
export const CONFIRM_CODE_DIGITS = 6;
/** How long a code works after it was emailed. The button in the email keeps working after that. */
export const CONFIRM_CODE_HOURS = 24;
/**
 * Wrong codes that may be typed for one login in all, over every code it was sent, and for one email address within
 * CONFIRM_ADDRESS_DAYS over every login made with it (so deleting the login and signing up again gives no new
 * guesses). After that no code works and only the button in the email confirms the address. With a million possible
 * codes, that leaves someone who made a login with another person's address 1 chance in 100,000 in that time.
 */
export const CONFIRM_CODE_MAX_WRONG = 10;
/** How long the wrong codes typed for an address are remembered after the first of them. */
export const CONFIRM_ADDRESS_DAYS = 30;
/** Wrong codes in one minute before the box asks for a pause, so a slip of the hand does not use up all of them. */
export const CONFIRM_CODE_PER_MINUTE = 5;

/**
 * How the refusal to send from an unconfirmed address begins. The review step of the editor knows it by these words
 * and shows the code box in its place (src/components/ConfirmEmail.tsx, ConfirmToSend).
 */
export const CONFIRM_BEFORE_SEND = 'Confirm your email address before you send.';

// A digit typed on a keyboard in another script (Arabic-Indic, Persian, Devanagari and so on) is the digit it stands
// for. Every such script lists its ten digits in one row from zero up, so the place in the row is the value.
const ND = /\p{Nd}/u;
function asciiDigit(ch: string): string {
  let cp = ch.codePointAt(0)!;
  let steps = 0;
  while (steps < 10 && ND.test(String.fromCodePoint(cp - 1))) (cp--, steps++);
  return String(steps % 10);
}

/**
 * The digits of what was typed: spaces, dashes and dots that people copy along with a code are dropped, and digits
 * typed full-width or in another script become 0 to 9.
 */
export function cleanCode(typed: unknown): string {
  return String(typed ?? '').slice(0, 60).normalize('NFKC').replace(/[\s.\-\u2010-\u2015]/g, '').replace(/[^\x00-\x7f]/gu, (ch) => (ND.test(ch) ? asciiDigit(ch) : ch)).slice(0, 20);
}

/** "482915" as it is shown in the email, "482 915", so it is easy to read and to type. */
export const showCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** Why a code was not taken, in words that say what to do next. The server answers with the key in `code`. */
export const CODE_REFUSED = {
  code_format: `Type the ${CONFIRM_CODE_DIGITS} digits of the code in our email.`,
  code_wrong: 'That code is not right. Check the newest email from us and type its 6 digits. Each new code replaces the one before.',
  code_old: 'That code has run out. Press "Send a new code" and type the code from the new email.',
  code_closed: 'Too many wrong codes were typed, so codes no longer work for this login. Press the button in our email instead, in this browser.',
  code_wait: 'Too many tries in one minute. Wait a minute, then type the code again: it still works. Or press the button in our email instead.',
} as const;
export type CodeRefusal = keyof typeof CODE_REFUSED;
