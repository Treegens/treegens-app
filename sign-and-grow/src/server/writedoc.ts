// Writing a document in the app (src/lib/writedoc.ts has the shared rules, src/server/routes-writedoc.ts the routes,
// src/components/editor/WriteDoc.tsx the writing view):
//   1. the text becomes a PDF here, with our embedded fonts and every script pdftext.ts prints, and its tags become
//      fields; the text is kept with the PDF (written_docs) so the sender can edit it again before sending;
//   2. a draft or a change can be asked of the help chat's own model, with the chat's own client and settings
//      (modelCall in chat.ts, chatProvider in src/lib/chatprovider.ts), never a second one;
//   3. what is signed is the PDF, like any uploaded one: the signer is never told that anything was written here or
//      by an AI. The record says "Written in GrowSigning" and never names the AI (designer notes ds-ai-assist and
//      gov-G01: no AI words in the signed record). Only the sender is told that the AI helped.
//
// What reaches the model: our instructions, and only what the person typed in the writing view (the description,
// the current text when they ask for a change, the request, and the passage they selected). Nothing from other
// documents, contacts or envelopes, and nothing that says who is asking.
import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import fs from 'node:fs';
import path from 'node:path';
import fontkitMod from '@pdf-lib/fontkit';
import { all, get, run, tx, saveBlob } from './db.ts';
import { bad, hmac, id, now, str } from './util.ts';
import { typesetterFor, type Typesetter } from './pdftext.ts';
import { firstStrong } from './bidi.ts';
import { keepText, keptText } from './searchtext.ts';
import { audit, type Actor } from './envelopes.ts';
import { lureIn, plain } from './fakenotice.ts';
import { posesLike } from './starters.ts';
import { validClaimSpans } from './chatguard.ts';
import { admit, modelCall } from './chat.ts';
import { aiAnswersFor } from './tenantpolicy.ts';
import { chatProvider, chatModelOn } from '../lib/chatprovider.ts';
import { handOverReason, HAND_OVER_TEXT, limitText } from '../lib/chat.ts';
import { PRINT_MARK, shownChars } from '../lib/scripts.ts';
import {
  writeBlocks, blanksIn, tagsIn, cleanModelText, blanksLine, sentLine, WRITE_TEXT_MAX, WRITE_TITLE_MAX, WRITE_PROMPT_MAX, WRITE_CHANGE_MAX,
  WRITE_PAGES_MAX, WRITE_DAILY_DEFAULT, WRITE_ANSWER_MAX, type Paper, type Piece, type Tag,
} from '../lib/writedoc.ts';

const fontkit: any = (fontkitMod as any).default || fontkitMod;
const INK = rgb(0.11, 0.13, 0.12);
const MUTED = rgb(0.4, 0.43, 0.41);
const LINE = rgb(0.55, 0.58, 0.56);
export const PAPER: Record<Paper, { W: number; H: number }> = { a4: { W: 595.28, H: 841.89 }, letter: { W: 612, H: 792 } };
// Margins wide enough for a hole punch, and room at the foot for the page number and the strip a signed copy adds.
const L = 56, TOP = 62, BOTTOM = 66, BODY = 10.5, LEAD = BODY * 1.5;
/** How big each kind of field is printed, in points. */
const FIELD: Record<string, { w: number; h: number }> = {
  signature: { w: 150, h: 34 }, initials: { w: 54, h: 24 }, date_signed: { w: 92, h: 16 }, full_name: { w: 150, h: 16 },
  email: { w: 170, h: 16 }, title: { w: 120, h: 16 }, company: { w: 140, h: 16 }, text: { w: 170, h: 16 }, checkbox: { w: 11, h: 11 },
};
const fontsDir = () => path.join(/* turbopackIgnore: true */ process.cwd(), 'assets', 'fonts');

/** A field as the PDF places it: page from 0, x, y, w, h as fractions of the page from its top left, like every field. */
export type Placed = { type: string; signer: number; label: string; required: boolean; page: number; x: number; y: number; w: number; h: number };

export const cleanTitle = (v: any) => str(v, WRITE_TITLE_MAX * 2).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, WRITE_TITLE_MAX);
export const cleanSource = (v: any) => str(v, WRITE_TEXT_MAX + 1).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');

