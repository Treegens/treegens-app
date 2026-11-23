// Field checks on the server: what the sender sets is made tidy and refused out loud when it cannot work, and what a
// signer types is held to it again when they save and when they finish, whatever their browser did. The rules
// themselves live in src/lib/fieldrules.ts, shared with the editor and the signing page.
import { get, run } from './db.ts';
import { bad, str } from './util.ts';
import vm from 'node:vm';
import { usePatternTester, groupRuleProblem, patternProblem, tidyChecks, storedChecks, checksOf, valueProblem, groupProblem, limitOf, amountOf, fieldChecks, shownToOthers, hiddenInCopy, HIDDEN_IN_COPY } from '../lib/fieldrules.ts';
import { seal } from './colcrypt.ts';

// A pattern check on the server runs with a time limit, so even a pattern that slipped past the reader cannot keep
// the server busy for everyone. One that runs out of time counts as a match: the signer is not held to a rule that
// cannot be checked (fieldrules.ts matchesPattern).
const patternBox = vm.createContext({});
usePatternTester((p, value) => {
  try {
    return vm.runInContext('new RegExp(p).test(v)', Object.assign(patternBox, { p: `^(?:${p})$`, v: value }), { timeout: 250 }) === true;
  } catch {
    return true;
  }
});

/** The size in points of page `page` of document `documentId`, or null when it is not known. */
function pageSize(documentId: string, page: number): { w: number; h: number } | null {
  const row = get('SELECT f.page_sizes FROM documents d JOIN files f ON f.id=d.file_id WHERE d.id=?', documentId);
  try {
    const s = JSON.parse(row?.page_sizes || '[]')[page] || null;
    return s && s.w > 0 && s.h > 0 ? { w: s.w, h: s.h } : null;
  } catch {
    return null;
  }
}

/**
 * What goes in the "validation" column for a field the sender saves: the old word or pattern as it was, or the
 * checks as JSON. Refused with what to do when it cannot work (a pattern that could hang a browser, a limit out of
 * range, a currency that does not exist). `which` names the field the way the save does.
 */
export function validationOnSave(f: any, which: string, documentId: string, box: { w: number; h: number }, draft = false): string | null {
  // A draft is saved as the sender works, also halfway through typing a pattern: what is not ready yet is kept as it
  // is, never run (valueProblem and legacyRule run no pattern that is not safe), and refused when the draft is sent
  // (sendProblem below).
  if (!draft) return strictOnSave(f, which, documentId, box);
  try {
    return strictOnSave(f, which, documentId, box);
  } catch (err) {
    const raw = f?.validation;
    if (typeof raw === 'string') return raw.slice(0, 2000) || null;
    const kept = raw && typeof raw === 'object' && !Array.isArray(raw) ? JSON.stringify(raw) : '';
    if (kept && kept.length <= 2000) return kept;
    throw err;
  }
}

/**
 * Why a field's checks stop the envelope from being sent, or ''. The field is named the way the review step names it
 * ("Text for Sam Signer, page 1"), and the sender is told where to put it right.
 */
export function sendProblem(fields: any[], recipients: any[] = [], documents: any[] = []): string {
  for (const f of fields) {
    const r = recipients.find((x) => x.id === f.recipient_id);
    const d = documents.length > 1 ? documents.find((x) => x.id === f.document_id) : null;
    const which = `${f.label ? `"${str(f.label, 60)}"` : f.type === 'checkbox' ? 'Tick box' : f.type === 'number' ? 'Number' : 'Fill in'}${r ? ` for ${r.name || r.role_name || r.email}` : ''}, page ${(Number(f.page) || 0) + 1}${d ? ` of ${d.name || 'a document'}` : ''}`;
    const where = ' Put it right under Format and limits in the field\'s More options, then send again.';
    if (f.validation) {
      try {
        strictOnSave(f, which, f.document_id, { w: f.w, h: f.h });
      } catch (err: any) {
        return String(err?.message || '').replace(/ Nothing was saved\.$/, where);
      }
    }
    if (f.type === 'checkbox' && f.group_name) {
      const boxes = fields.filter((g) => g.type === 'checkbox' && g.group_name === f.group_name && g.recipient_id === f.recipient_id);
      const why = boxes[0]?.id === f.id ? groupRuleProblem(boxes) : '';
      if (why) return `${which}: ${why}${where}`;
    }
  }
  return '';
}

