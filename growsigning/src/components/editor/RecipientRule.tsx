'use client';
import { useState } from 'react';
import { CONDS_FOR, COND_WORDS, NEEDS_VALUE, type Cond } from '@/lib/logic';
import { onlyWhenOf, isInstead, fieldsBefore, insteadOf, canHaveRule, usableRule, condWords, answerAfter, type OnlyWhen } from '@/lib/routing';
import { personInSentence } from '@/lib/editorux';
import { logicName } from './FieldLogic';
import { type Ed } from './shared';

// "Only when...", one line of a person's More (research/ux-charter.md 2.3 item 6, research/ux-notes.json
// ds-routing-if). Listed only once the document has an answer of someone else it can test (so after fields are
// placed in step 2, or in a template), or someone in the same step it can stand in for. When that someone does not
// sign before this person yet, the line says so and offers "Put Max after Ana". Off by default: everyone is asked,
// and starting a rule saves nothing until it is complete. The server checks the same rule when it is saved and decides it when the step is reached
// (src/server/routing.ts).

const who = (r: any) => personInSentence(r);

/** The rule in a few words, for the line, step 3's Who gets it and the envelope page. Empty when there is none. */
export function ruleSaid(r: any, people: any[], fields: any[]): string {
  const w = onlyWhenOf(r);
  if (!w) return '';
  if (isInstead(w)) {
    const t = people.find((p) => p.id === w.otherwise);
    return `Only when ${t ? who(t) : 'the other person'} is not asked`;
  }
  const f = fields.find((x) => x.id === w.field);
  return `Only when ${f ? logicName(f) : 'an answer that is gone'} is ${condWords(w.is, f?.type || 'text', w.value)}`;
}

/** One line under a person in step 3 when a rule is set, or a warning when it stopped working. */
export function RuleLine({ ed, r }: { ed: Ed; r: any }) {
  const w = onlyWhenOf(r);
  if (!w) return null;
  const fields = ed.fields.value;
  if (!usableRule(r, ed.rcps, fields, !!ed.env?.ordered))
    return <div className="small notice warn" data-feature="ds-routing-if" style={{ marginTop: 4 }}>The rule for {who(r)} no longer works, so {who(r)} is always asked. Open their More in step 1 to choose another answer.</div>;
  return <div className="small" data-feature="ds-routing-if" style={{ marginTop: 3 }}>{ruleSaid(r, ed.rcps, fields)}</div>;
}

/** A rule being chosen: nothing is saved until it is complete (field, answer and, where needed, a value). */
type Draft = { field: string; is: Cond | ''; value?: string };
const complete = (d: Draft, f: any): boolean => !!f && !!d.is && (CONDS_FOR[f.type] || []).includes(d.is as Cond) && (!NEEDS_VALUE.includes(d.is as Cond) || String(d.value ?? '').trim() !== '');

