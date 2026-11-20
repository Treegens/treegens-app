'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  CONDS_FOR, COND_WORDS, NEEDS_VALUE, ALWAYS_SHOWN, ruleOf, ruleWords, formulaWords, parseFormula, namesIn, renameRefs, loopsIn,
  logicWarnings, MAX_DECIMALS, dependsOn, dropField, type Cond,
} from '@/lib/logic';
import { TLABEL, type Ed } from './shared';

// "Only show when..." and, for a number field, "Calculate from..." in the settings of the selected field. Each rule
// is said back as a sentence, so the sender reads what the signer will get. The server checks the same rules again
// when the envelope is saved (src/server/logic.ts) and refuses a loop in words that name the fields.

/** A field by its label, or what it is and where. The words a sender sees for it. */
export const logicName = (f: any): string => (f?.label ? String(f.label) : `${TLABEL[f?.type] || 'Field'} on page ${Number(f?.page || 0) + 1}`);

const SHOWABLE = (f: any) => !!CONDS_FOR[f?.type];
/** Every field that depends on `fid`, directly or through others: none of them can be what `fid` depends on. */
function dependents(fields: any[], fid: string): Set<string> {
  const users = new Map<string, string[]>();
  for (const f of fields) for (const d of dependsOn(f)) users.set(d, [...(users.get(d) || []), f.id]);
  const out = new Set<string>();
  const todo = [fid];
  while (todo.length) for (const u of users.get(todo.pop()!) || []) if (!out.has(u)) (out.add(u), todo.push(u));
  return out;
}
const ROUND = /^\s*round\(([\s\S]*),\s*(\d+)\s*\)\s*$/i;
// Each part sits in the settings panel under the others, with room between them and full-width controls.
const BOX = { margin: '16px 0 12px', display: 'grid', gap: 8 } as const;
const HEAD = { margin: 0, fontSize: 15 } as const;
const CHIPS = { display: 'flex', flexWrap: 'wrap', gap: 6 } as const;
// Every control here answers a thumb over at least 44 px, like the editor's buttons on a phone.
const TALL = { minHeight: 44 } as const;

export function FieldLogic({ field, fields, patch }: { field: any; fields: any[]; patch: (p: any) => void }) {
  if (ALWAYS_SHOWN(field.type) || !field.recipient_id) return null;
  return (
    <>
      <ShowWhen field={field} fields={fields} patch={patch} />
      {field.type === 'number' && <Formula field={field} fields={fields} patch={patch} />}
    </>
  );
}

