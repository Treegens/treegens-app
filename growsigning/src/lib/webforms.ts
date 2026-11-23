// A form as questions (ds-web-forms). The fields of a public form's open role that a person types or picks become
// questions, in the order they are read on the pages, with the checks and "Only show when" rules they already have.
// The answers fill in the document; what the person signs is still the document, on the normal signing page.
// Shared by the form page (one question at a time) and the server (which checks every answer again before it makes
// anything). No environment, no server imports.
import { workOut, ruleOf } from './logic.ts';
import { valueProblem, fieldChecks, checksSummary, groupProblem, isHidden } from './fieldrules.ts';
import { isDateValue, DATE_PROBLEM } from './dates.ts';

/** The field types a person answers as a question. Signatures, initials, stamps and files stay on the signing page. */
export const QUESTION_TYPES = ['text', 'number', 'date', 'company', 'title', 'checkbox', 'radio', 'dropdown'] as const;
/** At most this many questions; a template with more is shown as the document, as before. */
export const MAX_QUESTIONS = 200;
/** The most unfinished answer sets one internet connection keeps at a time. The oldest goes first. */
export const DRAFTS_PER_CONNECTION = 20;
/** The largest set of answers kept, in characters of JSON. */
export const DRAFT_MAX_CHARS = 64_000;

export type Question = {
  /** The field's id, or "group:<name>" for a group of radio buttons. */
  key: string;
  kind: 'text' | 'number' | 'date' | 'checkbox' | 'choice' | 'dropdown';
  label: string;
  /** One line of help: the field's format and limits, in the editor's words. Empty when there are none. */
  help: string;
  required: boolean;
  /** The fields this question fills. One, except for a group of radio buttons. */
  fields: string[];
  /** For a dropdown, its options. For radio buttons, each button's field id and words. */
  options: { value: string; label: string }[];
  /** Where it goes on the document: "Page 2", or "Waiver, page 2" when there are several files. A new section
   *  starts where this changes. */
  section: string;
  /** The longest answer it takes, in characters, or null. */
  max: number | null;
};

const TYPE_WORDS: Record<string, string> = { text: 'Text', number: 'Number', date: 'Date', company: 'Company', title: 'Title', checkbox: 'Tick box', radio: 'Choice', dropdown: 'Choice' };

/**
 * How many of `recipientId`'s answerable fields have no words to ask with: a field with no label, or a radio button
 * with no label or no group name. A question made from one ("Text on page 1") means nothing to someone who has not
 * seen the document yet, so a role with any of them is filled in on the document instead.
 */
export function unlabelledCount(fields: any[], recipientId: string): number {
  const blank = (s: any) => !String(s ?? '').trim();
  return fields.filter((f) => asksFor(f, recipientId) && (blank(f.label) || (f.type === 'radio' && blank(f.group_name)))).length;
}

/** Whether a field is one the person answers as a question. */
export const asksFor = (f: any, recipientId: string): boolean =>
  f.recipient_id === recipientId && (QUESTION_TYPES as readonly string[]).includes(f.type) && !f.readonly && !f.formula;

/**
 * The questions of `recipientId` on a document with `documents` (id, name, position) and `fields`, in reading order:
 * file by file, page by page, top to bottom, then left to right. A group of radio buttons is one question, where its
 * first button is.
 */
