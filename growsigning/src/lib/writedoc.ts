// Writing a document in the app ("No document yet? Write one" in editor step 1): the rules the writing view, the
// server (src/server/writedoc.ts, src/server/routes-writedoc.ts) and the tests share. Plain constants and functions
// with no environment in them, so pages and 'use client' files may import it.
//
// A document is written as plain text with the same few marks as click-to-agree terms (src/lib/clickwrap.ts): "# "
// a heading, "## " a smaller one, "- " a list, "1. " a numbered list, **two stars** bold, an empty line a new
// paragraph. Nothing else is read: no links, no HTML, no pictures, no tables. On top of that:
//   {{signature}}, {{date}}, {{name}}, {{initials}}, {{email}}, {{company}}, {{title}}, {{checkbox}}, {{text:Label}}
//     a place where the first signer signs or fills in; {{signature2}}, {{date2}} and so on for the second signer.
//     These are the tags 'Place fields for me' reads too (src/lib/autoplace.ts).
//   [a blank]  something still to fill in. The view marks it, and the document cannot be used while one is left.
import { termBlocks, type Block } from './clickwrap.ts';
import { TAG, TAG_TYPE } from './autoplace.ts';

export const WRITE_TITLE_MAX = 120;
/** The longest text a written document may have, in characters: about 12 pages. */
export const WRITE_TEXT_MAX = 30_000;
/** The longest description for 'Write it', and the longest request for 'Ask for a change', in characters. */
export const WRITE_PROMPT_MAX = 1500;
export const WRITE_CHANGE_MAX = 600;
/** A written document becomes at most this many pages. */
export const WRITE_PAGES_MAX = 20;
/** Drafts and changes the model writes for one account in a day (UTC), unless WRITE_AI_DAILY_LIMIT says otherwise. */
export const WRITE_DAILY_DEFAULT = 30;
/** The longest a draft or a change may come back, in characters. A host that ignores its token limit is cut off here. */
export const WRITE_ANSWER_MAX = 20_000;

export type Paper = 'a4' | 'letter';
export const PAPER_LABEL: Record<Paper, string> = { a4: 'A4', letter: 'Letter' };
/** Letter where the account or the browser is in North America or the Philippines and the like, A4 everywhere else. */
export const paperFor = (locale: string | null | undefined): Paper => (/-(US|CA|MX|PH|CL|CO|VE|PR|GT|CR|PA|DO|SV|NI|HN|BZ)\b/i.test(String(locale || '')) ? 'letter' : 'a4');

// ---- The words --------------------------------------------------------------------------------------------------
export const WRITE_LINK = 'No document yet? Write one';
export const WRITE_TEMPLATE_LINK = 'Write a template';
/** Said under the writing view when the header's Next is pressed before the text was made into the document. */
export const WRITE_NEXT_NUDGE = 'Press Use this document first to turn your text into the document.';
export const AI_DRAFT_NOTE = 'Drafted by an AI from what you typed. It can be wrong or leave things out, and it is not legal advice. Read every word before you send it.';
export const DRAFT_PLACEHOLDER = 'A freelance agreement: I design a logo for Sam Lee for $800, half up front, finished by 15 March';
export const CHANGE_PLACEHOLDER = 'Make payment due in 30 days';
export const CHANGE_EXAMPLES = ['Make payment due in 30 days', 'Add that either side can end it with two weeks’ notice', 'Simpler words'];
export const WHAT_IS_SIGNED = 'What everyone signs is the PDF made from this text.';
/** The one line under the box: who gets what is typed, from the chat's own provider settings. */
export const sentLine = (model: string, host: string) => `What you type here and the draft are sent to ${model} at ${host} to write it.`;
export const blanksLine = (n: number) => `Fill in or delete the ${n === 1 ? 'blank' : `${n} blanks`} first.`;
/** How a written document is described to its sender. Never on anything a signer sees. */
export const writtenLine = (ai: boolean) => (ai ? 'Written in GrowSigning, with AI help' : 'Written in GrowSigning');

