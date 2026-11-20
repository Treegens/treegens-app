// Reading text the way a person reads it, to find fake payment notices ("your PayPal order, call this number"): the
// classic way e-signature services get abused. Nothing here touches the database: text in, findings out. Which
// accounts are checked, and what is read, is decided in envelopes.ts (fakeNotice).

// Letters from other alphabets and letter-like signs that look like ours count as ours. Each pair is a look-alike
// and the letter it reads as. The list is long but not complete, which is why a word that mixes our letters with
// letters we do not know is read with those as "any letter" (see plain).
const ALIKE = new Map<string, string>(('АA ВB ЕE КK МM НH ОO РP СC ТT УY ХX ЅS ІI ЈJ ԚQ ԜW ҮY Ӏl аa еe оo рp сc уy хx ѕs іi јj ԁd һh ӏl ԛq ԝw ѵv кk мm тt вb нh гr пn ьb үy ҽe өo ѳo '
  + 'ΑA ΒB ΕE ΖZ ΗH ΙI ΚK ΜM ΝN ΟO ΡP ΤT ΥY ΧX αa εe ιi κk νv οo ρp τt υu ϲc ϳj γy χx ωw μu ηn βb σo ςs '
  + 'օo ոn սu հh յj ցg զq աw ռn քp ՕO ՏS ԼL ՍU '
  + 'ɑa ɐa ıi ȷj ɡg ɩi ɪi ʟl ɴn ʀr ʏy ᴀa ʙb ᴄc ᴅd ᴇe ꜰf ɢg ʜh ᴊj ᴋk ᴍm ᴏo ᴘp ꜱs ᴛt ᴜu ᴠv ᴡw ᴢz ƅb łl øo đd ħh ƚl ɫl ɭl ǀl ƿp þp ɵo ɛe ʋv ɱm ɾr ɍr '
  + 'ᏢP ᎪA ᎩY ᏞL ᎷM Ꭵi ᏟC ᎡR ᏚS ᎢT ᏃZ ᎬE ᏴB ᎻH ᎫJ ᏦK ᏀG ᏙV ᏔW ᎠD').split(' ').map((p) => [...p] as [string, string]));
// Stands for a letter we could not read, inside a word that is otherwise in our alphabet.
const ANY = '\u0001';

/** Text as the eye reads it: accents, full-width and styled letters flattened, invisible characters dropped, look-alikes read as our letters, all in small letters. */
export function plain(s: any): string {
  return String(s ?? '').normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(/[^\x00-\x7f]/gu, (ch) => ALIKE.get(ch) ?? ch)
    .replace(/(?<=[a-z])I+/g, (m) => 'l'.repeat(m.length)) // a capital I after a small letter reads as a small L: "PayPaI"
    .toLowerCase()
    // A word that mixes our letters with a letter we have no look-alike for ("Micr" + something + "soft") is read
    // with that letter standing for any letter. A word wholly in another alphabet is left alone.
    .replace(/[\p{L}\p{N}]+/gu, (w) => (/[a-z]/.test(w) && /[^\x00-\x7f]/.test(w) ? w.replace(/[^\x00-\x7f]/gu, ANY) : w));
}

// A brand is found whatever stands between its letters ("Pay Pal", "P-a-y-p-a-l"), whichever look-alike digit or
// sign stands in for one ("PayPa1", "Micr0soft", "Rnicrosoft"), and when it is glued to other words ("PayPalBilling",
// "MyPayPal"). Some brands are also everyday words or family names: those are told apart by what stands beside them.
const BRANDS: [name: string, everyday: boolean][] = [['PayPal', false], ['Microsoft', false], ['Coinbase', false], ['Venmo', false], ['Geek Squad', false],
  ['Norton', true], ['McAfee', true], ['Apple', true], ['Amazon', true], ['Zelle', true], ['Best Buy', true]];
