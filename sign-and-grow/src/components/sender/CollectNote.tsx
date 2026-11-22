'use client';
// The document page: for a document that asks for a payment by card, each person's state as Stripe reported it
// (src/server/routes-collect.ts). Nothing at all for a document that asks for none.
import { useEffect, useState } from 'react';
import { api } from '../ui';

type Person = { id: string; name: string; state: string | null; line: string | null; amount: string | null };
type State = { setting: { amount_text: string | null; field_label: string | null; for: string; when: string } | null; people?: Person[] };

export function CollectNote({ envelopeId }: { envelopeId: string }) {
  const [st, setSt] = useState<State | null>(null);
  useEffect(() => {
    let live = true;
    api<State>(`/envelopes/${envelopeId}/collect`).then((r) => live && setSt(r)).catch(() => {});
    return () => {
      live = false;
    };
  }, [envelopeId]);
  if (!st?.setting) return null;
  const s = st.setting;
  return (
    <section className="card" data-feature="ds-pay-collect" aria-labelledby="collect-note-h">
      <h2 id="collect-note-h" style={{ fontSize: 17 }}>Payment</h2>
      <p className="muted small" style={{ marginTop: 4 }}>Each person who signs, other than people on your own team, is asked to pay {s.amount_text || `the amount in "${s.field_label}"`} for {s.for}, {s.when === 'before' ? 'before their part is complete' : 'after they finish'}. Paid means Stripe confirmed it.</p>
      <ul className="rules" style={{ margin: 0 }}>
        {(st.people || []).map((p) => <li key={p.id}><b>{p.name}:</b> {p.line || 'Not asked yet.'}</li>)}
      </ul>
    </section>
  );
}
