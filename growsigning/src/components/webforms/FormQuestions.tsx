'use client';
// A form's questions, one at a time on every screen (ds-web-forms). Each question is a field of the document: its
// label is the question, its format and limits are the help line, and a question whose "Only show when" is not met is
// skipped. Next checks the answer with the same rules the server uses (src/lib/webforms.ts).
import { useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { shownQuestions, answerProblem, choose, type Question } from '@/lib/webforms';

type Props = {
  locale: string;
  questions: Question[];
  fields: any[];
  dateFormat?: string | null;
  answers: Record<string, any>;
  onAnswers: (a: Record<string, any>) => void;
  /** Called with the answers when the person leaves a question with Next (to keep them). */
  onStep: (a: Record<string, any>) => void;
  /** The person went back from the first question. */
  onBack: () => void;
  /** Every shown question is answered. */
  onDone: (a: Record<string, any>) => void;
  /** Which shown question is on screen, kept by the page (each one is an entry in the browser's history). */
  at: number;
  onAt: (i: number) => void;
};

export function FormQuestions({ locale, questions, fields, dateFormat, answers, onAnswers, onStep, onBack, onDone, at: wanted, onAt }: Props) {
  const w = (k: string, v?: any) => t(locale, k, v);
  const shown = shownQuestions(questions, fields, answers);
  const at = Math.max(0, Math.min(wanted, shown.length - 1));
  const [problem, setProblem] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const q = shown[Math.min(at, shown.length - 1)];
  const prev = at > 0 ? shown[at - 1] : null;

  if (!q) return null;
  const set = (key: string, v: any) => (setProblem(''), onAnswers({ ...answers, [key]: v }));
  const value = answers[q.key] ?? '';

  function next(e: React.FormEvent) {
    e.preventDefault();
    const why = answerProblem(q, fields, answers, dateFormat);
    if (why) return setProblem(why);
    onStep(answers);
    // What comes next is worked out again: this answer may have shown or hidden the questions after it.
    const after = shownQuestions(questions, fields, answers);
    const i = after.findIndex((x) => x.key === q.key);
    if (i < 0 || i >= after.length - 1) return onDone(answers);
    onAt(i + 1);
  }

  const id = `q-${q.key.replace(/[^\w-]/g, '_')}`;
  return (
    // A new form for each question, so the cursor lands in its answer and a screen reader reads its question.
    <form key={q.key} className="card" onSubmit={next} noValidate>
      <div className="muted small" aria-live="polite">{w('form.question_of', { n: String(at + 1), total: String(shown.length) })}{q.section !== shown[0].section && (!prev || prev.section !== q.section) ? ` · ${q.section}` : ''}</div>
      <h2 ref={heading} tabIndex={-1} id={`${id}-h`} style={{ margin: '8px 0 4px', fontSize: 20, outline: 'none' }}>
        {q.label}{!q.required && q.kind !== 'checkbox' && <span className="muted small" style={{ fontWeight: 400 }}> ({w('form.optional')})</span>}
      </h2>
      {q.help && <p className="muted small" id={`${id}-help`} style={{ margin: '0 0 8px' }}>{q.help}</p>}
      <div style={{ margin: '12px 0' }}>
        {q.kind === 'checkbox' ? (
          <label className="check" style={{ minHeight: 44 }}>
            <input type="checkbox" autoFocus aria-labelledby={`${id}-h`} checked={value === '1'} onChange={(e) => set(q.key, e.target.checked ? '1' : '')} style={{ width: 24, height: 24 }} aria-describedby={q.help ? `${id}-help` : undefined} />
            <span>{w('form.tick_yes')}</span>
          </label>
        ) : q.kind === 'choice' ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }} aria-labelledby={`${id}-h`}>
            {q.options.map((o) => (
              <label key={o.value} className="check" style={{ minHeight: 44 }}>
                <input type="radio" name={id} autoFocus={o === q.options[0]} checked={answers[o.value] === '1'} onChange={() => (setProblem(''), onAnswers(choose(q, answers, o.value)))} style={{ width: 24, height: 24 }} />
                <span>{o.label}</span>
              </label>
            ))}
          </fieldset>
        ) : q.kind === 'dropdown' ? (
          <select autoFocus aria-labelledby={`${id}-h`} value={value} onChange={(e) => set(q.key, e.target.value)} style={{ minHeight: 44, width: '100%' }}>
            <option value="">{w('form.choose')}</option>
            {q.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <input aria-labelledby={`${id}-h`} aria-describedby={q.help ? `${id}-help` : undefined} aria-invalid={!!problem} dir="auto"
            type={q.kind === 'date' ? 'date' : 'text'} inputMode={q.kind === 'number' ? 'decimal' : undefined} maxLength={q.max ?? 4000}
            value={value} onChange={(e) => set(q.key, e.target.value)} style={{ minHeight: 44, width: '100%' }} autoFocus />
        )}
      </div>
      {problem && <div className="notice err" role="alert" style={{ marginBottom: 12 }}>{problem}</div>}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn" style={{ minHeight: 44 }} onClick={() => (setProblem(''), onBack())}>{w('form.back')}</button>
        <button className="btn primary grow" style={{ minHeight: 44 }}>{at === shown.length - 1 ? w('form.see_document') : w('form.next')}</button>
      </div>
    </form>
  );
}
