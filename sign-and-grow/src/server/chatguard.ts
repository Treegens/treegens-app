// What the help chat's model may never say, put right at the end of its answer (src/server/chat.ts, relay): that a
// signature or a document is valid, binding or enforceable or will hold up in court, and a refund promised. The
// model is told both in its instructions (src/server/chatkb.ts); this is the backstop for when it says them anyway.
//
// How it reads: each claim is looked for anywhere in the answer, and is left alone only when the words just before
// it, in the same part of the sentence (after the last full stop, comma, colon or "but"), take it back: "not",
// "never", "whether", "cannot say", "if" and the like. So "Nobody can say whether it is valid" stays as it is, and
// "I'm not a lawyer, but yes, it will hold up in court" is corrected. A correction where none was needed only adds a
// true sentence; a claim let through is worse, so it errs on the side of correcting.
//
// The phrasings are English, with the common ones in French, German, Spanish, Portuguese and Italian. A model that
// writes the same thing another way, or in another language, gets past it: this is a backstop, not a guarantee, and
// the README says so. The correction is in English, like the rest of the screens.

export const CORRECT_VALID = 'To be clear: the helper cannot say whether a signature is valid or will hold up. That depends on the law where you are and on the kind of document. A lawyer can tell you.';
export const CORRECT_REFUND = 'To be clear: the helper cannot promise a refund. The refund rule on the help page is what counts, and anything outside it is for a person to decide.';

// Up to two words such as "fully", "legally", "definitely" between the verb and the claim.
const ADV = String.raw`(?:(?:\w+ly|100%|completely|totally|still|also|now)\s+){0,2}`;
const IS = String.raw`(?:is|are|was|were|['’]s|['’]re|will\s+be|would\s+be|should\s+be|shall\s+be|remains?|stays?)`;
const NOT_L = String.raw`(?<!\p{L})`, END_L = String.raw`(?!\p{L})`;

const VALID_CLAIMS: RegExp[] = [
  // "is valid", "it's fully enforceable", "are legally binding", "is admissible"
  new RegExp(String.raw`\b${IS}\s+${ADV}(?:valid|binding|enforceable|admissible|legally\s+(?:valid|binding|enforceable|recogni[sz]ed|sound))\b`, 'giu'),
  // "a legally binding contract", "legally valid", "fully enforceable"
  /\blegally\s+(?:valid|binding|enforceable|recogni[sz]ed)\b/giu,
  /\b(?:fully|completely|perfectly|100%)\s+(?:valid|binding|enforceable|legal)\b/giu,
  // "will hold up", "would stand up in court", "holds up in court"
  new RegExp(String.raw`\b(?:will|would|does|do|should|shall|can)\s+${ADV}(?:hold|stand)\s+up\b`, 'giu'),
  /\b(?:holds?|stands?)\s+up\s+in\s+(?:a\s+|any\s+|the\s+)?courts?\b/giu,
  // "a court will accept it", "courts would recognise it", "it will be accepted in court"
  new RegExp(String.raw`\bcourts?\s+(?:will|would|must|shall|can)\s+${ADV}(?:accept|recogni[sz]e|uphold|enforce)\b`, 'giu'),
  new RegExp(String.raw`\b(?:will|would)\s+be\s+${ADV}(?:accepted|recogni[sz]ed|upheld|enforced)\s+(?:by|in)\s+(?:a\s+|any\s+|the\s+)?courts?\b`, 'giu'),
  // "any judge would accept it", "good in court", "counts as a real signature", "signatures are legal in the US"
  new RegExp(String.raw`\bjudges?\s+(?:will|would|must|shall|can)\s+${ADV}(?:accept|recogni[sz]e|uphold|enforce)\b`, 'giu'),
  /\b(?:good|fine|ok|okay|accepted|recogni[sz]ed)\s+in\s+(?:a\s+|any\s+|the\s+)?courts?\b/giu,
  /\bcounts?\s+as\s+(?:a\s+)?(?:real|legal|proper|valid|binding|handwritten|wet)\b/giu,
  new RegExp(String.raw`\b${IS}\s+${ADV}(?:legal|lawful)\s+(?:in|under|everywhere|worldwide|across|throughout)\b`, 'giu'),
  // "has the same legal effect as a handwritten signature"
  /\b(?:has|have|carries|carry)\s+(?:the\s+)?(?:same|full)\s+legal\s+(?:effect|force|standing|weight|validity)\b/giu,
  // French
  new RegExp(String.raw`${NOT_L}(?:est|sont|sera|seront|serait)\s+(?:\p{L}+ment\s+){0,2}(?:valables?|valides?|(?:juridiquement|légalement)\s+(?:contraignante?s?|valables?|valides?)|opposables?|recevables?)${END_L}`, 'giu'),
  // German
  new RegExp(String.raw`${NOT_L}(?:ist|sind|wird|werden|wäre|wären)\s+(?:\p{L}+\s+){0,2}?(?:gültig|rechtsgültig|wirksam|rechtswirksam|verbindlich|rechtsverbindlich|bindend|rechtskräftig)${END_L}`, 'giu'),
  new RegExp(String.raw`${NOT_L}(?:rechtsgültig|rechtsverbindlich|rechtswirksam)${END_L}`, 'giu'),
  // Spanish, Portuguese, Italian
  new RegExp(String.raw`${NOT_L}(?:es|son|será|serán|sería|é|são|seria|è|sono|sarà|sarebbe)\s+(?:\p{L}+mente\s+){0,2}(?:válid[ao]s?|valid[ao]s?|vinculantes?|vinculativ[ao]s?|vincolantes?)${END_L}`, 'giu'),
];

