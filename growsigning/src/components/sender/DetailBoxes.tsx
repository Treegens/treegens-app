'use client';
// One box for each of the account's details, such as a case number (src/server/customfields.ts): the same boxes on
// the last step of the editor, in the "Use" dialog of a template and on the page of a document that is out. The
// checks are the server's own (src/lib/customfields.ts), so a value it would refuse says why under its box.
import { useEffect, useState } from 'react';
import { api } from '@/components/ui';
import { PrintNotice, type PrintProblem } from '@/components/sender/PrintNotice';
import { SOURCE_LOCALE, t } from '@/lib/i18n';
import { CUSTOM_VALUE_MAX, DETAILS_MISSING, customKey, readValue, type CustomDef } from '@/lib/customfields';

const ui = SOURCE_LOCALE;
export type Pair = { name: string; value: string; on_certificate?: boolean };
export type Typed = Record<string, string>;

/** What is typed, by detail, from the list an envelope holds. */
export const typedFrom = (pairs: Pair[]): Typed => Object.fromEntries(pairs.map((p) => [customKey(p.name), p.value]));

/**
 * The list as it is saved: every detail with a value that fits, and the kept ones as they are. A value that does
 * not fit is not saved: what was saved before stays, and the problem shows under its box.
 */
export function pairsFrom(defs: CustomDef[], typed: Typed, stored: Pair[] = []): { name: string; value: string }[] {
  const others = stored.filter((p) => !defs.some((d) => customKey(d.name) === customKey(p.name)));
  return [
    ...defs.flatMap((d) => {
      const v = readValue(d, typed[customKey(d.name)] ?? '');
      if ('problem' in v) {
        const before = stored.find((p) => customKey(p.name) === customKey(d.name));
        return before ? [{ name: before.name, value: before.value }] : [];
      }
      return v.value ? [{ name: d.name, value: v.value }] : [];
    }),
    ...others.map((p) => ({ name: p.name, value: p.value })),
  ];
}

/** The required details that have no value that fits, by name. */
export const missingIn = (defs: CustomDef[], typed: Typed): string[] => defs.filter((d) => {
  const v = readValue(d, typed[customKey(d.name)] ?? '');
  return d.required && (!('value' in v) || !v.value);
}).map((d) => d.name);

/** The first thing wrong with what is typed, in words, or null. */
export const firstProblem = (defs: CustomDef[], typed: Typed): string | null => {
  for (const d of defs) {
    const v = readValue(d, typed[customKey(d.name)] ?? '');
    if ('problem' in v) return v.problem;
  }
  return null;
};

// The event a screen sends when a send was refused for a required detail, so the boxes mark themselves and take focus.
const REFUSED = 'cf-details-missing';
/**
 * For the catch of a send: when it was refused because a required detail has no value, the boxes on this screen are
 * told, and the words for the screen are answered ("Fill in Case number under Details below, then send again.").
 * Null for any other refusal.
 */
export function detailsRefused(e: any): string | null {
  if (e?.code !== DETAILS_MISSING) return null;
  const names: string[] = Array.isArray(e.data?.missing) ? e.data.missing.map(String) : [];
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(REFUSED, { detail: names }));
  return t(ui, 'customfields.refused', { names: names.join(', '), count: names.length || 1 });
}
/** The names a refused send asked for, or null when it was refused for something else. */
export const namesRefused = (e: any): string[] | null => (e?.code === DETAILS_MISSING && Array.isArray(e.data?.missing) ? e.data.missing.map(String) : null);
/** Runs `on` with the names whenever a send on this screen was refused for them. */
export function useRefused(on: (names: string[]) => void) {
  useEffect(() => {
    const hear = (ev: Event) => on(((ev as CustomEvent).detail as string[]) || []);
    window.addEventListener(REFUSED, hear);
    return () => window.removeEventListener(REFUSED, hear);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
/** True when the address asks for the Details card ("...#details"). */
export const wantsDetails = (): boolean => typeof window !== 'undefined' && window.location.hash === '#details';
/** Brings the first box that needs a value (or the first box) into view and puts the cursor in it. */
export function focusDetails(root: HTMLElement | null) {
  const el = root?.querySelector<HTMLElement>('[aria-invalid="true"]') || root?.querySelector<HTMLElement>('input, select');
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.focus({ preventScroll: true });
}

// Details printed on the certificate in letters its fonts do not have: the server holds the fonts, so it is asked,
// and only when something is not plain ASCII. A warning, like the one for names and the subject.
function usePrintProblems(defs: CustomDef[], typed: Typed): PrintProblem[] {
  const [problems, setProblems] = useState<PrintProblem[]>([]);
  const texts = defs.filter((d) => d.on_certificate && (typed[customKey(d.name)] || '').trim())
    .map((d) => ({ where: `"${d.name}" under Details`, text: `${d.name} ${typed[customKey(d.name)]}` })).filter((x) => /[^ -~]/.test(x.text));
  const key = JSON.stringify(texts);
  useEffect(() => {
    if (!texts.length) return setProblems([]);
    let on = true;
    const timer = setTimeout(() => api('/print-check', { body: { texts } }).then((r) => on && setProblems(r.problems || [])).catch(() => {}), 400);
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return problems;
}

export function DetailBoxes({ defs, typed, onChange, flagged = [], template, locked, idPrefix = 'cf' }: {
  defs: CustomDef[]; typed: Typed; onChange: (d: CustomDef, value: string) => void;
  /** Names a refused send asked for: their boxes say so until they have a value. */
  flagged?: string[]; template?: boolean; locked?: boolean; idPrefix?: string;
}) {
  const print = usePrintProblems(defs, typed);
  return (
    <>
      <div className="cf-grid">
        {defs.map((d) => {
          const hint = `${idPrefix}-hint-${d.id}`;
          const now = typed[customKey(d.name)] ?? '';
          const v = readValue(d, now);
          const problem = 'problem' in v ? v.problem : null;
          const empty = flagged.some((n) => customKey(n) === customKey(d.name)) && !('problem' in v) && !v.value;
          // A value from before a choice was taken out is still listed, so the sender sees what to change.
          const gone = d.kind === 'list' && now && !d.choices.some((c) => customKey(c) === customKey(now));
          const says = problem || (empty ? t(ui, 'customfields.step.fill') : d.on_certificate ? t(ui, 'customfields.step.printed') : '');
          return (
            <label key={d.id} className="f cf-box">
              <span>{d.name}{d.required && <span className="cf-req"> {t(ui, template ? 'customfields.step.needed_to_send' : 'customfields.step.required')}</span>}</span>
              {d.kind === 'list' ? (
                <select value={now} disabled={locked} onChange={(e) => onChange(d, e.target.value)} aria-describedby={says ? hint : undefined} aria-invalid={!!problem || empty}>
                  <option value="">{t(ui, 'customfields.step.choose')}</option>
                  {gone && <option value={now}>{t(ui, 'customfields.step.not_a_choice', { value: now })}</option>}
                  {d.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input value={now} readOnly={locked} maxLength={CUSTOM_VALUE_MAX} autoComplete="off" onChange={(e) => onChange(d, e.target.value)} aria-describedby={says ? hint : undefined} aria-invalid={!!problem || empty} />
              )}
              {says && <span id={hint} className={`hint${problem || empty ? ' cf-wrong' : ''}`}>{says}</span>}
            </label>
          );
        })}
      </div>
      <PrintNotice problems={print} />
    </>
  );
}
