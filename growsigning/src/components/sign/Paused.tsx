'use client';
import { type ReactNode } from 'react';
import { Shell, StateCard, Sender } from './parts';

// A document its sender paused (src/server/timing.ts): one sentence, never "expired". Nothing here can sign, fill
// in, finish or decline; the server refuses those too. What was filled in so far is kept.
export function PausedLink({ data, footer, notice, dialogs }: { data: any; footer?: ReactNode; notice?: ReactNode; dialogs?: ReactNode }) {
  const env = data.envelope;
  return (
    <Shell data={data} footer={footer}>
      {notice}
      <StateCard tone="wait" title="This document is paused">
        <p>{env.paused.text}</p>
        <p className="muted">Anything you filled in is kept. There is nothing to do until then.</p>
        <Sender env={env} brand={data.brand} lead="Questions? Contact" />
      </StateCard>
      {dialogs}
    </Shell>
  );
}
