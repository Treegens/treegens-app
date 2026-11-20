'use client';
import { REMINDER_CHOICES, reminderChoice, reminderText } from '@/lib/policy';

// The reminder setting, shown where the Send button is. A new account has reminders on without anyone having chosen
// that (DEFAULT_REMINDER_DAYS in src/lib/policy.ts), so the sender sees it before every send, in a full sentence,
// and can change it or switch it off without going back to step 1. The same sentence stands on the envelope page
// and under Settings.
export function ReminderChoice({ days, onChange, isTpl }: { days: number; onChange: (days: number) => void; isTpl?: boolean }) {
  const n = Math.max(0, Math.round(Number(days)) || 0);
  // A number that is not one of the choices (set through the API, or in step 1) is offered as it is, not rounded.
  const choices = REMINDER_CHOICES.includes(n) ? REMINDER_CHOICES : [...REMINDER_CHOICES, n].sort((a, b) => a - b);
  return (
    <div className="card ed-reminders">
      <label className="f" style={{ marginBottom: 6 }}>
        <span>Remind people who have not finished</span>
        <select value={n} aria-describedby="ed-reminder-says" onChange={(e) => onChange(Number(e.target.value))}>
          {choices.map((c) => <option key={c} value={c}>{reminderChoice(c)}</option>)}
        </select>
      </label>
      <div id="ed-reminder-says" className="muted small" aria-live="polite">
        {reminderText(n)}{isTpl ? ' Every envelope made from this template starts with this setting.' : ''}
      </div>
    </div>
  );
}