function ShowWhen({ field, fields, patch }: { field: any; fields: any[]; patch: (p: any) => void }) {
  const rule = ruleOf(field);
  // Fields of the same person that can be asked about, and that do not already depend on this one (that would be a
  // circle, which could never be shown).
  const below = useMemo(() => dependents(fields, field.id), [fields, field.id]);
  const parents = fields.filter((p) => p.id !== field.id && p.recipient_id === field.recipient_id && SHOWABLE(p) && !below.has(p.id));
  const parent = rule ? fields.find((p) => p.id === rule.field) : null;
  const broken = !!rule && (!parent || parent.recipient_id !== field.recipient_id || !SHOWABLE(parent));
  const id = `ed-sw-${field.id}`;
  const set = (p: any, is?: Cond, value?: string) => {
    const conds: Cond[] = CONDS_FOR[p.type];
    const c = is && conds.includes(is) ? is : conds[0];
    patch({ show_when: { field: p.id, is: c, ...(NEEDS_VALUE.includes(c) ? { value: value ?? (p.type === 'dropdown' ? p.options?.[0] ?? '' : '') } : {}) } });
  };
  if (!rule)
    return (
      <div className="ed-logic" style={BOX}>
        <h4 style={HEAD} className="ed-logic-h">Only show when...</h4>
        {parents.length ? (
          <>
            <p className="muted small">Always shown. You can show it only when another field of the same person has a certain answer, such as a box that is ticked.</p>
            <button type="button" className="btn sm ed-tap" onClick={() => set(parents[0])}>Only show when...</button>
          </>
        ) : (
          <p className="muted small">Always shown. To show it only after a certain answer, first add a tick box, a choice, a text or a number field for the same person.</p>
        )}
      </div>
    );
  return (
    <div className="ed-logic" style={BOX} role="group" aria-labelledby={`${id}-h`}>
      <h4 style={HEAD} className="ed-logic-h" id={`${id}-h`}>Only show when...</h4>
      {broken ? (
        <p className="notice warn small" role="status">The field this depended on was removed or now belongs to someone else, so this field would never be shown. Choose another field, or choose Always show.</p>
      ) : (
        <p className="ed-logic-says" aria-live="polite"><b>{ruleWords(rule, parent, logicName(parent))}.</b> Until then it is hidden: not required, any answer in it is cleared, and nothing is printed.</p>
      )}
      <label className="f"><span>Field</span>
        <select style={TALL} value={parent && !broken ? parent.id : ''} onChange={(e) => { const p = fields.find((x) => x.id === e.target.value); if (p) set(p, rule.is, rule.value ?? undefined); }}>
          {(!parent || broken) && <option value="">Choose a field</option>}
          {parents.map((p) => <option key={p.id} value={p.id}>{logicName(p)}</option>)}
        </select>
      </label>
      {parent && !broken && (
        <label className="f"><span>Answer</span>
          <select style={TALL} value={rule.is} onChange={(e) => set(parent, e.target.value as Cond, rule.value ?? undefined)}>
            {CONDS_FOR[parent.type].map((c) => <option key={c} value={c}>{COND_WORDS[c](parent.type)}</option>)}
          </select>
        </label>
      )}
      {parent && !broken && NEEDS_VALUE.includes(rule.is) && (parent.type === 'dropdown' ? (
        <label className="f"><span>Choice</span>
          <select style={TALL} value={rule.value ?? ''} onChange={(e) => set(parent, rule.is, e.target.value)}>
            {!(parent.options || []).includes(rule.value) && <option value={rule.value ?? ''}>{rule.value ? `${rule.value} (not one of its choices)` : 'Choose one'}</option>}
            {(parent.options || []).map((o: string) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      ) : (
        <label className="f"><span>{parent.type === 'number' ? 'Number' : 'Words'}</span>
          <input style={TALL} value={rule.value ?? ''} maxLength={200} inputMode={parent.type === 'number' ? 'decimal' : undefined} onChange={(e) => set(parent, rule.is, e.target.value)} />
        </label>
      ))}
      <button type="button" className="btn sm ed-tap" onClick={() => patch({ show_when: null })}>Always show</button>
    </div>
  );
}

function Formula({ field, fields, patch }: { field: any; fields: any[]; patch: (p: any) => void }) {
  const numbers = fields.filter((f) => f.id !== field.id && f.type === 'number');
  const byId = useMemo(() => new Map<string, any>(fields.map((f) => [f.id, f])), [fields]);
  // The sender reads and writes the formula with labels. It is kept with the fields' ids, so a renamed label or a
  // second field with the same label never changes what it adds up.
  const shown = (src: any) => renameRefs(src, (k) => byId.get(k)?.label || k);
  const [text, setText] = useState(() => shown(field.formula || ''));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(shown(field.formula || ''));
  }, [field.id, field.formula]); // eslint-disable-line react-hooks/exhaustive-deps
  const id = `ed-fx-${field.id}`;
  const resolve = (src: string): { ids: string | null; problem: string } => {
    for (const n of namesIn(src)) {
      const hits = numbers.filter((f) => f.id === n || (f.label || '').trim().toLowerCase() === n.toLowerCase());
      if (!hits.length) return { ids: null, problem: `There is no number field called "${n}". Use the label of one, as listed below.` };
      if (hits.length > 1) return { ids: null, problem: `${hits.length} number fields are called "${n}". Give them different labels first.` };
    }
    try {
      parseFormula(src);
    } catch (e: any) {
      return { ids: null, problem: e.message };
    }
    const ids = renameRefs(src, (n) => numbers.find((f) => f.id === n || (f.label || '').trim().toLowerCase() === n.toLowerCase())?.id || n);
    if (loopsIn(fields.map((x) => (x.id === field.id ? { ...x, formula: ids } : x))).length) return { ids: null, problem: 'This formula would depend on itself through another field, so it could never be worked out. Use other fields.' };
    return { ids, problem: '' };
  };
  const now = resolve(text);
  const change = (src: string) => {
    setText(src);
    const r = resolve(src);
    // A formula that cannot be read yet is kept as typed: the review step and the save say what is wrong with it.
    patch({ formula: r.ids ?? src });
  };
  const m = ROUND.exec(text);
  const decimals = m ? m[2] : '';
  const inner = m ? m[1].trim() : text;
  if (field.formula == null && !editing)
    return (
      <div className="ed-logic" style={BOX}>
        <h4 style={HEAD} className="ed-logic-h">Calculate from...</h4>
        {numbers.length ? (
          <>
            <p className="muted small">Typed in by the signer. You can have it worked out from other number fields instead, for a total or a price.</p>
            <button type="button" className="btn sm ed-tap" onClick={() => (setEditing(true), change(numbers.filter((f) => f.label).map((f) => `{${f.label}}`).slice(0, 2).join(' * ') || ''))}>Calculate from...</button>
          </>
        ) : (
          <p className="muted small">Typed in by the signer. To work it out from other numbers instead, first add the number fields it comes from.</p>
        )}
      </div>
    );
  return (
    <div className="ed-logic" style={BOX} role="group" aria-labelledby={`${id}-h`}>
      <h4 style={HEAD} className="ed-logic-h" id={`${id}-h`}>Calculate from...</h4>
      <p className="muted small">Worked out by itself, so the signer cannot type in it, and Required and the prefilled value do not apply.</p>
      <label className="f"><span>Formula</span>
        <input style={TALL} id={id} value={text} maxLength={500} spellCheck={false} autoComplete="off" aria-describedby={`${id}-help ${id}-says`} aria-invalid={!!now.problem}
          onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} onChange={(e) => change(e.target.value)} />
      </label>
      <p className="muted small" id={`${id}-help`}>Field names go in curly brackets. Use + - * / and round brackets; sum(&#123;A&#125;, &#123;B&#125;) adds up a list. An empty field counts as 0, and dividing by 0 leaves it empty. Numbers in the formula take a dot before decimals, like 0.2.</p>
      <p id={`${id}-says`} className={now.problem ? 'sg-fielderr small' : 'ed-logic-says'} aria-live="polite">
        {now.problem ? now.problem : <b>Worked out as {formulaWords(now.ids, (k) => logicName(byId.get(k)))}.</b>}
      </p>
      {numbers.length > 0 && (
        <div className="ed-logic-chips" style={CHIPS} role="group" aria-label="Put a field in the formula">
          {numbers.map((f) => (f.label ? (
            <button key={f.id} type="button" className="btn sm ed-tap" onClick={() => change(`${text.trim()}${text.trim() && !/[+\-*/(,]\s*$/.test(text) ? ' + ' : ' '}{${f.label}}`.trim())}>{f.label}</button>
          ) : <span key={f.id} className="muted small">{logicName(f)} has no label. Give it one to use it here.</span>))}
        </div>
      )}
      <label className="f"><span>Round the result to</span>
        <select style={TALL} value={decimals} onChange={(e) => change(e.target.value === '' ? inner : `round(${inner}, ${e.target.value})`)}>
          <option value="">As many decimals as it has</option>
          {Array.from({ length: MAX_DECIMALS + 1 }, (_, i) => <option key={i} value={String(i)}>{i} decimal{i === 1 ? '' : 's'}</option>)}
        </select>
      </label>
      <button type="button" className="btn sm ed-tap" onClick={() => (setEditing(false), setText(''), patch({ formula: null, value: null }))}>Let the signer type it</button>
    </div>
  );
}

