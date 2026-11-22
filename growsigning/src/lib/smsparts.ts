// How many parts a text message is sent as, counted the way phone networks count them. A text in the GSM 7-bit
// alphabet (plain English letters, digits, most punctuation) holds 160 characters, or 153 a part when it is longer.
// One character outside that alphabet (an accented letter it lacks, Arabic, Amharic, an emoji) sends the whole text
// as UCS-2: 70 characters, or 67 a part when it is longer, counted in UTF-16 units, so an emoji is two. A provider
// bills, and our daily limit counts, every part. Plain functions with no environment, so a screen may say it too.

// The GSM 03.38 default alphabet, and its extension table, whose characters take two places (an escape and the sign).
const BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const EXTENDED = '^{}\\[~]|€\f';
const basic = new Set([...BASIC]);
const extended = new Set([...EXTENDED]);

export type TextParts = { encoding: 'gsm7' | 'ucs2'; units: number; parts: number };

/** The encoding of a text, how many places it takes in that encoding, and how many parts it is sent as. */
export function textParts(text: string): TextParts {
  const s = String(text ?? '');
  let units = 0;
  let gsm = true;
  for (const c of s) {
    if (basic.has(c)) units += 1;
    else if (extended.has(c)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: 'gsm7', units, parts: units <= 160 ? 1 : Math.ceil(units / 153) };
  const u16 = s.length; // UTF-16 code units: a character beyond the first plane (an emoji) is two
  return { encoding: 'ucs2', units: u16, parts: u16 <= 70 ? 1 : Math.ceil(u16 / 67) };
}

// Typographic signs that phones, Word and Mac put in by themselves (a curly apostrophe in "Jo’s lease", a long dash,
// three dots as one sign) are outside the GSM alphabet, so one of them would send the whole text as UCS-2, at two or
// three times the parts. Our texts swap them for the plain sign that looks the same before they are counted and sent,
// as text message providers advise. Letters are never changed: a name in Arabic or with a letter GSM lacks stays as written.
const PLAIN: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'", '\u00B4': "'", '`': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"', '\u2033': '"', '\u00AB': '"', '\u00BB': '"',
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u2026': '...', '\u00A0': ' ', '\u2007': ' ', '\u2009': ' ', '\u202F': ' ', '\u200B': '', '\u2022': '*',
};
const TYPOGRAPHIC = new RegExp(`[${Object.keys(PLAIN).join('')}]`, 'g');

/** `text` with typographic quotes, dashes, dots and spaces swapped for their plain GSM equivalents. */
export const plainSigns = (text: string): string => String(text ?? '').replace(TYPOGRAPHIC, (c) => PLAIN[c]);

/** How many parts `text` is sent as once its typographic signs are made plain, which is how our texts go out. */
export const sentParts = (text: string): number => textParts(plainSigns(text)).parts;