const YOU_WILL = String.raw`you\s*(?:['’]ll|will|shall|are\s+going\s+to|['’]re\s+going\s+to)`;
const WE_WILL = String.raw`(?:we|i)\s*(?:['’]ll|will|shall|['’]d|would|can|could|am\s+going\s+to|are\s+going\s+to|['’]m\s+going\s+to|['’]re\s+going\s+to)`;
const REFUND_CLAIMS: RegExp[] = [
  // "we'll refund you the full amount", "I will gladly refund it"
  new RegExp(String.raw`\b${WE_WILL}\s+(?:\w+\s+){0,2}?(?:refund|reimburse)\b`, 'giu'),
  // "we will issue a full refund", "I can send you your money back"
  new RegExp(String.raw`\b${WE_WILL}\s+(?:\w+\s+){0,2}?(?:issue|process|send|give|return|credit)\s+(?:you\s+)?(?:a\s+|the\s+|your\s+)?(?:\w+\s+)?(?:refund|money)\b`, 'giu'),
  // "you'll get your money back", "you will receive a full refund"
  new RegExp(String.raw`\b${YOU_WILL}\s+${ADV}(?:get|receive|be\s+(?:given|sent|issued))\s+(?:\w+\s+){0,3}?(?:refund|money\s+back|reimburse\w*)`, 'giu'),
  // "you will be refunded in full"
  new RegExp(String.raw`\b${YOU_WILL}\s+${ADV}be\s+${ADV}(?:refunded|reimbursed|credited|paid\s+back)\b`, 'giu'),
  // "you are entitled to a full refund", "you're eligible for a refund"
  new RegExp(String.raw`\byou\s*(?:are|['’]re)\s+${ADV}(?:entitled|eligible|guaranteed|owed|due)\s+(?:to\s+|for\s+)?(?:a\s+|the\s+|your\s+)?(?:\w+\s+)?refund`, 'giu'),
  // "your refund has been processed", "the refund is approved"
  new RegExp(String.raw`\brefund\s+(?:is|has\s+been|was|will\s+be|['’]s\s+been)\s+${ADV}(?:approved|guaranteed|on\s+its\s+way|processed|issued|granted|confirmed|sent|completed?|coming|done)\b`, 'giu'),
  // "I have issued a refund", "we've refunded you"
  new RegExp(String.raw`\b(?:i|we)\s*(?:have|['’]ve)\s+${ADV}(?:issued|processed|sent|started|initiated|approved|made|arranged|requested)\s+(?:a|the|your)\s+(?:\w+\s+)?refund`, 'giu'),
  new RegExp(String.raw`\b(?:i|we)\s*(?:have|['’]ve)\s+${ADV}(?:refunded|reimbursed|credited)\b`, 'giu'),
  // "your money will be returned", "the money has been sent back", "the money will be back on your card"
  new RegExp(String.raw`\bmoney\s+(?:will\s+be|is\s+being|has\s+been)\s+${ADV}(?:returned|refunded|sent\s+back|back\b)`, 'giu'),
  // French, German, Spanish, Portuguese, Italian: "vous serez remboursé", "wir erstatten", "le reembolsaremos"
  new RegExp(String.raw`${NOT_L}(?:vous\s+serez\s+(?:intégralement\s+)?rembours|nous\s+vous\s+rembourserons|vous\s+recevrez\s+(?:un\s+)?remboursement|remboursement\s+(?:est|a\s+été)\s+(?:effectué|approuvé|validé|accordé))`, 'giu'),
  new RegExp(String.raw`${NOT_L}(?:wir\s+erstatten|sie\s+erhalten\s+(?:ihr\s+geld|eine\s+(?:volle\s+)?(?:rück)?erstattung)|wird\s+(?:ihnen\s+)?(?:vollständig\s+)?(?:zurück)?erstattet|erstattung\s+(?:ist|wurde)\s+(?:genehmigt|veranlasst|bearbeitet))`, 'giu'),
  new RegExp(String.raw`${NOT_L}(?:le\s+reembolsaremos|recibirá\s+(?:un\s+)?reembolso|será\s+reembolsad[ao]|reembolso\s+(?:ha\s+sido|está)\s+(?:aprobado|procesado)|você\s+(?:será\s+reembolsad[ao]|receberá\s+(?:um\s+)?reembolso)|verrà\s+rimborsat[ao]|riceverà\s+(?:un\s+)?rimborso)`, 'giu'),
];