// ---- Tags and blanks ---------------------------------------------------------------------------------------------
export type Tag = { start: number; end: number; type: string; signer: number; label: string };
// The signer numbers a text names, in order, counted again from 1 without gaps: a text with {{signature}} and
// {{signature9}} has two signers, not nine, so a typo or a model's odd number never adds empty rows under People.
const signerOrder = (text: string): Map<number, number> => {
  const raw = new Set<number>();
  for (const m of String(text ?? '').matchAll(new RegExp(TAG.source, 'gi'))) raw.add(Math.max(1, Number(m[2]) || 1));
  return new Map([...raw].sort((a, b) => a - b).map((n, i) => [n, i + 1]));
};
function tagsWith(text: string, order: Map<number, number>): Tag[] {
  const out: Tag[] = [];
  const re = new RegExp(TAG.source, 'gi');
  for (const m of String(text ?? '').matchAll(re)) {
    const type = TAG_TYPE[m[1].toLowerCase()];
    const raw = Math.max(1, Number(m[2]) || 1);
    out.push({ start: m.index!, end: m.index! + m[0].length, type, signer: order.get(raw) || 1, label: (m[3] || '').trim().slice(0, 120) });
  }
  return out;
}
/** The tags in a text, in order. `signer` counts from 1, the people in the order of the numbers the tags give. */
export const tagsIn = (text: string): Tag[] => tagsWith(text, signerOrder(text));
const FIELD_WORD: Record<string, string> = { signature: 'Signature', initials: 'Initials', date_signed: 'Date signed', full_name: 'Name', email: 'Email', title: 'Title', company: 'Company', checkbox: 'Tick box', text: 'Fill in' };
/** What a tag is called on its chip in the preview: "Signature, Person 2", the word step 2 uses for the same row. */
export const tagChip = (t: Pick<Tag, 'type' | 'signer' | 'label'>) => `${t.label || FIELD_WORD[t.type] || 'Field'}, Person ${t.signer}`;
/** How many people sign or fill in. */
export const signersNeeded = (text: string) => signerOrder(text).size;
/** The tags for the next person, for "Add a place to sign": a number above every number the text uses. */
export const nextPlace = (text: string) => {
  const top = Math.max(0, ...signerOrder(text).keys());
  const n = Math.min(99, top + 1);
  return n === 1 ? '{{signature}} {{date}}\n{{name}}' : `{{signature${n}}} {{date${n}}}\n{{name${n}}}`;
};

export type Blank = { start: number; end: number; label: string };
const BLANK = /\[([^[\]\n]{1,160})\]/g;
/** The [blanks] still in a text, in order. A link written the Markdown way, [words](address), is not one. */
export function blanksIn(text: string): Blank[] {
  const s = String(text ?? '');
  const out: Blank[] = [];
  for (const m of s.matchAll(BLANK)) {
    if (s[m.index! + m[0].length] === '(') continue;
    if (!m[1].trim()) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length, label: m[1].trim() });
  }
  return out;
}

// ---- The text as the preview and the PDF read it -----------------------------------------------------------------
export type Piece = { text: string; bold?: boolean; tag?: Tag; blank?: boolean };
export type WriteBlock = { kind: Block['kind']; items: Piece[][] };
// A piece of a line split where tags and blanks stand.
function pieces(text: string, order: Map<number, number>, bold?: boolean): Piece[] {
  const marks = [...tagsWith(text, order).map((t) => ({ start: t.start, end: t.end, tag: t })), ...blanksIn(text).map((b) => ({ start: b.start, end: b.end, tag: undefined as Tag | undefined }))].sort((a, b) => a.start - b.start);
  const out: Piece[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start < at) continue;
    if (m.start > at) out.push({ text: text.slice(at, m.start), ...(bold ? { bold } : {}) });
    out.push(m.tag ? { text: '', tag: m.tag } : { text: text.slice(m.start, m.end), blank: true, ...(bold ? { bold } : {}) });
    at = m.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), ...(bold ? { bold } : {}) });
  return out;
}
/** The blocks of a written document: clickwrap's headings, lists and paragraphs, with tags and blanks picked out. */
export function writeBlocks(text: string): WriteBlock[] {
  const order = signerOrder(text);
  return termBlocks(text).map((b) => ({ kind: b.kind, items: b.items.map((spans) => spans.flatMap((s) => pieces(s.text, order, s.bold))) }));
}

