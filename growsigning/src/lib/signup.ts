// The rules for making an account (owner's decision, 23 November 2026): no "+" in the email address, one account per
// mailbox, and a phone number. Plain functions and constants with no side effects, so the sign-up page, the "One more
// thing" screen, the server (src/server/signuprules.ts) and the tests all read the same rule and the same words.
//
// These rules are about the person who makes an account. Signers and other recipients of a document are not touched:
// a sender may still send to an address with a + in it.
import { normalPhone } from './checks.ts';

// ---- Email -------------------------------------------------------------------------------------------

/** Whether the part before the @ has a "+" in it ("ann+work@example.com"). */
export const plusInEmail = (email: unknown): boolean => {
  const s = String(email ?? '').trim();
  const at = s.lastIndexOf('@');
  return (at < 0 ? s : s.slice(0, at)).includes('+');
};

/** Said on the page the moment a + is typed, and by the server whichever way the account is made. */
export const PLUS_REFUSAL = 'Please use your email address without the + part.';
/** The same for an invitation, said to the person who invites. */
export const PLUS_INVITE_REFUSAL = 'Please invite them at their email address without the + part. A new account cannot be made with a + in the address.';

/** Said when the mailbox already has an account under another spelling of the address. */
export const SAME_MAILBOX_REFUSAL = 'An account with this email address already exists, under a slightly different spelling of it. Sign in with that one instead.';

/**
 * One value per mailbox, so that one person has one account: small letters, nothing from a "+" on, googlemail read
 * as gmail, and no dots before the @ at Gmail (Google delivers "ann.lee" and "annlee" to the same person). Dots at
 * any other mail service are kept, because there they can be two people.
 */