export function RecipientRule({ ed, r }: { ed: Ed; r: any }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const fields = ed.fields.value;
  const people = ed.rcps;
  const ordered = !!ed.env?.ordered;
  const w = onlyWhenOf(r);
  // Someone whose answer could count, who does not sign before this person yet: the line is still listed, and says how.
  const first = answerAfter(r, people, fields, ordered);
  if (!w && !canHaveRule(r, people, fields, ordered) && !first) return null;
  const usable = usableRule(r, people, fields, ordered);
  const answers = fieldsBefore(r, people, fields, ordered);
  const instead = insteadOf(r, people);
  const owner = (f: any) => people.find((p) => p.id === f.recipient_id);
  const patch = (only_when: OnlyWhen | null) => ed.patchRcp(r.id, { only_when });
  const locked = !!ed.wording;
  const id = `ed-rule-${r.id}`;
  const TALL = { minHeight: 44, maxWidth: '100%' } as const;
  // The rule on screen: the one being chosen, else the saved answer rule.
  const cur: Draft | null = draft ?? (w && !isInstead(w) ? { field: w.field, is: w.is, value: w.value } : null);
  const field = cur ? answers.find((x) => x.id === cur.field) || null : null;
  const edit = (next: Draft) => {
    const f = answers.find((x) => x.id === next.field);
    if (complete(next, f)) {
      setDraft(null);
      patch({ field: next.field, is: next.is as Cond, ...(NEEDS_VALUE.includes(next.is as Cond) ? { value: String(next.value).trim() } : {}) });
    } else {
      setDraft(next);
      // Never a half rule: until it is complete, the person is always asked, and the line says so.
      if (w) patch(null);
    }
  };
  const pickField = (fid: string) => {
    const f = answers.find((x) => x.id === fid);
    const keep = cur?.is && f && (CONDS_FOR[f.type] || []).includes(cur.is as Cond) ? cur.is : '';
    edit({ field: fid, is: keep, value: keep ? cur?.value : undefined });
  };
  const always = () => {
    setDraft(null);
    patch(null);
  };
  // "Put Max after Ana": the signing order goes on, and this person comes straight after the one who answers.
  const putAfter = (p: any) => {
    if (!ordered) ed.patchEnv({ ordered: 1 });
    ed.patchRcp(r.id, { routing_order: Math.max(Number(r.routing_order) || 1, (Number(p.routing_order) || 1) + 1) });
  };
  // People in the same step with no rule of their own, who could be asked when this person is not.
  const standIns = w && !isInstead(w) && usable ? people.filter((p) => p.id !== r.id && p.role !== 'witness' && p.role !== 'cc' && Number(p.routing_order) === Number(r.routing_order) && !onlyWhenOf(p)) : [];
  const value = draft ? 'Always asked' : !w ? 'Always asked' : usable ? ruleSaid(r, people, fields).replace(/^Only when /, '') : 'Stopped working';

  return (
    <div className="ed-line" data-feature="ds-routing-if">
      <button type="button" className="ed-line-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span>Only when: <b>{value}</b></span><span aria-hidden="true" className="ed-line-go">{open ? 'Close' : 'Change'}</span>
      </button>
      {open && (
        <div className="ed-pick" id={id} role="group" aria-label={`Only when, for ${who(r)}`} style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          {w && isInstead(w) ? (
            <>
              <p className="small" style={{ margin: 0, overflowWrap: 'anywhere' }} aria-live="polite">
                {usable ? <><b>{who(r)} is asked {ruleSaid(r, people, fields).replace(/^Only when/, 'only when')}.</b> Otherwise {who(r)} is not asked and gets no email.</> : <>This rule no longer works, so {who(r)} is always asked.</>}
              </p>
              <button type="button" className="btn sm" style={TALL} disabled={locked} onClick={always}>Always ask {who(r)}</button>
            </>
          ) : !cur ? (
            first && !answers.length ? (
              <>
                <p className="muted small" style={{ margin: 0 }}>{who(r)} is always asked. To ask {who(r)} only after an answer, {who(r)} must sign after the person who gives it.</p>
                {!locked && <button type="button" className="btn sm" style={TALL} onClick={() => putAfter(first)}>Put {who(r)} after {who(first)}</button>}
                {!ordered && <p className="muted small" style={{ margin: 0 }}>This turns on signing order, so people sign one after the other, by their numbers.</p>}
              </>
            ) : (
              <>
                <p className="muted small" style={{ margin: 0 }}>{who(r)} is always asked. You can ask them only after a certain answer of someone before them{instead.length ? ', or instead of someone else' : ''}.</p>
                {answers.length > 0 && <button type="button" className="btn sm" style={TALL} disabled={locked} onClick={() => setDraft({ field: '', is: '' })}>Only ask {who(r)} when...</button>}
                {instead.map((p) => <button key={p.id} type="button" className="btn sm" style={TALL} disabled={locked} onClick={() => patch({ otherwise: p.id })}>Ask {who(r)} instead of {who(p)}</button>)}
              </>
            )
          ) : (
            <>
              {draft ? (
                <p className="muted small" style={{ margin: 0 }} aria-live="polite">Choose the answer. Until the rule is complete, {who(r)} is always asked.</p>
              ) : usable ? (
                <p className="small" style={{ margin: 0, overflowWrap: 'anywhere' }} aria-live="polite">
                  <b>{who(r)} is asked {ruleSaid(r, people, fields).replace(/^Only when/, 'only when')}.</b> Otherwise {who(r)} is not asked and gets no email.
                </p>
              ) : (
                <p className="notice warn small" role="status" style={{ margin: 0 }}>This rule no longer works: the answer it read is gone, or that person no longer signs before {who(r)}. Until you choose again, {who(r)} is always asked.</p>
              )}
              <label className="f" style={{ margin: 0 }}><span>Depends on</span>
                <select style={TALL} disabled={locked} value={field ? field.id : ''} onChange={(e) => pickField(e.target.value)}>
                  {!field && <option value="">Choose one</option>}
                  {answers.map((f) => <option key={f.id} value={f.id}>{logicName(f)}{owner(f) ? `, filled in by ${who(owner(f))}` : ''}</option>)}
                </select>
              </label>
              {field && (
                <label className="f" style={{ margin: 0 }}><span>Answer</span>
                  <select style={TALL} disabled={locked} value={cur.is} onChange={(e) => edit({ ...cur, is: e.target.value as Cond, value: field.type === 'dropdown' && !cur.value ? '' : cur.value })}>
                    {!cur.is && <option value="">Choose one</option>}
                    {CONDS_FOR[field.type].map((c) => <option key={c} value={c}>{COND_WORDS[c](field.type)}</option>)}
                  </select>
                </label>
              )}
              {field && cur.is && NEEDS_VALUE.includes(cur.is as Cond) && (field.type === 'dropdown' ? (
                <label className="f" style={{ margin: 0 }}><span>Choice</span>
                  <select style={TALL} disabled={locked} value={cur.value ?? ''} onChange={(e) => edit({ ...cur, value: e.target.value })}>
                    {!(field.options || []).includes(cur.value) && <option value={cur.value ?? ''}>{cur.value ? `${cur.value} (not one of its choices)` : 'Choose one'}</option>}
                    {(field.options || []).map((o: string) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
              ) : (
                <label className="f" style={{ margin: 0 }}><span>{field.type === 'number' ? 'Number' : 'Words'}</span>
                  <input style={TALL} disabled={locked} value={cur.value ?? ''} maxLength={200} inputMode={field.type === 'number' ? 'decimal' : undefined} onChange={(e) => edit({ ...cur, value: e.target.value })} />
                </label>
              ))}
              {standIns.map((p) => (
                <button key={p.id} type="button" className="btn sm" style={TALL} disabled={locked} onClick={() => ed.patchRcp(p.id, { only_when: { otherwise: r.id } })}>Ask {who(p)} instead when {who(r)} is not asked</button>
              ))}
              <button type="button" className="btn sm" style={TALL} disabled={locked} onClick={always}>{draft && !w ? 'Cancel' : `Always ask ${who(r)}`}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