// ---- What the model sends back -------------------------------------------------------------------------------------
// A web address without its https:// ("evil.example/pay", "paypal-secure.com"), and an email address.
const HOST = /(?<![\w@.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|info|biz|io|co|app|dev|me|ai|xyz|online|site|shop|store|link|click|top|club|pay|money|bank|finance|live|tech|cloud|page|web|email|support|help|example|test|local|gov|edu|[a-z]{2})(?![\w-])(?:[/:?#][^\s)\]]*)?/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/**
 * The model's text made safe and plain: no fences, no HTML, no links, no web or email addresses, no pictures, no em
 * dashes. What is left is read by the same formatter as everything else, which carries no link or script anyway: this
 * takes out the words of them too, so a draft cannot print an address that is not in `typed` (what the person typed
 * in the writing view: the description, the text and the request).
 */
export function cleanModelText(raw: string, typed = ''): string {
  let s = String(raw ?? '').replace(/\r\n?/g, '\n');
  const mine = String(typed ?? '').toLowerCase();
  const keep = (m: string) => (mine && mine.includes(m.toLowerCase()) ? m : '');
  s = s.replace(/^\s*```[a-z]*\s*$/gim, '');
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\/?[a-z!][^>]*>/gi, '');
  s = s.replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, '');
  s = s.replace(/\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))+(?:\s+"[^"]*")?\)/g, '$1');
  s = s.replace(/\b(?:https?|ftp|javascript|data|vbscript|file):\/*[^\s)\]]*/gi, keep);
  s = s.replace(/\bwww\.[^\s)\]]+/gi, keep);
  s = s.replace(EMAIL, keep);
  s = s.replace(HOST, (m) => keep(m) || keep(m.replace(/[/:?#].*$/, '')));
  s = s.replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (_, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'", nbsp: ' ' } as any)[e]);
  s = s.replace(/<|>/g, '');
  s = s.replace(/\s*—\s*/g, ', ');
  s = s.replace(/[ \t]+([.,;:])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim().slice(0, WRITE_TEXT_MAX);
}

// ---- What changed --------------------------------------------------------------------------------------------------
export type DiffPart = { kind: 'same' | 'add' | 'del'; text: string };
/** Word by word: what stayed, what was added and what was taken out. Long texts compare only the middle that differs. */
export function wordDiff(a: string, b: string): DiffPart[] {
  const A = String(a ?? '').split(/(\s+)/).filter((x) => x !== ''), B = String(b ?? '').split(/(\s+)/).filter((x) => x !== '');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  push('same', A.slice(0, pre).join(''));
  if (a2.length * b2.length > 2_000_000) {
    push('del', a2.join(''));
    push('add', b2.join(''));
  } else {
    // Longest common run of words, from the end, so the walk below goes forwards.
    const n = a2.length, m = b2.length;
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) push('same', a2[i++]), j++;
      else if (L[i + 1][j] >= L[i][j + 1]) push('del', a2[i++]);
      else push('add', b2[j++]);
    }
    while (i < n) push('del', a2[i++]);
    while (j < m) push('add', b2[j++]);
  }
  push('same', A.slice(A.length - suf).join(''));
  return out;
}

// ---- Starters ------------------------------------------------------------------------------------------------------
// Short, plain and neutral: no country, no law, no promise about what they are worth. Each blank in [square brackets]
// is for the person to fill in.
export type WriteStarter = { id: string; name: string; title: string; text: string };
export const WRITE_STARTERS: WriteStarter[] = [
  {
    id: 'simple', name: 'A simple agreement between two people', title: 'Agreement',
    text: `This agreement is between [name of the first person] and [name of the second person].

## What we agree
- [What the first person will do]
- [What the second person will do]

## When
This starts on [start date] and ends on [end date].

## Money
[How much is paid, by whom and when, or "No money changes hands"]

## Ending it early
Either of us can end this agreement by telling the other in writing [number] days before.

## Signed
{{signature}} {{date}}
{{name}}

{{signature2}} {{date2}}
{{name2}}`,
  },
  {
    id: 'freelance', name: 'A freelance job', title: 'Freelance agreement',
    text: `**Client:** [client's name]

**Freelancer:** [your name]

## The work
[What you will make or do, in a few lines]

## Deadline
The work is finished by [date].

## Payment
The client pays [amount] in total: [how it is split, for example half before the work starts and half when it is delivered]. Invoices are paid within [number] days.

## Changes
Changes to the work after it has started are agreed in writing, with any extra cost.

## Who owns the work
When the client has paid in full, the finished work belongs to the client. The freelancer may show it in their portfolio unless the client says no.

## Ending it early
Either side can end this agreement in writing. The client pays for the work done until then.

## Signed
{{signature}} {{date}}
{{name}}

{{signature2}} {{date2}}
{{name2}}`,
  },
  {
    id: 'confidential', name: 'A confidentiality agreement', title: 'Confidentiality agreement',
    text: `This agreement is between [name of the person or organisation sharing information] and [name of the person receiving it].

## What is confidential
[What the information is about, for example plans for a new product]

## What the receiver agrees
- To use the information only for [purpose].
- Not to share it with anyone else without written permission.
- To return or delete it when asked.

## What is not covered
Information that was already public, or that the receiver knew before, is not confidential under this agreement.

## How long
This lasts for [number] years from the date it is signed.

## Signed
{{signature}} {{date}}
{{name}}

{{signature2}} {{date2}}
{{name2}}`,
  },
  {
    id: 'consent', name: 'A permission or consent form', title: 'Permission form',
    text: `I give permission for [what is allowed, for example my child to join the school trip to the museum] on [date].

## What I understand
- [What will happen]
- [Who is responsible, and how to reach them: name and phone number]

## Anything to know
{{text:Allergies, medicine or other things to know}}

{{checkbox}} I agree to the above.

## Signed
{{signature}} {{date}}
{{name}}`,
  },
  {
    id: 'receipt', name: 'A receipt of payment', title: 'Receipt of payment',
    text: `I, [name of the person receiving the money], confirm that I received **[amount]** from [name of the person paying] on [date].

**For:** [what the payment is for]

**Paid by:** [cash, bank transfer or another way]

## Signed
{{signature}} {{date}}
{{name}}`,
  },
];
