'use client';
// "Format and limits" in a field's More options (research/ux-notes.json, ds-fields-checks): the format a text field
// takes, a character limit, a box of fixed size, hiding what is typed from the others; the range, decimals and
// currency of a number field; the group and its rule for a tick box. The rules are shared with the signing page and
// the server (src/lib/fieldrules.ts). Nothing here shows on the main field panel, and signers never see a pattern.
import { useId, useState, type ReactNode } from 'react';
import { checksOf, checksSendProblem, checksSummary, groupRuleNote, groupRuleProblem, PATTERN_VALUE_MAX, patternProblem, fitChars, currencySign, isCurrency, dateExample, groupRuleWords, HIDE_SAYS, HIDE_COPY_SAYS, MAX_LENGTH, MAX_DECIMALS, GROUP_MAX, type Checks } from '@/lib/fieldrules';

type Props = {
  field: any;
  fields: any[];
  dateFormat?: string | null;
  pageSize?: { w: number; h: number } | null;
  patch: (p: any) => void;
  /** Sets `p` on every field in `ids` in one step (a tick-box group's rule belongs to every box of the group). */
  patchMany: (ids: string[], p: any) => void;
};

const numOrUndef = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));

/** The checks as the field will keep them: undefined values and an empty object drop away. */
function tidy(c: Checks): Checks | '' {
  const out = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== '' && v !== false)) as Checks;
  return Object.keys(out).length ? out : '';
}

/**
 * One line in the field's More options, "Format and limits: None", that opens in place. It starts open when something
 * in it still needs doing before the document can be sent.
 */