// ---- The PDF -------------------------------------------------------------------------------------------------------
type Tok = { word: string; bold: boolean; space: boolean } | { tag: Tag; space: boolean };

export async function renderWritten(titleIn: string, text: string, paper: Paper = 'a4'): Promise<{ pdf: Uint8Array; pages: number; sizes: { w: number; h: number }[]; fields: Placed[]; plain: string; missing: string }> {
  const { W, H } = PAPER[paper] || PAPER.a4;
  const CW = W - 2 * L;
  const title = cleanTitle(titleIn) || 'Document';
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(path.join(fontsDir(), 'DejaVuSans.ttf')), { subset: true });
  const bold = await doc.embedFont(fs.readFileSync(path.join(fontsDir(), 'DejaVuSans-Bold.ttf')), { subset: true });
  const ts: Typesetter = typesetterFor(doc, font, bold);
  const pages: PDFPage[] = [];
  const placed: Placed[] = [];
  const words: string[] = [title];
  let page!: PDFPage;
  let top = 0;
  const add = () => {
    if (pages.length >= WRITE_PAGES_MAX) throw bad(`This text makes more than ${WRITE_PAGES_MAX} pages, which is more than a document written here can have. Make it shorter, or write it elsewhere and upload the PDF.`, 400, { code: 'too_long' });
    page = doc.addPage([W, H]);
    pages.push(page);
    top = TOP;
  };
  const need = (h: number) => {
    if (top + h > H - BOTTOM) add();
  };
  const width = (s: string, size: number, b: boolean) => (ts.layout(s, { bold: b }).width * size) / 1000;

  // One paragraph, a heading or a list item: its words and tags flowed into lines from `x0`, `maxW` wide. A line that
  // holds a tag is as tall as the tag. A right-to-left paragraph is aligned to the right, its pieces right to left.
  const flow = (items: Piece[], o: { size: number; bold?: boolean; x0: number; maxW: number; first?: (rtl: boolean, baseline: number) => void }) => {
    const size = o.size;
    const plainText = items.map((p) => (p.tag ? ' ' : p.text)).join('');
    const rtl = firstStrong(plainText) === 'rtl';
    const toks: Tok[] = [];
    let gap = false;
    for (const p of items) {
      if (p.tag) {
        toks.push({ tag: p.tag, space: true });
        gap = true;
        continue;
      }
      const parts = p.text.split(/(\s+)/);
      for (const w of parts) {
        if (!w) continue;
        if (/^\s+$/.test(w)) {
          gap = true;
          continue;
        }
        toks.push({ word: w, bold: !!(p.bold || o.bold), space: gap || !toks.length });
        gap = false;
      }
    }
    if (!toks.length) return;
    const space = width(' ', size, false);
    type Item = { text?: string; bold?: boolean; tag?: Tag; x: number; w: number; h: number };
    let line: Item[] = [], x = 0;
    const lines: Item[][] = [];
    const push = () => {
      if (line.length) lines.push(line);
      line = [];
      x = 0;
    };
    for (const t of toks) {
      if ('tag' in t) {
        const f = FIELD[t.tag.type] || FIELD.text;
        const w = Math.min(f.w, o.maxW);
        if (line.length && x + space + w > o.maxW) push();
        const at = line.length ? x + space : 0;
        line.push({ tag: t.tag, x: at, w, h: f.h });
        x = at + w;
        continue;
      }
      let word = t.word;
      let w = width(word, size, t.bold);
      // A word longer than the line by itself (a long code, text without spaces) is cut between characters.
      while (w > o.maxW && [...word].length > 1) {
        const chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word)].map((s) => s.segment);
        let n = chars.length - 1;
        while (n > 1 && width(chars.slice(0, n).join(''), size, t.bold) > o.maxW) n--;
        push();
        line.push({ text: chars.slice(0, n).join(''), bold: t.bold, x: 0, w: width(chars.slice(0, n).join(''), size, t.bold), h: 0 });
        push();
        word = chars.slice(n).join('');
        w = width(word, size, t.bold);
      }
      const last = line[line.length - 1];
      // The next word of the same weight joins the piece before it, so a line is drawn (and shaped) as a whole.
      if (last && last.text !== undefined && last.bold === t.bold && t.space) {
        const joined = `${last.text} ${word}`;
        const jw = width(joined, size, t.bold);
        if (last.x + jw <= o.maxW) {
          last.text = joined;
          last.w = jw;
          x = last.x + jw;
          continue;
        }
        push();
      } else if (line.length && x + (t.space ? space : 0) + w > o.maxW) push();
      const at = line.length ? x + (t.space ? space : 0) : 0;
      line.push({ text: word, bold: t.bold, x: at, w, h: 0 });
      x = at + w;
    }
    push();
    lines.forEach((ln, li) => {
      const tall = Math.max(0, ...ln.map((i) => i.h));
      const h = Math.max(size * 1.5, tall + 8);
      need(h);
      const baseline = top + h - size * 0.45;
      if (li === 0) o.first?.(rtl, baseline);
      for (const it of ln) {
        const left = rtl ? o.x0 + o.maxW - it.x - it.w : o.x0 + it.x;
        if (it.tag) {
          const f = it;
          const boxTop = baseline + 3 - f.h;
          if (it.tag.type === 'checkbox') page.drawRectangle({ x: left, y: H - boxTop - f.h, width: f.w, height: f.h, borderColor: LINE, borderWidth: 0.8 });
          else page.drawLine({ start: { x: left, y: H - baseline - 3 }, end: { x: left + f.w, y: H - baseline - 3 }, thickness: 0.7, color: LINE });
          placed.push({ type: it.tag.type, signer: it.tag.signer, label: it.tag.label, required: !['checkbox', 'company', 'title'].includes(it.tag.type), page: pages.length - 1, x: left / W, y: boxTop / H, w: f.w / W, h: f.h / H });
          if (it.tag.label) words.push(it.tag.label);
        } else if (it.text) {
          ts.draw(page, ts.layout(it.text, { bold: it.bold, dir: rtl ? 'rtl' : 'ltr' }), { x: left, y: H - baseline, size, color: INK });
          words.push(it.text);
        }
      }
      top += h;
    });
  };

  add();
  flow([{ text: title }], { size: 18, bold: true, x0: L, maxW: CW });
  top += 8;
  const blocks = writeBlocks(text);
  for (const b of blocks) {
    if (b.kind === 'h1' || b.kind === 'h2') {
      const size = b.kind === 'h1' ? 14 : 12;
      top += 8;
      // A heading is kept with the first lines under it, so it never stands alone at the foot of a page.
      need(size * 1.5 + LEAD * 2);
      flow(b.items[0], { size, bold: true, x0: L, maxW: CW });
      top += 2;
    } else if (b.kind === 'p') {
      flow(b.items[0], { size: BODY, x0: L, maxW: CW });
      top += 6;
    } else {
      b.items.forEach((item, i) => {
        const mark = b.kind === 'ul' ? '•' : `${i + 1}.`;
        flow(item, {
          size: BODY, x0: L + 18, maxW: CW - 18,
          first: (rtl, baseline) => ts.draw(page, ts.layout(mark, { dir: rtl ? 'rtl' : 'ltr' }), { x: rtl ? W - L - width(mark, BODY, false) - 2 : L + 3, y: H - baseline, size: BODY, color: INK }),
        });
        top += 2;
      });
      top += 4;
    }
  }
  pages.forEach((p, n) => {
    const foot = ts.wrap(`${title} · page ${n + 1} of ${pages.length}`, 7.5, CW)[0];
    if (foot) ts.draw(p, foot, { x: L, y: 34, size: 7.5, color: MUTED });
  });
  doc.setTitle(title);
  doc.setProducer('GrowSigning');
  doc.setCreator('GrowSigning');
  return { pdf: await doc.save(), pages: pages.length, sizes: pages.map(() => ({ w: W, h: H })), fields: placed, plain: words.join('\n'), missing: [...ts.missing].join('') };
}

