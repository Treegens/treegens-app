'use client';
import Link from 'next/link';
import { ROLE_LABEL, Leaf, fmtDate } from '../ui';
import { fmtNum, sheetsSaved, impactOf, fmtTrees } from '@/lib/impact';
import { formatDate } from '@/lib/dates';
import type { Outcome } from './changes';
import { plural, type Ed } from './shared';

const TONE: Record<string, string> = { finished: 'completed', copy_sent: 'completed', unchanged: '', updated: 'sent', new_link: 'expired', invited: 'sent', waiting: '', removed: 'voided' };

export type ReviewProps = {
  ed: Ed;
  problems: string[];
  busy: boolean;
  changed: boolean;
  /** A message from the server (or about the connection) after a save or send that did not go through. */
  error: string;
  /** People who finished while the sender was editing, when the sender also changed their part. */
  conflict: string[];
  /** Set when the envelope stopped being open while it was being edited. */
  closed: string;
  result: { people: Outcome[]; completes: boolean } | null;
  onSubmit: () => void;
  onRestore: () => void;
  onDiscard: () => void;
};

// Step 3: one last look. For a draft that means "send"; for an envelope that is already out it spells out what
// saving will do to each person before anything happens.
export function StepReview({ ed, problems, busy, changed, error, conflict, closed, result, onSubmit, onRestore, onDiscard }: ReviewProps) {
  const { env, isTpl, correcting, docs, rcps } = ed;
  const fields = ed.fields.value;
  const pages = docs.reduce((n, d) => n + d.pages, 0);
  const impact = impactOf(sheetsSaved(pages, rcps.length));
  const sorted = [...rcps].sort((a, b) => (env.ordered ? a.routing_order - b.routing_order : 0));
  const blocked = busy || problems.length > 0 || !!closed || conflict.length > 0 || (correcting && !changed);
  const label = isTpl ? 'Save template' : correcting ? (busy ? 'Saving…' : 'Save changes') : busy ? 'Sending…' : 'Send';

  return (
    <div className="main stack ed-narrow ed-review">
      {closed && (
        <div className="notice err" role="alert">
          <b>This envelope is {closed} now, so it can no longer be changed.</b> Nothing you did here was sent. <Link href={`/app/envelopes/${env.id}`}>Go to the envelope</Link> to see where it stands.
        </div>
      )}
      {conflict.length > 0 && (
        <div className="notice err" role="alert">
          <b>{conflict.join(' and ')} finished while you were editing.</b> The documents and what they signed are locked now, and some of your changes touch that part. Your other changes are still here.
          <div className="row wrap" style={{ marginTop: 10 }}><button type="button" className="btn sm" onClick={onRestore}>Put their part back and keep my other changes</button></div>
        </div>
      )}
      {error && !closed && <div className="notice err" role="alert"><b>{correcting ? 'Not saved yet.' : isTpl ? 'Not saved yet.' : 'Not sent yet.'}</b> {error} Your changes are still here.</div>}
      {problems.length > 0 && <div className="notice warn"><b>Almost there.</b><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}

      <div className="card">
        <h2>{env.subject || '(no subject)'}</h2>
        {env.message && <p className="muted" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{env.message}</p>}
        <div className="muted small" style={{ marginTop: 8 }}>
          {plural(docs.length, 'document')}, {plural(pages, 'page')} · {env.ordered ? 'signed in order' : 'everyone at once'} · {env.reminder_days ? `reminder every ${plural(env.reminder_days, 'day')}` : 'no automatic reminders'}
          {correcting ? (env.expires_at ? ` · closes on ${fmtDate(env.expires_at)}` : '') : ` · expires after ${plural(env.expire_days, 'day')}`} · dates written like {formatDate(new Date(), env.date_format)}
        </div>
      </div>

      {correcting && result ? (
        <div className="card">
          <h2>What happens when you save</h2>
          <p className="muted small" style={{ margin: '4px 0 12px' }}>{changed ? 'Nobody has to start again. Here is what each person will notice.' : 'You have not changed anything yet. Go back to make a change, or leave with Discard changes.'}</p>
          <ul className="ed-people">
            {result.people.map((p) => (
              <li key={p.id} className={p.kind === 'removed' ? 'gone' : ''}>
                <span className="dot" style={{ background: p.kind === 'removed' ? '#9aa39d' : ed.color(p.id) }} />
                <div className="grow">
                  <div className="row wrap" style={{ gap: 8, rowGap: 2 }}><b className="ed-break">{p.name}</b><span className={`badge ${TONE[p.kind]}`}>{p.badge}</span></div>
                  <div className="muted small ed-break">{p.email || 'No email yet'} · {ROLE_LABEL[p.role]}</div>
                  <div className="small" style={{ marginTop: 3 }}>{p.text}</div>
                </div>
              </li>
            ))}
          </ul>
          {result.completes && <div className="notice warn" style={{ marginTop: 12 }}>Everyone who is left has already finished, so saving completes this envelope and sends the signed copy to everyone.</div>}
        </div>
      ) : (
        <div className="card">
          <h2 style={{ marginBottom: 4 }}>{isTpl ? 'Roles' : 'Recipients'}</h2>
          <ul className="ed-people">
            {sorted.map((r) => {
              const n = fields.filter((f) => f.recipient_id === r.id).length;
              return (
                <li key={r.id}>
                  {!!env.ordered && <span className="badge num" aria-label={`Signing order ${r.routing_order}`}>{r.routing_order}</span>}
                  <span className="dot" style={{ background: ed.color(r.id) }} />
                  <div className="grow">
                    <b className="ed-break">{r.name || r.role_name || 'Unnamed'}</b>
                    <div className="muted small ed-break">{r.email || 'Filled in when the template is used'}</div>
                    <div className="small" style={{ marginTop: 3 }}>{ROLE_LABEL[r.role]}{r.access_code ? ' · access code' : ''}{n ? ` · ${plural(n, 'field')}` : ''}</div>
                  </div>
                </li>
              );
            })}
            {!sorted.length && <li className="muted small">Nobody yet.</li>}
          </ul>
        </div>
      )}

      {!isTpl && !correcting && pages > 0 && (
        <div className="card row" style={{ background: 'var(--green-soft)', borderColor: '#cfe3d2', alignItems: 'flex-start' }}>
          <Leaf size={26} color="#1f6f43" />
          <div>
            <b>Sending this digitally saves about {fmtNum(impact.sheets)} sheets of paper</b>
            <div className="small" style={{ marginTop: 2 }}>That is {fmtNum(impact.litresWater)} litres of water and {fmtNum(impact.kgCo2, 2)} kg of CO2e not used, or {fmtTrees(impact.trees)} of a tree. Printing, couriers and filing cabinets not included.</div>
          </div>
        </div>
      )}

      <div className="row wrap ed-actions">
        {correcting && <button type="button" className="btn ghost" onClick={onDiscard}>Discard changes</button>}
        <span className="grow" />
        <button type="button" className="btn" onClick={() => ed.go(2)}>Back</button>
        <button type="button" className="btn primary lg" disabled={blocked} onClick={onSubmit}>{label}</button>
      </div>
      {correcting && !changed && !closed && <p className="muted small" style={{ textAlign: 'right' }}>Save changes turns on once you change something.</p>}
    </div>
  );
}
