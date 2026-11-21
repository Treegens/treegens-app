'use client';
// The last step of the editor: the account's custom fields (src/server/customfields.ts), such as a case number. On a
// draft or a template the values go with every save, like the subject ("custom_fields" in the editor's body). On an
// envelope that is out they are saved on their own, with a line in its audit trail. They are never on the signing
// page; the ones marked for the certificate are printed on it. With no fields in the account, nothing is shown.
import { useEffect, useMemo, useState } from 'react';
import { api, useLoad, toast } from '../ui';
import { SOURCE_LOCALE, t } from '@/lib/i18n';
import { CUSTOM_VALUE_MAX, customKey, readValue, type CustomDef } from '@/lib/customfields';
import type { Ed } from './shared';

const ui = SOURCE_LOCALE;
type Pair = { name: string; value: string; on_certificate?: boolean };

export function CustomFieldsStep({ ed }: { ed: Ed }) {
  const { env, isTpl, correcting } = ed;
  const [data] = useLoad<any>(() => api('/custom-fields'), []);
  // On an envelope that is out, what was saved last from here (the editor itself never saves them there).
  const [savedSent, setSavedSent] = useState<Pair[] | null>(null);
  const stored: Pair[] = useMemo(() => savedSent || env.custom_fields || [], [savedSent, env.custom_fields]);
  // What is typed, by field, so a value that cannot be saved yet stays on screen with what is wrong with it.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => setTyped(Object.fromEntries(stored.map((p) => [customKey(p.name), p.value]))), [env.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return null;
  const defs: CustomDef[] = data.fields || [];
  // Values of fields that were deleted or renamed since this envelope was sent: kept as they are, and shown.
  const others = stored.filter((p) => !defs.some((d) => customKey(d.name) === customKey(p.name)));
  if (!defs.length && !others.length) return null;
  const valueOf = (d: CustomDef) => typed[customKey(d.name)] ?? '';
  const problemOf = (d: CustomDef) => {
    const v = readValue(d, valueOf(d));
    return 'problem' in v ? v.problem : null;
  };
  // The list as it should be saved: every field with a value that fits, and the kept ones as they are.
  const list = (next: Record<string, string>): Pair[] => [
    ...defs.flatMap((d) => {
      const v = readValue(d, next[customKey(d.name)] ?? '');
      if ('problem' in v) {
        // Not saved while it does not fit: what was saved before stays, and the problem is shown under the box.
        const before = stored.find((p) => customKey(p.name) === customKey(d.name));
        return before ? [{ name: before.name, value: before.value }] : [];
      }
      return v.value ? [{ name: d.name, value: v.value }] : [];
    }),
    ...others.map((p) => ({ name: p.name, value: p.value })),
  ];
  const change = (d: CustomDef, value: string) => {
    const next = { ...typed, [customKey(d.name)]: value };
    setTyped(next);
    if (!correcting) ed.patchEnv({ custom_fields: list(next) });
  };
  const missing = isTpl ? [] : defs.filter((d) => {
    const v = readValue(d, valueOf(d));
    return d.required && (!('value' in v) || !v.value);
  });
  const changed = correcting && JSON.stringify(list(typed)) !== JSON.stringify(stored.map((p) => ({ name: p.name, value: p.value })));
  async function saveSent() {
    setBusy(true);
    try {
      const r = await api(`/envelopes/${env.id}/custom-fields`, { method: 'PUT', body: { custom_fields: list(typed) } });
      setSavedSent(r.custom_fields);
      toast(t(ui, 'customfields.step.saved_sent'));
    } catch (e: any) {
      toast(e?.status ? e.message : t(ui, 'customfields.offline'), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card cf-step" aria-labelledby="cf-step-h">
      <h2 id="cf-step-h" style={{ marginBottom: 4 }}>{t(ui, 'customfields.step.title')}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>{t(ui, isTpl ? 'customfields.step.intro_template' : correcting ? 'customfields.step.intro_sent' : 'customfields.step.intro')}</p>
      <div className="cf-grid">
        {defs.map((d) => {
          const hint = `cf-hint-${d.id}`;
          const problem = problemOf(d);
          const now = valueOf(d);
          // A value from before a choice was taken out is still listed, so the sender sees what to change.
          const gone = d.kind === 'list' && now && !d.choices.some((c) => customKey(c) === customKey(now));
          return (
            <label key={d.id} className="f">
              <span>{d.name}{d.required && <span className="cf-req"> {t(ui, isTpl ? 'customfields.step.needed_to_send' : 'customfields.step.required')}</span>}</span>
              {d.kind === 'list' ? (
                <select value={now} onChange={(e) => change(d, e.target.value)} aria-describedby={hint} aria-invalid={!!problem}>
                  <option value="">{t(ui, 'customfields.step.choose')}</option>
                  {gone && <option value={now}>{t(ui, 'customfields.step.not_a_choice', { value: now })}</option>}
                  {d.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input value={now} maxLength={CUSTOM_VALUE_MAX} autoComplete="off" onChange={(e) => change(d, e.target.value)} aria-describedby={hint} aria-invalid={!!problem} />
              )}
              <span id={hint} className="hint">{problem || t(ui, d.on_certificate ? 'customfields.step.printed' : 'customfields.step.not_printed')}</span>
            </label>
          );
        })}
      </div>
      {others.length > 0 && (
        <div className="cf-sent">
          <p className="muted small" style={{ margin: '6px 0 2px' }}>{t(ui, 'customfields.step.kept')}</p>
          {others.map((p) => <div key={p.name} className="cf-value small"><b>{p.name}:</b> {p.value}</div>)}
        </div>
      )}
      {missing.length > 0 && <p className="notice warn" role="status">{t(ui, 'customfields.step.missing', { names: missing.map((d) => d.name).join(', '), count: missing.length })}</p>}
      {correcting && (
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button type="button" className="btn" style={{ minHeight: 44 }} disabled={busy || !changed || defs.some((d) => problemOf(d))} onClick={() => void saveSent()}>{busy ? t(ui, 'customfields.saving') : t(ui, 'customfields.step.save_sent')}</button>
          {!changed && <span className="muted small">{t(ui, 'customfields.step.save_sent_hint')}</span>}
        </div>
      )}
    </section>
  );
}