export function mailboxKey(email: unknown): string {
  const s = String(email ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1) return s;
  let local = s.slice(0, at).split('+')[0];
  let domain = s.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

// ---- Phone numbers -----------------------------------------------------------------------------------

/** Why the number is asked for and what it is used for. One short line, on the form and on the pages about privacy. */
export const PHONE_WHY = 'We ask for your number to keep accounts real and to reach you about your account. It is never shared and never used for marketing calls or texts.';
/** Said when another account already has the number. */
export const PHONE_TAKEN = 'This number is already used by another account.';
/** Said to someone who has to give a number before they send. */
export const PHONE_BEFORE_SEND = 'Add your phone number before you send.';

// Country, calling code, and the fewest and most digits a number has there without the calling code and without the
// 0 people dial inside the country. The lengths are for "is this plausibly a phone number", not a full numbering plan.
const TABLE =
  'AF:93:9:9 AL:355:8:9 DZ:213:8:9 AS:1:10:10 AD:376:6:9 AO:244:9:9 AI:1:10:10 AG:1:10:10 AR:54:10:11 AM:374:8:8 AW:297:7:7 AU:61:9:9 AT:43:7:13 AZ:994:9:9 ' +
  'BS:1:10:10 BH:973:8:8 BD:880:8:10 BB:1:10:10 BY:375:9:9 BE:32:8:9 BZ:501:7:7 BJ:229:8:10 BM:1:10:10 BT:975:7:8 BO:591:8:8 BA:387:8:9 BW:267:7:8 BR:55:10:11 VG:1:10:10 BN:673:7:7 BG:359:8:9 BF:226:8:8 BI:257:8:8 ' +
  'KH:855:8:9 CM:237:9:9 CA:1:10:10 CV:238:7:7 KY:1:10:10 CF:236:8:8 TD:235:8:8 CL:56:9:9 CN:86:10:11 CO:57:8:10 KM:269:7:7 CG:242:9:9 CD:243:9:9 CK:682:5:5 CR:506:8:8 CI:225:8:10 HR:385:8:9 CU:53:8:8 CW:599:7:8 CY:357:8:8 CZ:420:9:9 ' +
  'DK:45:8:8 DJ:253:8:8 DM:1:10:10 DO:1:10:10 EC:593:8:9 EG:20:9:10 SV:503:8:8 GQ:240:9:9 ER:291:7:7 EE:372:7:8 SZ:268:8:8 ET:251:9:9 FK:500:5:5 FO:298:6:6 FJ:679:7:7 FI:358:5:12 FR:33:9:9 GF:594:9:9 PF:689:6:8 ' +
  'GA:241:7:8 GM:220:7:7 GE:995:9:9 DE:49:6:12 GH:233:9:9 GI:350:8:8 GR:30:10:10 GL:299:6:6 GD:1:10:10 GP:590:9:9 GU:1:10:10 GT:502:8:8 GN:224:9:9 GW:245:7:9 GY:592:7:7 HT:509:8:8 HN:504:8:8 HK:852:8:8 HU:36:8:9 ' +
  'IS:354:7:9 IN:91:10:10 ID:62:8:12 IR:98:10:10 IQ:964:9:10 IE:353:7:9 IL:972:8:9 IT:39:6:11 JM:1:10:10 JP:81:9:10 JO:962:8:9 KZ:7:10:10 KE:254:7:9 KI:686:5:8 XK:383:8:8 KW:965:8:8 KG:996:9:9 ' +
  'LA:856:8:10 LV:371:8:8 LB:961:7:8 LS:266:8:8 LR:231:7:9 LY:218:9:9 LI:423:7:9 LT:370:8:8 LU:352:6:11 MO:853:8:8 MG:261:9:9 MW:265:7:9 MY:60:8:10 MV:960:7:7 ML:223:8:8 MT:356:8:8 MH:692:7:7 MQ:596:9:9 MR:222:8:8 MU:230:7:8 MX:52:10:10 ' +
  'FM:691:7:7 MD:373:8:8 MC:377:8:9 MN:976:8:8 ME:382:8:8 MS:1:10:10 MA:212:9:9 MZ:258:8:9 MM:95:7:10 NA:264:8:9 NR:674:7:7 NP:977:8:10 NL:31:9:9 NC:687:6:6 NZ:64:8:10 NI:505:8:8 NE:227:8:8 NG:234:7:10 MK:389:8:8 NO:47:8:8 ' +
  'OM:968:8:8 PK:92:9:10 PW:680:7:7 PS:970:8:9 PA:507:7:8 PG:675:7:8 PY:595:9:9 PE:51:8:9 PH:63:8:10 PL:48:9:9 PT:351:9:9 PR:1:10:10 QA:974:8:8 RE:262:9:9 RO:40:9:9 RU:7:10:10 RW:250:9:9 KN:1:10:10 LC:1:10:10 VC:1:10:10 ' +
  'WS:685:5:7 SM:378:6:10 ST:239:7:7 SA:966:9:9 SN:221:9:9 RS:381:8:9 SC:248:7:7 SL:232:8:8 SG:65:8:8 SX:1:10:10 SK:421:9:9 SI:386:8:8 SB:677:5:7 SO:252:7:9 ZA:27:9:9 KR:82:8:10 SS:211:9:9 ES:34:9:9 LK:94:9:9 SD:249:9:9 SR:597:6:7 SE:46:7:10 CH:41:9:9 SY:963:8:9 ' +
  'TW:886:8:9 TJ:992:9:9 TZ:255:9:9 TH:66:8:9 TL:670:7:8 TG:228:8:8 TO:676:5:7 TT:1:10:10 TN:216:8:8 TR:90:10:10 TM:993:8:8 TC:1:10:10 TV:688:5:7 UG:256:9:9 UA:380:9:9 AE:971:8:9 GB:44:9:10 US:1:10:10 UY:598:8:8 UZ:998:9:9 ' +
  'VU:678:5:7 VE:58:10:10 VN:84:9:10 VI:1:10:10 YE:967:7:9 ZM:260:9:9 ZW:263:8:10';

export type PhoneCountry = { iso: string; dial: string; min: number; max: number };
export const PHONE_COUNTRIES: PhoneCountry[] = TABLE.split(' ').map((row) => {
  const [iso, dial, min, max] = row.split(':');
  return { iso, dial, min: Number(min), max: Number(max) };
});
const BY_ISO = new Map(PHONE_COUNTRIES.map((c) => [c.iso, c]));
export const phoneCountry = (iso: unknown): PhoneCountry | null => BY_ISO.get(String(iso ?? '').trim().toUpperCase()) || null;

// What a number looks like in the countries most accounts come from, without the calling code and the leading 0.
// Tighter than the lengths above, so a digit too many or a number that starts wrongly is caught while it is typed.
const NANP = /^[2-9]\d{2}[2-9]\d{6}$/;
const SHAPE: Record<string, RegExp> = {
  GB: /^[1-37-9]\d{8,9}$/,
  DE: /^[1-9]\d{5,11}$/,
  FR: /^[1-9]\d{8}$/,
  ES: /^[6-9]\d{8}$/,
  BR: /^[1-9]{2}(9\d{8}|[2-5]\d{7})$/,
  IN: /^[1-9]\d{9}$/,
  NG: /^([789][01]\d{8}|[1-9]\d{6,7})$/,
  KE: /^([17]\d{8}|[2-6]\d{6,8})$/,
  TR: /^[2-58]\d{9}$/,
  AE: /^(5\d{8}|[2-4679]\d{7})$/,
  AU: /^[2-478]\d{8}$/,
  IT: /^(3\d{8,9}|0\d{5,10})$/,
};
const shapeOf = (c: PhoneCountry): RegExp | null => (c.dial === '1' ? NANP : SHAPE[c.iso] || null);
// Countries where the 0 in front belongs to the number and is dialled from abroad too.
const KEEPS_ZERO = new Set(['IT', 'SM', 'CI', 'CG']);
/** A number as people write it at home, for the hint under the box. Made-up numbers from the ranges kept for examples where a country has them. */
export const PHONE_EXAMPLES: Record<string, string> = {
  US: '201 555 0123', CA: '204 555 0123', GB: '07400 123456', DE: '01512 3456789', FR: '06 12 34 56 78', ES: '612 34 56 78', BR: '11 96123 4567',
  IN: '81234 56789', NG: '0802 123 4567', KE: '0712 123456', TR: '0501 234 56 78', AE: '050 123 4567', AU: '0412 345 678',
};

export type PhoneProblem = 'empty' | 'letters' | 'country' | 'short' | 'long' | 'shape' | 'fake' | 'premium';
export type PhoneResult = { ok: true; e164: string; iso: string } | { ok: false; why: PhoneProblem; iso: string | null };

/** The countries that share a calling code, the one asked for first. */
function withDial(digits: string, prefer?: string | null): PhoneCountry[] {
  for (const n of [3, 2, 1]) {
    const hit = PHONE_COUNTRIES.filter((c) => c.dial === digits.slice(0, n));
    if (hit.length) return hit.sort((a, b) => Number(b.iso === prefer) - Number(a.iso === prefer) || Number(b.iso === 'US' || b.iso === 'RU') - Number(a.iso === 'US' || a.iso === 'RU'));
  }
  return [];
}

function fits(c: PhoneCountry, national: string): PhoneProblem | null {
  if (national.length < c.min) return 'short';
  if (national.length > c.max) return 'long';
  if (/^(\d)\1+$/.test(national)) return 'fake';
  const shape = shapeOf(c);
  return shape && !shape.test(national) ? 'shape' : null;
}

/**
 * A phone number as a person typed it, read for the country they chose, in international form ("E.164": a plus
 * sign, the calling code and the number, no spaces). Spaces, dots, dashes and brackets are forgiven, and so is the 0
 * people dial inside their country, a number typed with its calling code (with +, with 00, or bare), and "(0)".
 * A number that starts with + is read for the country of its calling code, whatever the picker says.
 */
export function parsePhone(typed: unknown, iso?: unknown): PhoneResult {
  const chosen = phoneCountry(iso);
  let s = String(typed ?? '').trim().replace(/\(0\)/g, '').replace(/[\s().\- ‐-―/]/g, '');
  if (!s) return { ok: false, why: 'empty', iso: chosen?.iso || null };
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  const international = s.startsWith('+');
  const digits = international ? s.slice(1) : s;
  if (!/^\d+$/.test(digits)) return { ok: false, why: 'letters', iso: chosen?.iso || null };
  const done = (c: PhoneCountry, national: string): PhoneResult => {
    const e164 = `+${c.dial}${national}`;
    // The same last check as for a number a document is texted to: a full international number, and not a
    // premium-rate, satellite or international network number (src/lib/checks.ts).
    return normalPhone(e164) === e164 ? { ok: true, e164, iso: c.iso } : { ok: false, why: 'premium', iso: c.iso };
  };
  if (international) {
    const group = withDial(digits, chosen?.iso);
    if (!group.length) return { ok: false, why: 'country', iso: null };
    let first: PhoneProblem | null = null;
    for (const c of group) {
      let national = digits.slice(c.dial.length);
      // "+44 (0)7400..." written without the brackets: the 0 does not belong there.
      if (!KEEPS_ZERO.has(c.iso) && national.startsWith('0')) national = national.slice(1);
      const no = fits(c, national);
      if (!no) return done(c, national);
      first ??= no;
    }
    return { ok: false, why: first || 'shape', iso: group[0].iso };
  }
  if (!chosen) return { ok: false, why: 'country', iso: null };
  const tries: string[] = [];
  if (!KEEPS_ZERO.has(chosen.iso) && digits.startsWith('0')) tries.push(digits.replace(/^0/, ''));
  else tries.push(digits);
  // Typed with the calling code but without the plus: "44 7400 123456", "1 201 555 0123", or 8 in front in Russia.
  if (digits.startsWith(chosen.dial) && digits.length > chosen.dial.length) tries.push(digits.slice(chosen.dial.length).replace(KEEPS_ZERO.has(chosen.iso) ? /^$/ : /^0/, ''));
  if (chosen.dial === '7' && digits.length === 11 && digits.startsWith('8')) tries.push(digits.slice(1));
  let first: PhoneProblem | null = null;
  for (const national of tries) {
    const no = fits(chosen, national);
    if (!no) return done(chosen, national);
    first ??= no;
  }
  return { ok: false, why: first || 'shape', iso: chosen.iso };
}

/** The country's name in the reader's language ("United Kingdom"), from the browser's or the server's own list. */
export function countryName(iso: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale, 'en'], { type: 'region' }).of(iso) || iso;
  } catch {
    return iso;
  }
}