const STAND_IN: Record<string, string> = { a: 'a@4', b: 'b8', e: 'e3', g: 'g9', i: 'i1!|', l: 'l1|', o: 'o0', s: 's5$', t: 't7', z: 'z2' };
const cls = (ch: string) => (ch === 'm' ? `(?:[m${ANY}]|rn)` : `[${STAND_IN[ch] || ch}${ANY}]`);
const letters = (word: string) => [...word.toLowerCase().replace(/[^a-z]/g, '')];
const BRAND_RE = BRANDS.map(([name, everyday]) => ({
  name, everyday,
  // Spelled out with something between the letters: only as a word of its own, or "seven months" would hold Venmo.
  spaced: new RegExp(`(?<![a-z${ANY}])${letters(name).map(cls).join('[^a-z0-9]{0,3}')}(?![a-z${ANY}])`, 'g'),
  // Written in one piece: also inside a longer word.
  glued: new RegExp(letters(name).map(cls).join(''), 'g'),
}));
// A look-alike spelling still has to hold real letters of the word: digits alone ("231-135", an amount) are never one.
const real = (m: string, word: string) => (m.match(/[a-z]/g) || []).length >= Math.min(3, Math.ceil(word.replace(/[^a-z]/gi, '').length / 2));

// The words a company uses beside its name. "Apple Tree Nursery" and "Sarah McAfee" are not posing as anyone.
// "Apple Billing" and "McAfee Support" are: nothing stands beside the brand but words like these.
const COMPANY_WORDS = new Set(('the of from by at via and for no reply noreply inc llc ltd co corp corporation company official team support help helpdesk desk service services customer care center centre '
  + 'billing bill bills payment payments pay account accounts invoice invoices refund refunds order orders security secure protection antivirus lifelock verification alert alerts notice notification notifications '
  + 'department dept admin online store shop id com www prime web cloud music tv tech technical renewal renewals subscription subscriptions member membership receipt receipts statement purchase purchases '
  + 'transaction transactions dispute disputes fraud claims update updates confirmation info mail email us usa uk eu global international group '
  + 'wallet card cards gift cash charge charges charged bank transfer checkout premium').split(' '));
// Small words that say nothing about who is writing: "at 12 Apple Street", "paid by Zelle".
const SMALL_WORDS = new Set('the of from by at via and for no us'.split(' '));
// Naming a program is not posing as its maker: "the Microsoft Word original is attached", "join the Microsoft Teams call".
const PROGRAMS = new Set('word excel powerpoint teams outlook onenote onedrive sharepoint visio publisher forms'.split(' '));

type Found = { brand: string; everyday: boolean; at: number; end: number; before: string; after: string; inWord: boolean };
// Every place a brand stands in a text that was read with plain(): where, and the words on either side of it.
function brandsIn(text: string): Found[] {
  const found: Found[] = [];
  for (const b of BRAND_RE) {
    for (const [re, inWord] of [[b.spaced, false], [b.glued, true]] as [RegExp, boolean][]) {
      for (const m of text.matchAll(re)) {
        if (!real(m[0], b.name)) continue;
        const at = m.index!, end = at + m[0].length;
        // Glued to other letters: the rest of that word. As a word of its own: the word before and the word after
        // (a lone letter, as in "Apple's", is passed over).
        const head = /[a-z]*$/.exec(text.slice(0, at))![0], tail = /^[a-z]*/.exec(text.slice(end))![0];
        if (inWord && !head && !tail) continue; // a word of its own: the other pattern has it
        const words = (s: string) => s.split(/[^a-z]+/).filter((w) => w.length > 1);
        found.push({ brand: b.name, everyday: b.everyday, at, end, inWord, before: inWord ? head : words(text.slice(0, at)).pop() || '', after: inWord ? tail : words(text.slice(end))[0] || '' });
      }
    }
  }
  return found;
}
const companyWord = (w: string) => COMPANY_WORDS.has(w) && !SMALL_WORDS.has(w);