function Fold({ title, summary, needed, children }: { title: string; summary: string; needed: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(needed);
  return (
    <details data-fold className="ed-fold ed-checks-fold" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{title}: {summary}</summary>
      {children}
    </details>
  );
}

export function FieldChecks({ field, fields, dateFormat, pageSize, patch, patchMany }: Props) {
  const id = useId();
  const c = checksOf(field.validation);
  const set = (p: Partial<Checks>) => patch({ validation: tidy({ ...c, ...p }) });
  // What still stops the document from being sent, the same reason the review step lists (ChecksCheck.tsx).
  const unfinished = !!checksSendProblem(field, fields);
  const summary = checksSummary(field.type, c, dateFormat) + (unfinished ? ' (not finished)' : '');

  if (field.type === 'text') {
    const kind = c.kind || '';
    const why = kind === 'pattern' && c.pattern ? patternProblem(c.pattern) : '';
    const fits = pageSize ? fitChars(field.w * pageSize.w, field.h * pageSize.h) : null;
    return (
      <Fold title="Format and limits" summary={summary} needed={unfinished}>
      <fieldset className="ed-checks" style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
        <legend className="ed-sr">Format and limits</legend>
        <label className="f"><span>Format</span>
          <select value={kind} onChange={(e) => {
            const k = e.target.value as Checks['kind'] | '';
            // Changing the format drops the pattern and its message of the one before.
            set({ kind: k || undefined, pattern: k === 'pattern' ? c.pattern : undefined, message: k === 'pattern' ? c.message : undefined });
          }}>
            <option value="">None</option>
            <option value="email">Email address</option>
            <option value="number">Number</option>
            <option value="phone">Phone number</option>
            <option value="letters">Letters only</option>
            <option value="date">Date, like {dateExample(dateFormat)}</option>
            <option value="pattern">My own pattern</option>
          </select>
        </label>
        {kind === 'number' && <p className="muted small" style={{ marginTop: -6 }}>For a range or an amount, use a Number field instead.</p>}
        {kind === 'pattern' && (
          <>
            <label className="f"><span>Your pattern <span className="hint">(for example [0-9]{'{5}'} for 5 digits; the field then takes at most {PATTERN_VALUE_MAX} characters)</span></span>
              <input value={c.pattern || ''} maxLength={200} spellCheck={false} autoCapitalize="off" aria-invalid={!!why} aria-describedby={why ? `${id}-why` : undefined} onChange={(e) => set({ pattern: e.target.value || undefined })} />
            </label>
            {why && <p id={`${id}-why`} className="small" role="alert" style={{ color: 'var(--danger, #b42318)', marginTop: -6 }}>{why}</p>}
            <label className="f"><span>What people see when it does not match <span className="hint">(say how to put it right, like: Type 5 digits, like 12345)</span></span>
              <input value={c.message || ''} maxLength={200} aria-invalid={!c.message} onChange={(e) => set({ message: e.target.value || undefined })} />
            </label>
            {!c.message && <p className="muted small" style={{ marginTop: -6 }}>Needed before you can send. People see this message, not the pattern.</p>}
          </>
        )}
        <label className="f"><span>Character limit <span className="hint">(empty for none, up to {MAX_LENGTH.toLocaleString('en')})</span></span>
          <input type="number" inputMode="numeric" min={1} max={MAX_LENGTH} value={c.max_length ?? ''} onChange={(e) => set({ max_length: numOrUndef(e.target.value) })} />
        </label>
        <label className="check ed-tap"><input type="checkbox" checked={!!c.fixed} onChange={(e) => set({ fixed: e.target.checked || undefined })} aria-describedby={`${id}-fixed`} /> Fixed size</label>
        <p id={`${id}-fixed`} className="muted small" style={{ marginTop: 0 }}>Text shrinks to fit, then no more can be typed{fits ? ` (about ${fits} characters)` : ''}.</p>
        <label className="check ed-tap"><input type="checkbox" checked={!!c.hide} onChange={(e) => set({ hide: e.target.checked || undefined, hide_in_copy: e.target.checked ? c.hide_in_copy : undefined })} aria-describedby={`${id}-hide`} /> Hide what they type</label>
        <p id={`${id}-hide`} className="muted small" style={{ marginTop: 0 }}>{HIDE_SAYS}</p>
        {c.hide && (
          <>
            <label className="check ed-tap"><input type="checkbox" checked={!!c.hide_in_copy} onChange={(e) => set({ hide_in_copy: e.target.checked || undefined })} aria-describedby={`${id}-copy`} /> Also hide it in the completed copy</label>
            <p id={`${id}-copy`} className="muted small" style={{ marginTop: 0 }}>{HIDE_COPY_SAYS}</p>
          </>
        )}
      </fieldset>
      </Fold>
    );
  }

  if (field.type === 'number' && field.formula == null) {
    const code = (c.currency || '').toUpperCase();
    const sign = code.length === 3 ? currencySign(code) : '';
    const badCode = code.length > 0 && !isCurrency(code);
    const badRange = c.min != null && c.max != null && c.min > c.max;
    return (
      <Fold title="Format and limits" summary={summary} needed={unfinished}>
      <fieldset className="ed-checks" style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
        <legend className="ed-sr">Format and limits</legend>
        <label className="f"><span>Currency <span className="hint">(three letters, like EUR or USD; empty for none)</span></span>
          <input value={c.currency || ''} maxLength={3} autoCapitalize="characters" spellCheck={false} aria-invalid={badCode} aria-describedby={`${id}-cur`} onChange={(e) => set({ currency: e.target.value.toUpperCase() || undefined })} />
        </label>
        <p id={`${id}-cur`} className="muted small" style={{ marginTop: -6 }} role={badCode ? 'alert' : undefined}>
          {badCode ? `${code} is not a currency code we know. Use the three letters of the currency, like EUR, USD or KES.` : sign ? `Shown with ${sign}. What they type is kept as typed and as a number.` : 'What they type is printed as they type it.'}
        </p>
        <div className="grid ed-size">
          <label className="f"><span>Smallest</span><input type="number" inputMode="decimal" value={c.min ?? ''} aria-invalid={badRange} onChange={(e) => set({ min: numOrUndef(e.target.value) })} /></label>
          <label className="f"><span>Largest</span><input type="number" inputMode="decimal" value={c.max ?? ''} aria-invalid={badRange} onChange={(e) => set({ max: numOrUndef(e.target.value) })} /></label>
        </div>
        {badRange && <p className="small" role="alert" style={{ color: 'var(--danger, #b42318)', marginTop: -6 }}>The smallest number is larger than the largest. Swap them.</p>}
        <label className="f"><span>Decimal places <span className="hint">(at most; empty for any)</span></span>
          <input type="number" inputMode="numeric" min={0} max={MAX_DECIMALS} value={c.decimals ?? ''} onChange={(e) => set({ decimals: numOrUndef(e.target.value) })} />
        </label>
      </fieldset>
      </Fold>
    );
  }

  if (field.type === 'checkbox') {
    const name = field.group_name || '';
    const group = name ? fields.filter((f) => f.type === 'checkbox' && f.group_name === name) : [field];
    const ids = group.map((f) => f.id);
    const rule = c.group_rule || '';
    const setRule = (p: Partial<Checks>) => {
      const next = tidy({ ...c, ...p });
      patchMany(ids, { validation: next });
    };
    const stuck = name ? groupRuleProblem(group) : '';
    const note = rule ? groupRuleNote(rule, c.group_count, group.length) : '';
    return (
      <Fold title="Group of tick boxes" summary={name ? `${name}${rule && c.group_count != null ? `, ${summary[0].toLowerCase()}${summary.slice(1)}` : unfinished || stuck ? ' (not finished)' : ''}` : 'None'} needed={unfinished || !!stuck}>
      <fieldset className="ed-checks" style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
        <legend className="ed-sr">Group of tick boxes</legend>
        <label className="f"><span>Group <span className="hint">(the same name on several tick boxes makes them one group)</span></span>
          <input value={name} maxLength={80} onChange={(e) => patch({ group_name: e.target.value })} />
        </label>
        {name && (
          <>
            <label className="f"><span>Rule for {group.length === 1 ? 'this box' : `these ${group.length} boxes`}</span>
              <select value={rule} onChange={(e) => setRule({ group_rule: (e.target.value || undefined) as Checks['group_rule'], group_count: e.target.value ? c.group_count ?? 1 : undefined, message: e.target.value ? c.message : undefined })}>
                <option value="">No rule</option>
                <option value="at_least">Tick at least</option>
                <option value="at_most">Tick at most</option>
                <option value="exactly">Tick exactly</option>
              </select>
            </label>
            {rule && (
              <>
                <label className="f"><span>How many</span>
                  <input type="number" inputMode="numeric" min={0} max={Math.min(GROUP_MAX, group.length)} value={c.group_count ?? ''} onChange={(e) => setRule({ group_count: numOrUndef(e.target.value) })} />
                </label>
                {stuck && <p className="small" role="alert" style={{ color: 'var(--danger, #b42318)', marginTop: -6 }}>{stuck}</p>}
                {note && !stuck && <p className="muted small" style={{ marginTop: -6 }}>{note}</p>}
                <label className="f"><span>What people see when it is not met <span className="hint">(optional)</span></span>
                  <input value={c.message || ''} maxLength={200} placeholder={groupRuleWords((rule || 'at_least') as any, c.group_count ?? 2)} onChange={(e) => setRule({ message: e.target.value || undefined })} />
                </label>
              </>
            )}
          </>
        )}
      </fieldset>
      </Fold>
    );
  }
  return null;
}
