// The signing page's side of conditional fields and formulas: which of this person's fields are shown, what every
// calculated field comes to, and what to say when a field appears or goes. It works live, so the page feels right,
// with the same functions the server uses (src/lib/logic.ts). The server works it all out again from what is stored
// when the person saves and finishes, so nothing here decides what is signed.
import { useEffect, useMemo, useRef, useState } from 'react';
import { workOut, formulaWords, CALC_EMPTY, type Calc } from '../../lib/logic.ts';
import { fieldName, AUTO } from './fields.ts';

const OTHER = '\u0000other';

/** A calculated field's line under it: how it is worked out, from which numbers, or why it is empty. */
export function calcNote(f: any, c: Calc | undefined, nameOf: (id: string) => string): string {
  const how = `Worked out for you from ${formulaWords(f.formula, nameOf)}.`;
  if (!c) return how;
  if (c.error) return `${how} ${c.error}`;
  if (c.empty) return `${how} ${CALC_EMPTY}`;
  return `${how} With ${c.numbers}, that comes to ${c.text}. Empty fields count as 0.${c.ambiguous.length ? ` ${c.ambiguous.join(' ')}` : ''}`;
}

/**
 * Everything the page needs, from the person's own fields (`mine`, as the server sent them), the fields of other
 * people that are on the page (`others`) and the answers as they stand. `fields` is what the page shows: the hidden
 * ones are left out, and a calculated field is read only, holding its result, with `calc_note` saying how. Other
 * people's answers only count once they have finished ("signer") or when the sender wrote them ("sender"), as on
 * the server.
 */
export function liveLogic(mine: any[], others: any[], values: Record<string, string>) {
  const view = [
    ...mine.map((f) => ({ ...f, value: f.readonly ? f.value : values[f.id] ?? '' })),
    ...others.map((o) => ({ id: o.id, type: o.type, label: o.label, recipient_id: OTHER, value: o.from === 'signer' || o.from === 'sender' ? o.value : null })),
  ];
  const names = new Map<string, string>(view.map((f) => [f.id, fieldName(f)]));
  const nameOf = (id: string) => names.get(id) || 'a field';
  const out = workOut(view, { stored: (f) => f.recipient_id === OTHER, name: (f) => fieldName(f) });
  const fields = mine.filter((f) => !out.hidden.has(f.id)).map((f) => {
    if (!f.formula) return f;
    const c = out.calc.get(f.id);
    return { ...f, readonly: 1, required: 0, value: c?.text ?? '', calc_note: calcNote(f, c, nameOf) };
  });
  return { fields, hidden: out.hidden };
}

/** Fields the person fills in themselves, the ones that are worth announcing when they appear or go. */
const theirs = (f: any) => !f.readonly && !f.formula && !AUTO.includes(f.type);

/**
 * The hook the signing page uses. Besides what liveLogic gives: an answer in a field that is hidden is cleared (it
 * goes back to what the sender put there, as on the server), a field that appears or goes is said in `said` (for a
 * polite live region), and `appeared` is the field that just appeared, so Next goes there first. It stops being
 * that once the person is on it, fills it in, or it goes again.
 */
export function useLiveLogic(mine: any[], others: any[], values: Record<string, string>, setValues: (fn: (v: Record<string, string>) => Record<string, string>) => void) {
  const live = useMemo(() => liveLogic(mine, others, values), [mine, others, values]);
  const [said, setSaid] = useState('');
  const [appeared, setAppeared] = useState<string | null>(null);
  const before = useRef<Set<string> | null>(null);
  const hiddenKey = [...live.hidden].sort().join('|');
  useEffect(() => {
    const shown = new Set<string>(mine.filter((f) => theirs(f) && !live.hidden.has(f.id)).map((f) => f.id));
    const was = before.current;
    before.current = shown;
    // Answers in fields that are hidden now are cleared, so what is on the screen is what will be saved.
    const clear = mine.filter((f) => live.hidden.has(f.id) && !f.readonly && (values[f.id] ?? '') !== (f.prefill ?? ''));
    if (clear.length) setValues((v) => ({ ...v, ...Object.fromEntries(clear.map((f) => [f.id, f.prefill ?? ''])) }));
    if (!was) return; // the first look: nothing appeared, it was all there
    const came = mine.filter((f) => shown.has(f.id) && !was.has(f.id));
    const went = mine.filter((f) => theirs(f) && was.has(f.id) && !shown.has(f.id));
    const words: string[] = [];
    if (came.length) words.push(`${came.length === 1 ? 'A field appeared' : `${came.length} fields appeared`}: ${came.map((f) => `${fieldName(f)}, ${f.required ? 'required' : 'optional'}`).join('; ')}.${came.some((f) => f.required) ? ' Next goes there.' : ''}`);
    if (went.length) words.push(`${went.length === 1 ? 'A field is no longer needed' : `${went.length} fields are no longer needed`}: ${went.map((f) => fieldName(f)).join(', ')}.${clear.some((f) => went.includes(f)) ? ' What was in it was cleared.' : ''}`);
    if (words.length) setSaid(words.join(' '));
    if (came.length) setAppeared(came[0].id);
    else if (appeared && !shown.has(appeared)) setAppeared(null);
  }, [hiddenKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Once the person is on the field that appeared, or has filled it in, Next goes back to its usual order.
  useEffect(() => {
    if (!appeared) return;
    if (values[appeared]) return setAppeared(null);
    const on = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.(`#f-${CSS.escape(appeared)}, #t-${CSS.escape(appeared)}`) || el?.id === `t-${appeared}`) setAppeared(null);
    };
    document.addEventListener('focusin', on);
    return () => document.removeEventListener('focusin', on);
  }, [appeared, values]);
  return { ...live, said, appeared };
}
