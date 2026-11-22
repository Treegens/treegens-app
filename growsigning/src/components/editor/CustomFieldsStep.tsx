'use client';
// The last step of the editor: the account's own details (src/server/customfields.ts), such as a case number. On a
// draft or a template the values go with every save, like the subject ("custom_fields" in the editor's body). A
// document that is out has them changed on its own page (src/components/sender/CustomDetails.tsx), so the editor
// has one Save and this card is not shown there. They are never on the signing page; the ones marked for the
// certificate are printed on it. With no details in the account, nothing is shown.
import { useEffect, useRef, useState } from 'react';
import { api, useLoad } from '../ui';
import { SOURCE_LOCALE, t } from '@/lib/i18n';
import { customKey, type CustomDef } from '@/lib/customfields';
import { DetailBoxes, pairsFrom, typedFrom, useRefused, wantsDetails, focusDetails, type Pair, type Typed } from '../sender/DetailBoxes';
import type { Ed } from './shared';

const ui = SOURCE_LOCALE;

export function CustomFieldsStep({ ed }: { ed: Ed }) {
  const { env, isTpl, correcting } = ed;
  const [data] = useLoad<any>(() => api('/custom-fields'), []);
  const stored: Pair[] = env.custom_fields || [];
  // What is typed, by detail, so a value that cannot be saved yet stays on screen with what is wrong with it.
  const [typed, setTyped] = useState<Typed>({});
  // The names a refused send asked for: their boxes say so, and the first takes the cursor.
  const [flagged, setFlagged] = useState<string[]>([]);
  const card = useRef<HTMLElement>(null);
  useEffect(() => setTyped(typedFrom(stored)), [env.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useRefused((names) => {
    setFlagged(names);
    // After the boxes have marked themselves.
    setTimeout(() => focusDetails(card.current), 50);
  });
  const ready = !!data && !correcting;
  // Opened from "Change them in the editor" on the document's page: the card is brought into view.
  useEffect(() => {
    if (ready && wantsDetails()) setTimeout(() => focusDetails(card.current), 50);
  }, [ready]);
  if (!data || correcting) return null;
  const defs: CustomDef[] = data.fields || [];
  if (!defs.length) return null;
  const change = (d: CustomDef, value: string) => {
    const next = { ...typed, [customKey(d.name)]: value };
    setTyped(next);
    ed.patchEnv({ custom_fields: pairsFrom(defs, next, stored) });
  };
  return (
    <section className="card cf-step" aria-labelledby="cf-step-h" ref={card} data-feature="ds-custom-fields">
      <h2 id="cf-step-h" style={{ marginBottom: 4 }}>{t(ui, 'customfields.step.title')}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>{t(ui, isTpl ? 'customfields.step.intro_template' : 'customfields.step.intro')}</p>
      <DetailBoxes defs={defs} typed={typed} onChange={change} flagged={flagged} template={isTpl} />
    </section>
  );
}
