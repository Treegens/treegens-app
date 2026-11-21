// Confirming the email address of a new login with a 6-digit code, typed in the tab the person signed up in.
// The rules the server keeps (src/server/confirmcode.ts) and the words the app shows (src/components/ConfirmEmail.tsx)
// come from here, so both say the same.

/** Digits in a code. */
export const CONFIRM_CODE_DIGITS = 6;
/** How long a code works after it was emailed. The button in the email keeps working after that. */
export const CONFIRM_CODE_HOURS = 24;
/**
 * Wrong codes a login may type in all, over every code it was sent. After that no code works for it and only the
 * button in the email confirms the address. With a million possible codes, that leaves someone who made a login with
 * another person's address 1 chance in 100,000 of guessing their way in.
 */
export const CONFIRM_CODE_MAX_WRONG = 10;

/** The digits of what was typed: spaces, dashes and dots that people copy along with a code are dropped. */
export function cleanCode(typed: unknown): string {
  return String(typed ?? '').replace(/[\s.\-–—]/g, '').slice(0, 20);
}

/** "482915" as it is shown in the email, "482 915", so it is easy to read and to type. */
export const showCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** Why a code was not taken, in words that say what to do next. The server answers with the key in `code`. */
export const CODE_REFUSED = {
  code_format: `Type the ${CONFIRM_CODE_DIGITS} digits of the code in our email.`,
  code_wrong: 'That code is not right. Check the newest email from us and type its 6 digits. Each new code replaces the one before.',
  code_old: 'That code has run out. Press "Send a new code" and type the code from the new email.',
  code_closed: 'Too many wrong codes were typed, so codes no longer work for this login. Press the button in our email instead, in this browser.',
} as const;
export type CodeRefusal = keyof typeof CODE_REFUSED;