function strictOnSave(f: any, which: string, documentId: string, box: { w: number; h: number }): string | null {
  const raw = f?.validation;
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' && (typeof raw !== 'object' || Array.isArray(raw))) throw bad(`${which}: "validation" is a word ("email", "number", "phone"), a pattern, or an object with "kind" and the other checks. Nothing was saved.`);
  // The old form, a word or a pattern, is kept exactly as it was sent, on any kind of field, as it always was. A
  // pattern is read first, so none can keep a signer's browser busy.
  if (typeof raw === 'string' && !raw.trim().startsWith('{')) {
    const s = raw.trim();
    if (s.length > 200) throw bad(`${which}: the validation rule can be at most 200 characters. Nothing was saved.`);
    const why = ['email', 'number', 'phone'].includes(s) ? '' : patternProblem(s);
    if (why) throw bad(`${which}: ${why} Nothing was saved.`);
    return s;
  }
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      if (raw.length > 2000) throw new Error('long');
      obj = JSON.parse(raw);
    } catch {
      throw bad(`${which}: the validation rule cannot be read. Send it as an object, like {"kind": "letters"}. Nothing was saved.`);
    }
  }
  const { checks, problem } = tidyChecks(f.type, obj, box, pageSize(documentId, Number(f.page) || 0));
  if (problem) throw bad(`${which}: ${problem} Nothing was saved.`);
  return storedChecks(checks);
}

/** The old form of a check (a word or a pattern), for the check applyValues has always made, or null. A stored
 * pattern that could hang (saved before patterns were read first) is not run at all. */
export function legacyRule(v: any): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.startsWith('{')) return null;
  if (['email', 'number', 'phone'].includes(s)) return s;
  return patternProblem(s) ? null : s;
}

/** The checks of a stored field as the API gives them back: always an object. */
export const checksView = (f: any) => checksOf(f?.validation);

/**
 * Held at every save of a signer's answers, also "Finish later": nothing longer than a field takes is stored. Asked
 * before anything is written, so a refused save changes nothing.
 */
export function assertLimits(mine: any[], values: Record<string, any>) {
  for (const f of mine) {
    if (!(f.id in values) || f.formula) continue;
    const limit = limitOf(f);
    const v = str(values[f.id], 8000);
    if (limit != null && [...v].length > limit) throw bad(`${f.label || 'A text field'}: ${valueProblem(f, v)} Nothing was saved.`);
  }
}

/**
 * Held at Finish, over the answers as stored: every format, range and group rule. `hidden` are the fields not shown
 * (by "Only show when"), which are not held to anything.
 */
export function assertChecks(mine: any[], hidden: Set<string>, dateFormat?: string | null) {
  for (const f of mine) {
    if (f.formula || hidden.has(f.id) || !f.value) continue;
    // The old forms (a word or a pattern in the column) are checked by applyValues with the words they always had.
    if (!String(f.validation || '').startsWith('{')) continue;
    const why = valueProblem(f, f.value, dateFormat);
    if (why) throw bad(`"${String(f.value).slice(0, 40)}" in ${f.label || f.type.replace('_', ' ')}: ${why}`);
  }
  const values = Object.fromEntries(mine.map((f) => [f.id, f.value || '']));
  const g = groupProblem(mine, values, hidden);
  if (g) throw bad(`${g.name}: ${g.text}`);
}

/** Keeps each number field's answer as a plain number next to the text as typed (fields.typed_num). */
export function keepNumbers(mine: any[]) {
  for (const f of mine) {
    if (f.type !== 'number' || f.formula) continue;
    const n = f.value ? amountOf(f.value) : null;
    run('UPDATE fields SET typed_num=? WHERE id=?', n == null ? null : seal('fields.typed_num', String(n)), f.id);
  }
}

/** What another person is shown of field `f` (dots for a hidden value while the document is out). */
export const forOthers = (f: any, value: any, envelopeStatus: string) => shownToOthers(f, value, envelopeStatus === 'completed');

/**
 * The fields as a copy prints them for `viewer` (a recipient, or the sender when undefined). A hidden value prints as
 * dots for anyone else while the document is out, as typed to its owner and the sender, and once completed as typed
 * unless the sender also hid it in the copy.
 */
export function printedFields(fields: any[], recipients: Map<string, any>, envelopeStatus: string, viewer?: string) {
  const done = envelopeStatus === 'completed';
  return fields.map((f) => {
    if (!f.value || f.type !== 'text') return f;
    const c = fieldChecks(f);
    if (!c.hide) return f;
    if (done) return c.hide_in_copy ? { ...f, value: HIDDEN_IN_COPY } : f;
    const owner = f.recipient_id ? recipients.get(f.recipient_id) : null;
    return !viewer || viewer === owner?.id ? f : { ...f, value: shownToOthers(f, f.value, false) };
  });
}

/** The line the certificate prints when the sender hid values in the copy, or null. */
export function hiddenLine(fields: any[]): string | null {
  const n = hiddenInCopy(fields);
  return n ? `${n === 1 ? 'One value was' : `${n} values were`} hidden in this copy by the sender's choice. The sender keeps ${n === 1 ? 'it' : 'them'} in their records.` : null;
}
