'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { api, useLoad } from '@/components/ui';
import { useST } from '@/components/senderLang';

// Invite a friend (src/server/referrals.ts, src/lib/referral.ts). Three pieces:
//   InviteChoices  where someone has run out of signatures (Home at none left, step 3 of the editor, the Plan page):
//                  two choices side by side, "Get more signatures" as before and "Invite a friend, get 3 free
//                  signatures each". With some left, Home has one quiet link to the card instead (UsageMeter.tsx).
//   InviteLink     the link, Copy, and share buttons that only open the person's own apps: their email program
//                  with a short message already written, and the phone's share sheet where the browser has one.
//                  Nothing is uploaded and we send nothing: the person passes the link on themselves.
//   InviteCard     the small "Invite friends" place on the Plan page: the link, two counts, the rules in three short
//                  lines, and a link to all of them on the help page.
// Where signatures are not counted (no payment provider, or a server under a yearly agreement) the server answers
// { on: false } and none of this draws.

export type Invite = {
  on: boolean; url?: string; open?: boolean; joined?: number; signatures?: number;
  rules: { signatures: number; expiry_days: number; monthly_max: number; total_max: number };
};
/** The invite link and its numbers, or null while loading and where the offer is off. */
export function useInvite(): Invite | null {
  const [inv] = useLoad<Invite | null>(() => api('/referrals').catch(() => null));
  return inv && inv.on ? inv : null;
}

export function InviteLink({ inv }: { inv: Invite }) {
  const T = useST();
  const [copied, setCopied] = useState<'' | 'done' | 'failed'>('');
  // The phone's own share sheet, where the browser has one. Asked after the page is in the browser.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function'), []);
  const url = inv.url || '';
  const text = T('invite.share_text', { count: inv.rules.signatures });
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw 0;
      await navigator.clipboard.writeText(url);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };
  // Closing the share sheet without choosing anything is not an error.
  const share = () => navigator.share({ title: T('invite.share_subject'), text, url }).catch(() => {});
  return (
    <div className="inv-link">
      {/* The link and Copy on one row, so the thing to tap is on the first screen of a phone. */}
      <div className="inv-row" aria-live="polite">
        <input readOnly value={url} aria-label={T('invite.link_label')} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn sm primary" onClick={copy}>{copied === 'done' ? T('invite.copied') : T('invite.copy_button')}</button>
      </div>
      <div className="inv-actions">
        <a className="btn sm" href={`mailto:?subject=${encodeURIComponent(T('invite.share_subject'))}&body=${encodeURIComponent(`${text} ${url}`)}`}>{T('invite.email_button')}</a>
        {canShare && <button type="button" className="btn sm" onClick={share}>{T('invite.share_button')}</button>}
      </div>
      {copied === 'failed' && <p className="muted small" role="status">{T('invite.copy_failed')}</p>}
    </div>
  );
}

/**
 * The out-of-signatures moment. `more` is what the screen offered before (its own button to the plan or a top-up),
 * `note` a line under its heading. With the offer off, or the link at its limit, only `more` draws, as before.
 * `slow`: said where someone is stopped in the middle of a send, so nobody expects the invite to unblock it today.
 */
export function InviteChoices({ more, note, inv, slow }: { more: ReactNode; note?: ReactNode; inv: Invite | null; slow?: boolean }) {
  const T = useST();
  if (!inv || !inv.open) return <div className="row wrap inv-only">{more}</div>;
  return (
    <div className="inv-choices" role="group" aria-label={T('invite.choices_label')}>
      <section className="inv-choice">
        <h3>{T('invite.more_title')}</h3>
        {note && <p>{note}</p>}
        <div className="inv-actions">{more}</div>
      </section>
      <section className="inv-choice">
        <h3>{T('invite.title', { count: inv.rules.signatures })}</h3>
        <p>{T('invite.lead')}{slow ? ` ${T('invite.slow')}` : ''}</p>
        <InviteLink inv={inv} />
      </section>
    </div>
  );
}

/** The Plan page's "Invite friends". `bare`: the link is already on screen above (the out-of-signatures choices). */
export function InviteCard({ inv, bare }: { inv: Invite | null; bare?: boolean }) {
  const T = useST();
  if (!inv) return null;
  const r = inv.rules;
  return (
    <section className="card inv-card" id="invite" aria-labelledby="inv-card-h">
      <h2 id="inv-card-h">{T('invite.card_title')}</h2>
      {!inv.open && <div className="notice" style={{ margin: '8px 0 12px' }}>{T('invite.closed')}</div>}
      {!bare && <InviteLink inv={inv} />}
      <dl className="inv-counts">
        <div><dt>{T('invite.joined')}</dt><dd className="num">{inv.joined || 0}</dd></div>
        <div><dt>{T('invite.signatures')}</dt><dd className="num">{inv.signatures || 0}</dd></div>
      </dl>
      <ul className="rules inv-rules">
        <li>{T('invite.rule_how', { count: r.signatures })}</li>
        <li>{T('invite.rule_limits', { days: r.expiry_days, monthly: r.monthly_max, total: r.total_max })}</li>
        <li>{T('invite.rule_fair')} <a href="/help#invite">{T('invite.all_rules')}</a></li>
      </ul>
    </section>
  );
}
