'use client';
// Who invited whom, on /app/operator (GET /api/operator/referrals, src/server/referrals.ts). A closed fold with the
// count in its name; nothing is drawn where the offer is off or nobody has been invited yet.
import { api, useLoad, fmtDate } from '@/components/ui';

type Side = { account_id: string; account: string | null; email: string | null; signatures: number };
type Line = { id: string; at: string; status: 'pending' | 'rewarded' | 'refused' | 'taken_back'; reason: string; inviter: Side; friend: Side; taken_back: number };
const STATUS: Record<Line['status'], string> = { pending: 'Waiting', rewarded: 'Rewarded', refused: 'Refused', taken_back: 'Taken back' };

export function ReferralRecord() {
  const [d] = useLoad<{ on: boolean; referrals: Line[] } | null>(() => api('/operator/referrals').catch(() => null));
  if (!d || !d.referrals.length) return null;
  return (
    <details className="card" data-fold="">
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Invited friends ({d.referrals.length})</summary>
      <p className="muted small" style={{ margin: '8px 0' }}>Who invited whom, newest first. A reward is given once the friend has a confirmed address, a phone number and a first signed document.{d.on ? '' : ' The offer is switched off on this server now.'}</p>
      <div style={{ overflowX: 'auto' }}>
        <table className="table small">
          <thead><tr><th>Signed up</th><th>Invited by</th><th>Friend</th><th>Stands</th><th>Why</th></tr></thead>
          <tbody>
            {d.referrals.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.at)}</td>
                <td>{r.inviter.email || r.inviter.account || r.inviter.account_id}{r.inviter.signatures ? ` (+${r.inviter.signatures})` : ''}</td>
                <td>{r.friend.email || r.friend.account || 'deleted since'}{r.friend.signatures ? ` (+${r.friend.signatures})` : ''}</td>
                <td>{STATUS[r.status]}{r.status === 'taken_back' ? `: ${r.taken_back} signatures` : ''}</td>
                <td>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
