'use client';
// The "Use" dialog of a template: the details the account requires that this template has no value for, such as a
// case number (src/server/customfields.ts), asked for right there, so "Send now" works with one typed value. With
// nothing required, or everything filled in by the template, nothing is shown.
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/components/ui';
import { SOURCE_LOCALE, t } from '@/lib/i18n';
import { customKey, type CustomDef } from '@/lib/customfields';
import { DetailBoxes, pairsFrom, missingIn, firstProblem, type Typed } from './DetailBoxes';

const ui = SOURCE_LOCALE;

export function useTemplateDetails(templateId: string | undefined, locked: boolean): {
  /** The boxes, or null when the template needs none. */
  boxes: ReactNode;
  /** What stops a send, in words, or null. Marks the empty boxes. */
  problem: () => string | null;
  /** What goes into the new document ("custom_fields"), or undefined when nothing was typed. */
  pairs: () => { name: string; value: string }[] | undefined;
} {
  const [needed, setNeeded] = useState<CustomDef[]>([]);
  const [typed, setTyped] = useState<Typed>({});
  const [flagged, setFlagged] = useState<string[]>([]);
  useEffect(() => {
    setNeeded([]);
    setTyped({});
    setFlagged([]);
    if (!templateId) return;
    let on = true;
    // When this cannot be asked, the send itself still says what is missing and opens the draft on that box.
    api(`/custom-fields?template=${encodeURIComponent(templateId)}`).then((r) => on && setNeeded(r.needed || [])).catch(() => {});
    return () => {
      on = false;
    };
  }, [templateId]);
  const problem = () => {
    const wrong = firstProblem(needed, typed);
    if (wrong) return wrong;
    const missing = missingIn(needed, typed);
    if (!missing.length) return null;
    setFlagged(missing);
    return t(ui, 'customfields.use.missing', { names: missing.join(', '), count: missing.length });
  };
  const pairs = () => {
    const list = pairsFrom(needed, typed);
    return list.length ? list : undefined;
  };
  const boxes = needed.length ? (
    <fieldset className="sn-rolefill cf-step cf-use" data-feature="ds-custom-fields">
      <legend>{t(ui, 'customfields.use.group')}</legend>
      <DetailBoxes defs={needed} typed={typed} flagged={flagged} locked={locked} idPrefix="cf-use" onChange={(d, v) => setTyped({ ...typed, [customKey(d.name)]: v })} />
    </fieldset>
  ) : null;
  return { boxes, problem, pairs };
}

/** After a refused "Send now": where to go and what to say, when it was refused for a required detail. */
export function draftNeedsDetails(e: any, draftId: string): { href: string; words: string } | null {
  if (e?.code !== 'details_missing' || !draftId) return null;
  const names: string[] = Array.isArray(e.data?.missing) ? e.data.missing.map(String) : [];
  return { href: `/app/envelopes/${draftId}/edit#details`, words: t(ui, 'customfields.use.refused', { names: names.join(', ') }) };
}
