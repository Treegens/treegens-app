'use client';
import { StateCard } from '@/components/sign/parts';

// On the done screen of a person who signed on the screen facing them at a service counter (src/server/counter.ts):
// hand the screen back, and "Next person" clears this browser for whoever comes next. The page is replaced, so Back
// never brings this person's document up again.
export function CounterDone() {
  return (
    <StateCard tone="wait" title="Hand the screen back">
      <p>The official gives you your receipt. Before the next person, press the button: it clears this screen.</p>
      <div className="row wrap sg-actions"><button type="button" className="btn primary lg" onClick={() => window.location.replace('/counter/screen?next=1')}>Next person</button></div>
    </StateCard>
  );
}