/** The warning about characters the PDF cannot print, or ''. */
export const missingLine = (chars: string) => (chars ? `Some characters cannot be printed in the PDF and show as ${PRINT_MARK} there: ${shownChars(chars)}. Change them, or check the PDF before you send it.` : '');

/** The text, checked: what stops it from becoming a document is said in a sentence, and nothing is made. */
export function assertWritable(title: string, text: string) {
  if (!text.trim()) throw bad('Write the text of the document first.');
  if (text.length > WRITE_TEXT_MAX) throw bad(`The text is longer than ${WRITE_TEXT_MAX.toLocaleString('en')} characters. Make it shorter first.`, 413);
  const blanks = blanksIn(text);
  if (blanks.length) throw bad(blanksLine(blanks.length), 400, { code: 'blanks', blanks: blanks.length, first: blanks[0].start });
  const brand = posesLike(title);
  if (brand) throw bad(`"${title}" reads like the name of ${brand}, so no document was made. Give it a title of your own.`, 400, { code: 'poses_as' });
}

/** The PDF of a written text, stored like an uploaded file, with its source kept beside it. */
export async function storeWritten(accountId: string, o: { title: string; text: string; paper: Paper; ai: boolean }) {
  const title = cleanTitle(o.title) || 'Document';
  const text = cleanSource(o.text);
  assertWritable(title, text);
  const r = await renderWritten(title, text, o.paper);
  const fid = id('fil');
  const kept = keepText(fid, r.plain);
  const src = keepText(`written:${fid}`, text);
  tx(() => {
    run('INSERT INTO files (id, account_id, sha256, name, size, pages, page_sizes, created_at, text, scan_pages, text_sealed, text_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      fid, accountId, saveBlob(r.pdf), title, r.pdf.length, r.pages, JSON.stringify(r.sizes), now(), kept.text, null, kept.sealed, kept.key);
    run('INSERT INTO written_docs (file_id, account_id, title, source, source_sealed, source_key, paper, ai, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      fid, accountId, title, src.text, src.sealed, src.key, o.paper, o.ai ? 1 : 0, now());
  });
  return {
    file: { id: fid, name: title, pages: r.pages, page_sizes: r.sizes, size: r.pdf.length, is_scan: false, scan_pages: [], converted: null, written: { ai: !!o.ai } },
    fields: r.fields, warning: missingLine(r.missing),
  };
}

/** The text a file was written from, for its own account, or null for a file that was not written here. */
export function writtenSource(fileId: string, accountId: string): { title: string; text: string; paper: Paper; ai: boolean } | null {
  const w = get('SELECT * FROM written_docs WHERE file_id=? AND account_id=?', fileId, accountId);
  if (!w) return null;
  return { title: w.title, text: keptText({ id: `written:${fileId}`, text: w.source, text_sealed: w.source_sealed }), paper: w.paper === 'letter' ? 'letter' : 'a4', ai: !!w.ai };
}
const isWritten = (fileId: string) => !!get('SELECT 1 x FROM written_docs WHERE file_id=?', fileId);

// ---- What the record says ------------------------------------------------------------------------------------------
// Never that an AI helped: the record goes to every signer (see the top of this file).
/** When an envelope goes out: one line for each document written here. Inside the send. */
export function writtenSent(e: any, actor: Actor) {
  for (const d of e.documents || []) if (isWritten(d.file_id)) audit(e.id, actor, 'Written in GrowSigning', `The document "${str(d.name, 200)}" was written as text in GrowSigning and made into a PDF here (SHA-256 ${d.sha256}). That PDF is what is signed.`);
}
/** For a correction: the document's file was replaced by one written here, which the record says as "Wording changed". */
export const rewritten = (oldFileId: string, newFileId: string) => oldFileId !== newFileId && isWritten(newFileId);
/** The words of the written documents of an envelope, for the fake-notice filter at sending (envelopes.ts fakeNotice). */
export function writtenWords(e: any): string[] {
  const out: string[] = [];
  for (const d of e.documents || []) {
    const w = get('SELECT * FROM written_docs WHERE file_id=?', d.file_id);
    if (w) out.push(w.title, keptText({ id: `written:${d.file_id}`, text: w.source, text_sealed: w.source_sealed }).slice(0, WRITE_TEXT_MAX));
  }
  return out;
}

// ---- Honest words in a draft ---------------------------------------------------------------------------------------
const PREDICATE = /^(?:is|are|was|were|['’]s|['’]re|will|would|should|shall|remains?|stays?|does|do|can|courts?|judges?|holds?|stands?|has|have|carries|carry|counts?|good|fine|ok|okay|accepted|recogni)/i;
/**
 * A draft with every claim that it is valid, binding or enforceable or will hold up taken out, read the way the chat's
 * backstop reads them (chatguard.ts). "A legally binding agreement" loses the two words; "This agreement is binding on
 * both parties." loses the sentence. `taken` counts what was taken out, so the person is told.
 */
export function withoutClaims(text: string): { text: string; taken: number } {
  const spans = validClaimSpans(text);
  if (!spans.length) return { text, taken: 0 };
  const cuts: [number, number][] = [];
  for (const [a, b] of spans) {
    if (cuts.some(([x, y]) => a >= x && b <= y)) continue;
    if (PREDICATE.test(text.slice(a, b))) {
      // The sentence it stands in: from the end of the one before to its own full stop.
      let s = a;
      while (s > 0 && !/[.!?\n]/.test(text[s - 1])) s--;
      let t = b;
      while (t < text.length && !/[.!?\n]/.test(text[t])) t++;
      if (t < text.length && text[t] !== '\n') t++;
      cuts.push([s, t]);
    } else cuts.push([a, b]);
  }
  cuts.sort((x, y) => y[0] - x[0]);
  let out = text;
  for (const [a, b] of cuts) out = out.slice(0, a) + out.slice(b);
  // "a  agreement" and "an contract" put right after the words went.
  out = out.replace(/\b(a|an|A|An) +(\S)/g, (_, art, ch) => `${/[aeiouAEIOU]/.test(ch) ? (art[0] === 'A' ? 'An' : 'an') : art[0]} ${ch}`)
    .replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:])/g, '$1').replace(/^[ \t]+(?=\S)/gm, '')
    .replace(/^(#{1,3}|[-*•]|\d{1,3}[.)])\s*$/gm, '').replace(/\n{3,}/g, '\n\n');
  return { text: out.trim(), taken: cuts.length };
}
export const CLAIMS_TAKEN = 'We took out words that said this document is binding, valid or enforceable, or will hold up. Nobody here can promise that: it depends on the law where you are and on the kind of document.';

// ---- Who may ask, and how much -------------------------------------------------------------------------------------
/** WRITE_AI_DAILY_LIMIT: drafts and changes per account per day (UTC). 0 switches asking the AI off on this server. */
export const writeDailyLimit = (env: Record<string, string | undefined> = process.env): number => {
  const raw = (env.WRITE_AI_DAILY_LIMIT ?? '').trim();
  const n = Number(raw === '' ? NaN : raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : WRITE_DAILY_DEFAULT;
};
/** May this account ask the model for a draft? A model on this server (and under the government profile only the
 *  operator's own), the account's AI switch on (the same switch as the help chat's), and a daily limit above 0. */
export const writeAiOn = (accountId: string | null | undefined): boolean => !!accountId && chatModelOn() && aiAnswersFor(accountId) && writeDailyLimit() > 0;

/** What the writing view is told before anything is typed. No model name or host when the model is not used. */
export function writeInfo(accountId: string, userId: string) {
  const confirmed = !!get('SELECT email_verified v FROM users WHERE id=?', userId)?.v;
  const on = writeAiOn(accountId) && confirmed;
  const p = on ? chatProvider() : null;
  return { ai: on, ...(p ? { model: p.model, host: p.host, sent: sentLine(p.model, p.host), left: Math.max(0, writeDailyLimit() - usedToday(accountId)), daily: writeDailyLimit() } : {}) };
}
const dayKey = (accountId: string) => `write:${hmac(`write-limit:${accountId}`).slice(0, 32)}`;
const today = () => `d:${new Date().toISOString().slice(0, 10)}`;
const usedToday = (accountId: string) => get('SELECT n FROM chat_counts WHERE key=? AND slot=?', dayKey(accountId), today())?.n || 0;
export const DAILY_FULL = (n: number) => `You have asked for ${n} drafts and changes today, which is the most for one account in a day. Typing and the starters still work. You can ask again after midnight UTC.`;
/** One more draft or change, if every limit has room: the account's own daily number, then the chat's per-minute and per-day limits. */
export function admitWrite(who: { ip: string; account: string }): { ok: true } | { ok: false; text: string } {
  const max = writeDailyLimit();
  // No await between the three steps, so nothing else runs in between on this server. admit() is its own transaction.
  if (usedToday(who.account) >= max) return { ok: false, text: DAILY_FULL(max) };
  const a = admit({ ip: who.ip, account: who.account });
  if (!a.ok) return { ok: false, text: `${limitText(a.which, `${a.until.toISOString().slice(11, 16)} UTC`)} Typing and the starters still work.` };
  run('INSERT INTO chat_counts (key, slot, n, at) VALUES (?,?,1,?) ON CONFLICT(key, slot) DO UPDATE SET n=n+1, at=excluded.at', dayKey(who.account), today(), now());
  return { ok: true };
}

// ---- What may not be asked for -------------------------------------------------------------------------------------
const PAPERS = String.raw`(?:invoices?|bills?|receipts?|notices?|statements?|letters?|renewals?|subscriptions?|orders?|refunds?|certificates?|documents?|contracts?|ids?|licen[cs]es?|notes?|references?|emails?|messages?|signatures?)`;
const DECEIVE = new RegExp(String.raw`\b(?:(?:fake|faked|forged?|counterfeit|bogus|phony|phoney)\s+(?:\w+\s+){0,3}?${PAPERS}|forgery|impersonat\w*|spoof\w*|phish\w*|pretend(?:ing)? to (?:be|come from)|pos(?:e|ing) as|as if it (?:came|comes|is|was) from|look(?:s|ing)? like it (?:came|comes|is|was) from|so (?:they|he|she|people) (?:think|believe) (?:it|this)|official[- ]looking|on (?:their|his|her|the bank'?s?|the company'?s?) letterhead|trick (?:them|him|her|people|someone)|(?:in the name of|on behalf of|signed as|from)\s+(?:the\s+)?(?:tax office|irs|hmrc|police|government|bank of)\b)`);
// "An invoice from PayPal", "a notice in the name of Amazon": a paper said to come from a real company.
const FROM_BRAND = new RegExp(String.raw`\b${PAPERS}\b[^.;:!?\n]{0,40}?\b(?:from|by|in the name of|on behalf of|as|of)\s+([^.,;:!?\n]{2,40})`, 'g');
export const DECEIVE_TEXT = 'We cannot write a document meant to deceive someone or to look as if it came from a real company, a bank or a public office. Describe a document between you and the people who sign it, under your own name.';
/** Whether a description or a request asks for a document that deceives or poses as someone: the words people use
 *  when they ask for a fake, a paper said to come from a company the send filter knows, and that filter itself
 *  (a brand, words about money and a phone number, fakenotice.ts). */
export function deceptive(text: string): boolean {
  const p = plain(text);
  if (DECEIVE.test(p)) return true;
  for (const m of p.matchAll(FROM_BRAND)) {
    // The name runs until a small word starts the rest of the sentence: "from PayPal for my customer" is "PayPal".
    const name = m[1].split(/\s+(?:for|to|and|with|on|about|that|which|saying|asking|in|at|dated|because|so)\b/)[0].trim();
    if (name && posesLike(name)) return true;
  }
  return !!lureIn([text]);
}

// ---- The model -------------------------------------------------------------------------------------------------------
export const WRITE_TIMING = { ms: 120_000 };
export const WRITE_MAX_TOKENS = 6000;
const RULES = [
  'You write short, plain documents that people sign in GrowSigning, an e-signature service. Answer with the document only: no greeting, no explanation, no notes before or after it.',
  'Use only these marks: a line that starts with "## " is a heading, a line that starts with "- " is a list item, "1. " a numbered item, **two stars** around words make them bold, an empty line starts a new paragraph. No tables, no links, no web addresses, no HTML, no pictures, no code.',
  'Use the names, amounts, dates and other facts the person gave, exactly as given. Never make up facts about the people: no names, addresses, amounts, dates or numbers they did not give. Where something the document needs is missing, write a short blank in square brackets instead, such as [client\'s address] or [date].',
  'Do not name a governing law, a country, a state, a court or a place for disputes unless the person named one.',
  'Never write that the document is legally binding, enforceable, valid, lawful, lawyer-approved or compliant, or that it will hold up in court. Do not say what the law requires and give no legal advice.',
  'Where each person signs, write a line with {{signature}} {{date}} and under it {{name}} for the first person; {{signature2}} {{date2}} and {{name2}} for the second, and so on. Something a signer fills in while signing is {{text:Label}}, a tick box is {{checkbox}}. Use no other curly brackets.',
  'Keep it short: at most about 600 words, in simple words a person reads once and understands. Write in the language the person wrote in.',
  'If you are asked for a document that deceives someone, or that pretends to come from a real company, a bank, a public office or another person, answer with the single word REFUSE.',
].join('\n');
const DRAFT_SYSTEM = `${RULES}\nStart with one line: "# " and a short title. Then the document.`;
const CHANGE_SYSTEM = `${RULES}\nYou are given a document and a change to make to it. Answer with the whole document after the change, and nothing else. Change only what the request asks for; keep every other word, tag and [blank] exactly as it was.`;
const PASSAGE_SYSTEM = `${RULES}\nYou are given a passage of a longer document and a change to make to it. Answer with the passage after the change, and nothing else. Keep every tag and [blank] that the change does not touch.`;

export type Ask = { kind: 'draft'; prompt: string } | { kind: 'change'; text: string; request: string; passage?: string };
const messagesFor = (a: Ask) =>
  a.kind === 'draft' ? [{ role: 'system' as const, content: DRAFT_SYSTEM }, { role: 'user' as const, content: `Write this document: ${a.prompt}` }]
    : a.passage ? [{ role: 'system' as const, content: PASSAGE_SYSTEM }, { role: 'user' as const, content: `The passage:\n<<<\n${a.passage}\n>>>\n\nThe change: ${a.request}` }]
    : [{ role: 'system' as const, content: CHANGE_SYSTEM }, { role: 'user' as const, content: `The document:\n<<<\n${a.text}\n>>>\n\nThe change: ${a.request}` }];

/** Checks an ask before anything is sent: sizes, and what may not be asked for. Throws a refusal in words. */
export function checkAsk(b: any): Ask {
  if (b?.kind === 'draft') {
    const prompt = str(b.prompt, WRITE_PROMPT_MAX + 1).trim();
    if (!prompt) throw bad('Describe what you need first.');
    if (prompt.length > WRITE_PROMPT_MAX) throw bad(`Describe it in up to ${WRITE_PROMPT_MAX.toLocaleString('en')} characters.`, 413);
    if (deceptive(prompt)) throw bad(DECEIVE_TEXT, 400, { code: 'deceptive' });
    return { kind: 'draft', prompt };
  }
  const text = cleanSource(b?.text);
  const request = str(b?.request, WRITE_CHANGE_MAX + 1).trim();
  if (!request) throw bad('Say what to change first.');
  if (request.length > WRITE_CHANGE_MAX) throw bad(`Say the change in up to ${WRITE_CHANGE_MAX} characters.`, 413);
  if (!text.trim()) throw bad('There is no text to change yet. Write some, or ask for a draft first.');
  if (text.length > WRITE_TEXT_MAX) throw bad(`The text is longer than ${WRITE_TEXT_MAX.toLocaleString('en')} characters. Make it shorter first.`, 413);
  if (deceptive(request) || deceptive(text)) throw bad(DECEIVE_TEXT, 400, { code: 'deceptive' });
  const s = Number(b?.selection?.start), e = Number(b?.selection?.end);
  const passage = Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > s && e <= text.length ? text.slice(s, e) : undefined;
  return { kind: 'change', text, request, ...(passage && passage.trim() ? { passage } : {}) };
}

export const MODEL_DOWN = 'The AI could not write it just now. Your text is as you left it. Try again in a minute, or carry on typing.';

/**
 * Asks the model and streams what it writes as Server-Sent Events, one JSON object each:
 *   {open: true}                      first
 *   {d: "text"}                       the text, piece by piece, as it comes
 *   {think: true}                     while the model thinks (keeps the connection alive)
 *   {done, text, title?, notes, cut?} the end: the whole text made safe (cleanModelText, withoutClaims), which
 *                                     replaces what was streamed; `notes` are sentences for the person
 *   {error: "sentence"}               nothing usable came; the view keeps what it had
 * `gone` is the request's own signal: Stop in the view, or the tab closing, stops the model too.
 */
export async function askModel(a: Ask, gone?: AbortSignal | null): Promise<Response> {
  const p = chatProvider()!;
  const abort = new AbortController();
  let late = false;
  const timer = setTimeout(() => ((late = true), abort.abort()), WRITE_TIMING.ms);
  if (gone?.aborted) abort.abort();
  else gone?.addEventListener('abort', () => abort.abort(), { once: true });
  const legal = a.kind === 'draft' ? handOverReason([{ role: 'user', content: a.prompt }]) === 'legal' : handOverReason([{ role: 'user', content: a.request }]) === 'legal';
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (o: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
        } catch {
          closed = true;
        }
      };
      send({ open: true });
      let text = '', cut = false, broke = false;
      try {
        let res = await modelCall(p, messagesFor(a), { tuned: true, signal: abort.signal, maxTokens: WRITE_MAX_TOKENS, title: 'GrowSigning writing' });
        if (!res.ok && res.status >= 400 && res.status < 500) {
          res.body?.cancel().catch(() => {});
          res = await modelCall(p, messagesFor(a), { tuned: false, signal: abort.signal, maxTokens: WRITE_MAX_TOKENS, title: 'GrowSigning writing' });
        }
        if (!res.ok || !res.body) {
          console.warn(`[write] ${p.name} answered ${res.status}.`);
          res.body?.cancel().catch(() => {});
          broke = true;
        } else {
          const asJson = (res.headers.get('content-type') || '').includes('application/json');
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '', lastThink = 0;
          const take = (piece: string) => {
            if (!piece || cut) return;
            let clean = piece.replace(/—/g, ', ');
            if (text.length + clean.length > WRITE_ANSWER_MAX) (clean = clean.slice(0, WRITE_ANSWER_MAX - text.length)), (cut = true);
            text += clean;
            if (clean) send({ d: clean });
          };
          for (;;) {
            if (cut || buffer.length > WRITE_ANSWER_MAX * 8) {
              abort.abort();
              reader.cancel().catch(() => {});
              cut = true;
              break;
            }
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (asJson) continue;
            const parts = buffer.split('\n');
            buffer = parts.pop() ?? '';
            for (const line of parts) {
              const data = line.startsWith('data:') ? line.slice(5).trim() : '';
              if (!data || data === '[DONE]') continue;
              let o: any;
              try {
                o = JSON.parse(data);
              } catch {
                continue;
              }
              if (o?.error) {
                broke = true;
                continue;
              }
              const delta = o?.choices?.[0]?.delta;
              if (typeof delta?.content === 'string' && delta.content) take(delta.content);
              else if ((delta?.reasoning_content || delta?.reasoning) && Date.now() - lastThink > 1500) (lastThink = Date.now()), send({ think: true });
            }
          }
          if (asJson) {
            try {
              const m = JSON.parse(buffer)?.choices?.[0]?.message?.content;
              if (typeof m === 'string') take(m);
            } catch {}
          }
        }
      } catch {
        broke = true;
      } finally {
        clearTimeout(timer);
      }
      if (gone?.aborted) {
        // Stopped by the person: nothing more to say, and the view keeps what came.
      } else if (/^\s*REFUSE\b/.test(text) && text.trim().length < 40) send({ error: DECEIVE_TEXT, code: 'deceptive' });
      else if (!text.trim()) send({ error: late ? MODEL_DOWN : broke ? MODEL_DOWN : 'The AI sent back nothing. Your text is as you left it. Try again, or say it another way.' });
      else {
        let clean = cleanModelText(text);
        let title: string | undefined;
        if (a.kind === 'draft') {
          const m = /^#\s+(.+)\n?/.exec(clean);
          if (m) (title = cleanTitle(m[1].replace(/\*\*/g, ''))), (clean = clean.slice(m[0].length).trim());
        }
        const fixed = withoutClaims(clean);
        const notes: string[] = [];
        if (fixed.taken) notes.push(CLAIMS_TAKEN);
        if (legal) notes.push(HAND_OVER_TEXT.legal);
        if (late || cut) notes.push('The AI stopped part way, so the end may be missing. Read it through, and finish it by typing or ask again.');
        // A passage comes back as the passage: it is put back where it was taken from.
        let whole = fixed.text;
        if (a.kind === 'change' && a.passage) {
          const at = a.text.indexOf(a.passage);
          whole = at >= 0 ? a.text.slice(0, at) + fixed.text + a.text.slice(at + a.passage.length) : a.text;
        }
        send({ done: true, text: whole.slice(0, WRITE_TEXT_MAX), ...(title ? { title } : {}), notes, ...(late || cut ? { cut: true } : {}) });
      }
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      clearTimeout(timer);
      abort.abort();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
}

/** For the data the account holds (an export, a closing account): the written sources of an account. */
export const writtenOf = (accountId: string) => all('SELECT file_id, title, paper, ai, created_at FROM written_docs WHERE account_id=?', accountId);