/** What is wrong with a number, in one kind sentence. */
export function phoneProblemText(why: PhoneProblem, iso?: string | null, locale = 'en'): string {
  const c = phoneCountry(iso);
  const where = c ? countryName(c.iso, locale) : '';
  const example = c && PHONE_EXAMPLES[c.iso] ? ` For example ${PHONE_EXAMPLES[c.iso]}.` : '';
  switch (why) {
    case 'empty':
      return 'Please type your phone number.';
    case 'letters':
      return 'Please use digits only in the phone number.';
    case 'country':
      return 'Please choose your country, or start the number with + and your country code.';
    case 'short':
      return `That number is too short for ${where || 'this country'}. Please check it.${example}`;
    case 'long':
      return `That number is too long for ${where || 'this country'}. Please check it.${example}`;
    case 'fake':
      return 'That does not look like a real phone number. Please type your own.';
    case 'premium':
      return 'That is a premium-rate or special network number. Please type your own mobile or landline number.';
    default:
      return `That does not look like a phone number in ${where || 'this country'}. Please check it.${example}`;
  }
}

/**
 * The country to start the picker on: the region in the browser's languages ("en-GB" gives GB), else the likely
 * region of the first language ("de" gives DE), else the United States. Only a starting point: the person can change it.
 */
export function guessCountry(languages: readonly string[] | string | null | undefined): string {
  const list = (typeof languages === 'string' ? [languages] : [...(languages || [])]).filter(Boolean);
  const region = (tag: string, likely: boolean): string | null => {
    try {
      const l = new Intl.Locale(tag);
      const r = (likely ? l.maximize() : l).region || '';
      return BY_ISO.has(r) ? r : null;
    } catch {
      return null;
    }
  };
  for (const tag of list) {
    const r = region(tag, false);
    if (r) return r;
  }
  return (list[0] && region(list[0], true)) || 'US';
}

/** "+44 7400 123456" for a screen: the calling code, a space, the rest. Only for the person the number belongs to and for operators. */
export function showPhone(e164: unknown): string {
  const s = String(e164 ?? '');
  const c = withDial(s.replace(/^\+/, ''))[0];
  return c && s.startsWith('+') ? `+${c.dial} ${s.slice(1 + c.dial.length)}` : s;
}
