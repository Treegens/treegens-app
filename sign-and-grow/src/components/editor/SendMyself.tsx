'use client';
import { BY_SENDER_TICK, BY_SENDER_HOW, bySenderProblem } from '@/lib/bysender';

// "I will send the link myself": a person with a name and no email address, whom the sender reaches on WhatsApp, by
// text message or in any chat. We email them nothing at all. What that means is said under the tick, before anyone
// relies on it, and the rule for what cannot work without an address is the server's own (src/lib/bysender.ts).
// Offered for one person who signs, approves or views on an envelope: not on a template, not for a group, not for
// someone who signs in person on the sender's device, and not for a copy, which only ever goes out by email.
export const canSendMyself = (r: any, isTpl: boolean) => !isTpl && !r.group_id && (r.role === 'signer' || r.role === 'approver' || r.role === 'viewer');

/** What stops Send for such a person, in the words the server would use, or null. */
export function sendMyselfTrouble(r: any, name: string, fields: any[]): string | null {
  if (!String(r.name || '').trim()) return `${name} needs a name. You send them the link yourself, so their name is how they are shown on the document and in the record.`;
  return bySenderProblem(r, { fields });
}

export function SendMyself({ r, isTpl, onChange }: { r: any; isTpl: boolean; onChange: (p: any) => void }) {
  if (!canSendMyself(r, isTpl) && !r.link_by_sender) return null;
  const hint = `ed-myself-${r.id}`;
  return (
    <div className="ed-myself">
      <label className="check">
        {/* The tick takes the address away, and unticking gives back the one that was typed (kept on screen only).
            Nothing else the sender chose is changed: what cannot go with it (a code by email, a texted link) is said
            in the list above Send, in the server's words, so nobody's choice vanishes unseen. */}
        <input type="checkbox" checked={!!r.link_by_sender} aria-describedby={r.link_by_sender ? hint : undefined}
          onChange={(e) => onChange(e.target.checked ? { link_by_sender: true, email: '', email_before_tick: r.email || '' } : { link_by_sender: false, email: r.email_before_tick || '' })} />
        <span>{BY_SENDER_TICK}<span className="muted"> (no email address needed)</span></span>
      </label>
      {!!r.link_by_sender && <p id={hint} className="muted small">{BY_SENDER_HOW}</p>}
    </div>
  );
}