// The words that take a claim back when they come just before it, or inside it ("we will not refund").
const TAKES_BACK = new RegExp(
  String.raw`(?:${NOT_L}(?:not|never|no|nobody|noone|none|cannot|unless|whether|if|uncertain|unclear|doubtful|ne|pas|jamais|aucun|nicht|kein\p{L}*|nie|niemand|ob|nunca|nadie|não|nao|ninguém|non|mai|nessuno)${END_L}|n['’]t${END_L})`,
  'iu',
);
// "No doubt", "no problem" and "no worries" say yes, not no.
const SAYS_YES = /\bno\s+(?:doubt|question|problem|worries|worry)\b/giu;
// Where a part of a sentence begins.
const CLAUSE_START = /[.;:!?,\n]|\b(?:but|however|although|aber|mais|pero|mas|ma|però|doch)\b/giu;

// "Your code is valid for 10 minutes" and "the link is valid until the document closes" say how long something works,
// not what a signature is worth in law. "Is valid" is left alone when its subject, just before it, is one of these and
// nothing legal is named with it. "It is valid for a lease" has no such subject and is corrected.
const WORKS_FOR = String.raw`(?:link|links|code|codes|address|addresses|card|cards|password|passwords|voucher|coupon|offer|price|prices|session|invitation|invitations|reset)`;
const ABOUT_THING = new RegExp(String.raw`\b${WORKS_FOR}\b[^.;:!?\n]{0,40}$`, 'iu');
const LEGAL_THING = /\b(?:signatures?|signed|documents?|contracts?|agreements?|courts?|legal\w*|law|binding|enforceable|hold|stand)\b/iu;

function claimed(answer: string, list: RegExp[]): boolean {
  for (const re of list) {
    re.lastIndex = 0;
    for (const m of answer.matchAll(re)) {
      const before = answer.slice(Math.max(0, m.index - 200), m.index);
      let from = 0;
      for (const b of before.matchAll(CLAUSE_START)) from = b.index + b[0].length;
      const clause = `${before.slice(from)}${m[0]}`.replace(SAYS_YES, ' ');
      if (TAKES_BACK.test(clause)) continue;
      const head = before.slice(from);
      if (/valid$/iu.test(m[0]) && ABOUT_THING.test(head) && !LEGAL_THING.test(`${head} ${m[0]}`)) continue;
      return true;
    }
  }
  return false;
}

/** The correcting lines an answer needs, in order: none when it claims neither. */
export function backstop(answer: string): string[] {
  const text = String(answer || '');
  const out: string[] = [];
  if (claimed(text, VALID_CLAIMS)) out.push(CORRECT_VALID);
  if (claimed(text, REFUND_CLAIMS)) out.push(CORRECT_REFUND);
  return out;
}