/** Deleting a field others depend on: see withoutField in src/lib/logic.ts. Named the way the editor names fields. */
export const withoutField = (list: any[], fid: string) => dropField(list, fid, logicName);

/** The review step: rules that can never be true and inputs a formula cannot reach, before anything is sent. */
export function LogicCheck({ ed }: { ed: Ed }) {
  const list = ed.fields.value;
  const said = useMemo(() => {
    const out = logicWarnings(list, ed.rcps, !!ed.env?.ordered, logicName);
    // A formula that cannot be read or names a field that is not there: the save would refuse it, so say it first.
    for (const f of list) {
      if (!f.formula) continue;
      try {
        parseFormula(f.formula);
        const missing = namesIn(f.formula).filter((n) => !list.some((x) => x.id === n && x.type === 'number'));
        if (missing.length) out.unshift(`The formula of '${logicName(f)}' uses ${missing.map((n) => `"${n}"`).join(', ')}, which is not a number field of this envelope. Open it under "Calculate from" and choose its fields again.`);
      } catch (e: any) {
        out.unshift(`The formula of '${logicName(f)}' cannot be read: ${e.message}`);
      }
    }
    return out;
  }, [list, ed.rcps, ed.env?.ordered]);
  if (!said.length) return null;
  return (
    <section className="notice warn" aria-labelledby="ed-logic-h">
      <b id="ed-logic-h">Check the rules and formulas.</b> {said.length === 1 ? 'This one does' : 'These do'} not work the way the signer would expect.
      <ul className="ed-nolabel">{said.map((s) => <li key={s}><span>{s}</span></li>)}</ul>
    </section>
  );
}
