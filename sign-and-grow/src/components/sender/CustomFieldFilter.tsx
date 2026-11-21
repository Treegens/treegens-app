'use client';
// The envelope list, behind its "More options": narrow it to one value of a custom field ("Case number" is 2026/114), and show one custom field
// as a column (src/server/customfields.ts, GET /envelopes?field=&value=). Names that only older envelopes still carry,
// because their field was deleted since, can be filtered by too. With no custom fields anywhere, nothing is shown.
import { useEffect, useRef, useState } from 'react';
import { api, useLoad } from '@/components/ui';
import { SOURCE_LOCALE, t } from '@/lib/i18n';
import { CUSTOM_VALUE_MAX, customKey, type CustomDef } from '@/lib/customfields';

const ui = SOURCE_LOCALE;
export type CustomView = { field: string; value: string; col: string };

/** The value of the custom field `name` on a row of the list, or ''. */
export const customValue = (row: any, name: string): string => (name ? (row.custom_fields || []).find((x: any) => customKey(x.name) === customKey(name))?.value || '' : '');

export function CustomFieldFilter({ view, onChange }: { view: CustomView; onChange: (p: Partial<CustomView>) => void }) {
  const [data] = useLoad<any>(() => api('/custom-fields'), []);
  const [typed, setTyped] = useState(view.value);
  const [open, setOpen] = useState(false);
  const first = useRef<HTMLSelectElement>(null);
  // Set by a press on the button, so the cursor moves into what it opened (and not when the page loads with a filter on).
  const pressed = useRef(false);
  useEffect(() => setTyped(view.value), [view.value]);
  // Typing waits a moment before the list is asked again, like the search box.
  useEffect(() => {
    const timer = setTimeout(() => typed.trim() !== view.value && onChange({ value: typed.trim() }), 300);
    return () => clearTimeout(timer);
  }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps
  // Behind the list's "More options", closed until asked for. A filter or column that is on is never hidden.
  const shown = open || !!view.field || !!view.col;
  useEffect(() => {
    if (shown && pressed.current) first.current?.focus();
    pressed.current = false;
  }, [shown]);
  if (!data) return null;
  const defs: CustomDef[] = data.fields || [];
  const past: string[] = data.past_names || [];
  if (!defs.length && !past.length) return null;
  const def = defs.find((d) => customKey(d.name) === customKey(view.field));
  // Folding it away again also takes its filter and column off: nothing that narrows the list is ever out of sight.
  const toggle = () => {
    pressed.current = true;
    if (shown) {
      setOpen(false);
      setTyped('');
      if (view.field || view.value || view.col) onChange({ field: '', value: '', col: '' });
    } else setOpen(true);
  };
  return (
    <>
      <button type="button" className="btn sm ghost cf-more" data-more="screen" data-feature="ds-custom-fields" aria-expanded={shown} aria-controls="cf-filter" onClick={toggle}>{t(ui, 'customfields.filter.more')}</button>
      {shown && (
        <div id="cf-filter" className="cf-filter" role="group" aria-label={t(ui, 'customfields.filter.group')} data-feature="ds-custom-fields">
          <select ref={first} value={view.field} onChange={(e) => onChange({ field: e.target.value, value: '' })} aria-label={t(ui, 'customfields.filter.field')}>
            <option value="">{t(ui, 'customfields.filter.any_field')}</option>
            {defs.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            {past.length > 0 && <optgroup label={t(ui, 'customfields.filter.past')}>{past.map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>}
          </select>
          {view.field && (def?.kind === 'list' ? (
            <select value={view.value} onChange={(e) => onChange({ value: e.target.value })} aria-label={t(ui, 'customfields.filter.value', { name: view.field })}>
              <option value="">{t(ui, 'customfields.filter.any_value')}</option>
              {def.choices.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <input type="search" value={typed} maxLength={CUSTOM_VALUE_MAX} onChange={(e) => setTyped(e.target.value)} placeholder={t(ui, 'customfields.filter.value_placeholder')} aria-label={t(ui, 'customfields.filter.value', { name: view.field })} aria-describedby="cf-filter-hint" />
          ))}
          {view.field && def?.kind !== 'list' && <span id="cf-filter-hint" className="sn-vh">{t(ui, 'customfields.filter.exact')}</span>}
          <select value={view.col} onChange={(e) => onChange({ col: e.target.value })} aria-label={t(ui, 'customfields.filter.column')}>
            <option value="">{t(ui, 'customfields.filter.no_column')}</option>
            {[...defs.map((d) => d.name), ...past].map((n) => <option key={n} value={n}>{t(ui, 'customfields.filter.column_named', { name: n })}</option>)}
          </select>
        </div>
      )}
    </>
  );
}
