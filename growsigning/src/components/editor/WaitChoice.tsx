'use client';
import { useState } from 'react';
import { WAIT_CHOICES, waitWords } from '@/lib/timing';
import { isFirst } from './SendLater';
import { type Ed } from './shared';

// "Wait before this person", one line of a person's More (research/ux-charter.md 2.3 item 6). Listed only with a
// signing order on, and not for the first step, which has nothing before it to wait for. The wait starts when the
// step before this person finishes. It is a wait the sender chose, never called a cooling-off period.
export function WaitChoice({ ed, r }: { ed: Ed; r: any }) {
  const [open, setOpen] = useState(false);
  if (!ed.env?.ordered || r.role === 'witness' || isFirst(ed, r)) return null;
  const h = Number(r.wait_hours) || 0;
  const choices = WAIT_CHOICES.includes(h) || !h ? WAIT_CHOICES : [...WAIT_CHOICES, h].sort((a, b) => a - b);
  return (
    <div className="ed-line" data-feature="ds-timing">
      <button type="button" className="ed-line-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>Wait before this person: <b>{h ? waitWords(h) : 'No wait'}</b></span><span aria-hidden="true" className="ed-line-go">{open ? 'Close' : 'Change'}</span>
      </button>
      {open && (
        <div className="ed-pick">
          <label className="f" style={{ margin: 0 }}><span>Ask them this long after the person before them finishes</span>
            <select value={h} disabled={!!ed.wording} onChange={(e) => ed.patchRcp(r.id, { wait_hours: Number(e.target.value) })}>
              <option value={0}>No wait</option>
              {choices.map((c) => <option key={c} value={c}>{waitWords(c)}</option>)}
            </select>
          </label>
          <p className="muted small" style={{ margin: '6px 0 0' }}>The deadline keeps running while they wait.</p>
        </div>
      )}
    </div>
  );
}