export function questionsOf(fields: any[], documents: any[], recipientId: string): Question[] {
  // None when any of those fields has no words to ask with (unlabelledCount): the person fills them in on the
  // document instead, as before.
  if (unlabelledCount(fields, recipientId) > 0) return [];
  const docs = new Map<string, any>(documents.map((d: any, i: number) => [d.id, { ...d, at: d.position ?? i }]));
  const many = documents.length > 1;
  const at = (f: any) => [docs.get(f.document_id)?.at ?? 0, f.page, Math.round(f.y * 1000), f.x];
  const order = (a: any, b: any) => {
    const x = at(a), y = at(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  };
  const mine = fields.filter((f) => asksFor(f, recipientId)).sort(order);
  const out: Question[] = [];
  const groups = new Map<string, Question>();
  for (const f of mine) {
    const d = docs.get(f.document_id);
    const section = many ? `${d?.name || 'Document'}, page ${f.page + 1}` : `Page ${f.page + 1}`;
    if (f.type === 'radio') {
      const g = f.group_name || f.id;
      const q = groups.get(g);
      const option = { value: f.id, label: String(f.label || '').trim() || `Choice ${(q?.options.length ?? 0) + 1}` };
      if (q) {
        q.fields.push(f.id);
        q.options.push(option);
        q.required ||= !!f.required;
        continue;
      }
      const nq: Question = { key: `group:${g}`, kind: 'choice', label: String(f.group_name || '').trim() || `Choice on ${section.toLowerCase()}`, help: '', required: !!f.required, fields: [f.id], options: [option], section, max: null };
      groups.set(g, nq);
      out.push(nq);
      continue;
    }
    const c = fieldChecks(f);
    const summary = f.type === 'text' || f.type === 'number' || f.type === 'checkbox' ? checksSummary(f.type, c) : 'None';
    const help = [summary !== 'None' ? summary : '', isHidden(f) ? 'Others see dots instead of what you type. This is not encryption.' : ''].filter(Boolean).join('. ');
    out.push({
      key: f.id,
      kind: f.type === 'company' || f.type === 'title' ? 'text' : f.type === 'radio' ? 'choice' : f.type,
      label: String(f.label || '').trim() || `${TYPE_WORDS[f.type] || 'Answer'} on ${section.toLowerCase()}`,
      help,
      required: !!f.required,
      fields: [f.id],
      options: f.type === 'dropdown' ? (Array.isArray(f.options) ? f.options : []).map((o: any) => ({ value: String(o), label: String(o) })) : [],
      section,
      max: c.max_length ?? null,
    });
  }
  return out.slice(0, MAX_QUESTIONS);
}

/** The fields with the person's answers in them, for working out what is shown. */
export function withAnswers(fields: any[], answers: Record<string, any>, questions: Question[]): any[] {
  const asked = new Set(questions.flatMap((q) => q.fields));
  return fields.map((f) => (asked.has(f.id) && f.id in answers ? { ...f, value: answers[f.id] == null ? '' : String(answers[f.id]) } : f));
}

/** The questions that are shown with these answers: a question whose "Only show when" is not met is skipped. */
export function shownQuestions(questions: Question[], fields: any[], answers: Record<string, any>): Question[] {
  if (!fields.some((f) => ruleOf(f))) return questions;
  const { hidden } = workOut(withAnswers(fields, answers, questions));
  return questions.filter((q) => q.fields.some((id) => !hidden.has(id)));
}

const ticked = (v: any) => v === '1' || v === true || v === 'true';

/** What is wrong with the answer to one question, said with what to do, or '' when nothing is. */
export function answerProblem(q: Question, fields: any[], answers: Record<string, any>, dateFormat?: string | null): string {
  const byId = new Map<string, any>(fields.map((f) => [f.id, f]));
  if (q.kind === 'choice') {
    if (q.required && !q.fields.some((id) => ticked(answers[id]))) return 'Choose one of these to go on.';
    return '';
  }
  const f = byId.get(q.fields[0]);
  const v = answers[q.key] == null ? '' : String(answers[q.key]);
  if (q.kind === 'checkbox') {
    if (q.required && !ticked(v)) return 'Tick this box to go on. If you do not agree, you can stop here: nothing is sent.';
    // The rule of a group of tick boxes ("Tick at least 2") is asked about at the last box of the group.
    const group = f?.group_name ? fields.filter((x) => x.type === 'checkbox' && x.group_name === f.group_name && x.recipient_id === f.recipient_id) : [];
    if (group.length && group[group.length - 1].id === f.id) {
      const g = groupProblem(group, answers);
      if (g) return g.text;
    }
    return '';
  }
  if (!v.trim()) return q.required ? 'Answer this to go on.' : '';
  if (q.kind === 'date') return isDateValue(v) ? '' : DATE_PROBLEM;
  if (q.kind === 'dropdown') return q.options.some((o) => o.value === v) ? '' : 'Choose one of the choices in the list.';
  return f ? valueProblem(f, v, dateFormat) : '';
}

/**
 * The first shown question whose answer is not ready, with what to say, or null. Questions that are not shown do not
 * count, and their answers are not kept (answersToKeep).
 */
export function firstProblem(questions: Question[], fields: any[], answers: Record<string, any>, dateFormat?: string | null): { question: Question; text: string } | null {
  for (const q of shownQuestions(questions, fields, answers)) {
    const text = answerProblem(q, fields, answers, dateFormat);
    if (text) return { question: q, text };
  }
  return null;
}

/** The answers to keep: only for fields asked about and shown, each as the field stores it ('1' or '' for a tick). */
export function answersToKeep(questions: Question[], fields: any[], answers: Record<string, any>): Record<string, string> {
  const shown = new Set(shownQuestions(questions, fields, answers).flatMap((q) => q.fields));
  const out: Record<string, string> = {};
  for (const q of questions) {
    for (const id of q.fields) {
      if (!shown.has(id) || !(id in answers)) continue;
      const raw = answers[id];
      out[id] = q.kind === 'checkbox' || q.kind === 'choice' ? (ticked(raw) ? '1' : '') : String(raw ?? '');
    }
  }
  return out;
}

/** The answers that start a form: whatever the sender put in a field already. */
export function startingAnswers(questions: Question[], fields: any[]): Record<string, string> {
  const byId = new Map<string, any>(fields.map((f) => [f.id, f]));
  const out: Record<string, string> = {};
  for (const q of questions) for (const id of q.fields) if (byId.get(id)?.value) out[id] = String(byId.get(id).value);
  return out;
}

/** A radio question takes one answer: choosing `value` takes the others off. */
export function choose(q: Question, answers: Record<string, any>, value: string): Record<string, any> {
  const next = { ...answers };
  for (const id of q.fields) next[id] = id === value ? '1' : '';
  return next;
}