/** The well-known brand a name reads like ("PayPal Billing", "PayPalSupport", "Apple Support"), or null. */
export function posesAs(name: any): string | null {
  const text = plain(name);
  for (const f of brandsIn(text)) {
    if (!f.everyday) return f.brand;
    // An everyday word or a family name poses only when nothing but company words stands beside it.
    const beside = f.inWord ? [f.before, f.after].filter(Boolean) : `${text.slice(0, f.at)} ${text.slice(f.end)}`.split(/[^a-z]+/).filter(Boolean);
    if (beside.every((w) => COMPANY_WORDS.has(w)) && !(f.inWord && beside.every((w) => SMALL_WORDS.has(w)))) return f.brand;
  }
  return null;
}

// Words about money, by their stems, in whatever look-alike spelling: invoice and invoices, billed, charge, paid.
const MONEY_STEMS = ['invoic', 'bill', 'charg', 'pay', 'paid', 'refund', 'receipt', 'purchas', 'renew', 'subscri', 'transact', 'debit', 'overdue'];
const MONEY_RE = MONEY_STEMS.map((stem) => ({ stem, re: new RegExp(`(?<![a-z${ANY}])${letters(stem).map(cls).join('')}[a-z]*`, 'g') }));
const ORDER_RE = /\border (confirmation|number)\b/;
const AMOUNT = '[$€£¥₹]\\s?\\d[\\d,.]*|\\d[\\d,.]*\\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\\b';
// A date is not a phone number: 12/11/2026, 2026-11-20.
const DATE_RE = /(?<![\d./-])\d{1,4}[./-]\d{1,2}[./-]\d{1,4}(?![./-]?\d)/g;
// Seven digits or more with at most a few signs between them, whatever the signs are: dashes of every kind, dots,
// slashes, bullets, underscores, brackets, spaces.
const PHONE_RE = /\+?\d(?:[^a-z0-9]{0,3}\d){6,}/;

function moneyIn(text: string): string | null {
  for (const { stem, re } of MONEY_RE) for (const m of text.matchAll(re)) if (real(m[0].slice(0, stem.length + 1), stem)) return m[0];
  return ORDER_RE.exec(text)?.[0] || new RegExp(AMOUNT).exec(text)?.[0] || null;
}
function phoneIn(text: string): string | null {
  const digits = text.replace(new RegExp(AMOUNT, 'g'), ' ').replace(DATE_RE, ' ')
    // A letter O or a small L written among digits is read as the digit it stands for: "888 555 O142".
    .replace(/(?<=\d[^a-z0-9]{0,3})o+(?=\d)|(?<=\d)o+(?=[^a-z0-9]{0,3}\d)/g, (m) => '0'.repeat(m.length)).replace(/(?<=\d)[il|](?=\d)/g, '1');
  return PHONE_RE.exec(digits)?.[0].trim() || null;
}

/**
 * The lure itself: a well-known brand, words about money and a phone number to call, anywhere in the texts that go
 * out together. Answers what was found, so the refusal can say which words set it off, or null.
 */
export function lureIn(texts: any[]): { brand: string; money: string; phone: string } | null {
  const parts = texts.map(plain).filter(Boolean);
  let brand = '', money = '', phone = '';
  for (let p of parts) {
    const found = brandsIn(p);
    // An everyday word counts as the brand only beside a company word ("Apple Support", "Zelle payment"), and a
    // program is not its maker ("Microsoft Word").
    // A program followed by a company word is the maker's billing again: "Microsoft Teams subscription", "Microsoft
    // Outlook renewal".
    const program = (f: Found) => f.brand === 'Microsoft' && PROGRAMS.has(f.after) && !companyWord(p.slice(f.end).split(/[^a-z]+/).filter((w) => w.length > 1)[1] || '');
    brand ||= found.find((f) => (f.everyday ? companyWord(f.before) || companyWord(f.after) : !program(f)))?.brand || '';
    // The brand's own letters are not its words about money: there is "pay" in PayPal.
    for (const f of found) p = `${p.slice(0, f.at)}${' '.repeat(f.end - f.at)}${p.slice(f.end)}`;
    money ||= moneyIn(p) || '';
    phone ||= phoneIn(p) || '';
  }
  return brand && money && phone ? { brand, money: money.slice(0, 40), phone: phone.slice(0, 40) } : null;
}
