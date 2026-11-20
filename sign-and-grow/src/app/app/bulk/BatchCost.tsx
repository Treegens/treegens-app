'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, useLoad, oops, fmtDate } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { PRICING, mangrovesFor } from '@/lib/impact';
import { plural } from '@/components/sender/lib';
import type { BulkRow } from '@/components/sender/csv';

// What a batch will hold, said above the Send button and not in a refusal after it. The numbers are not worked out
// here: the page asks the server (POST /api/bulk/check), which counts with the same function the send itself is held
// to a moment later. The review step of the editor says the same for one envelope (SignatureCost in
// src/components/editor/StepReview.tsx).

export type BatchCheck = {
  counted: boolean; rows: number; signers_per_row: number; need: number; have: number; short: number; plan: string;
  cost: { usd: number; plan_usd: number; plan_signatures: number; top_up: number; top_up_usd: number } | null;
  refusal: { status: number; message: string } | null;
};

/**
 * Asks the server about the list as it stands, a moment after the last change to it. `check` is null until the first
 * answer for this list has arrived, and `failed` says the server could not be asked: the page then says so and
 * leaves the Send button alone, because the send itself is checked again by the server.
 */
export function useBatchCheck(templateId: string, rows: BulkRow[], again = 0): { check: BatchCheck | null; failed: boolean } {
  const [state, setState] = useState<{ sig: string; check: BatchCheck | null; failed: boolean }>({ sig: '', check: null, failed: false });
  const sig = templateId && rows.length ? JSON.stringify([templateId, rows.map((r) => r.cells), again]) : '';
  const latest = useRef(sig);
  latest.current = sig;
  useEffect(() => {
    if (!sig) return;
    const timer = setTimeout(() => {
      api<BatchCheck>('/bulk/check', { body: { template_id: templateId, rows: rows.map((r) => r.cells) } })
        .then((check) => latest.current === sig && setState({ sig, check, failed: false }))
        .catch(() => latest.current === sig && setState({ sig, check: null, failed: true }));
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return state.sig === sig && sig ? { check: state.check, failed: state.failed } : { check: null, failed: false };
}

const usd = (n: number) => `$${n}`;

/** One sentence for the confirm dialog, so the count is said once more at the moment of sending. */
export function batchLine(c: BatchCheck | null): string {
  if (!c?.counted) return '';
  if (c.need === 0) return 'This batch uses none of your signatures.';
  return `This batch holds ${plural(c.need, 'signature')} of the ${c.have} you have ready, one for each person who signs. A signature is only used when that person actually signs.`;
}

export function BatchCost({ check, failed, onPaying }: { check: BatchCheck | null; failed: boolean; onPaying?: () => void }) {
  const me = useMe();
  const [b] = useLoad(() => api('/billing'));
  if (failed) return <p className="muted small" role="status" id="sn-batch-cost">We could not count what this list holds just now. The count is checked again when you send, and nothing goes out unless all of it can.</p>;
  if (!check) return <p className="muted small" role="status" id="sn-batch-cost">Counting what this list holds…</p>;
  const c = check;
  const admin = me.role !== 'member';
  const pay = (path: string, body?: any) => {
    onPaying?.();
    return api(path, { method: 'POST', body }).then((r) => { window.location.href = r.url; }).catch(oops);
  };
  const refused = c.refusal && (
    <div className="notice err" role="alert">
      <b>This batch would not go out as it stands.</b> {c.refusal.message}
    </div>
  );
  if (!c.counted) return refused ? <div id="sn-batch-cost">{refused}</div> : null; // payments are not connected, so nothing is counted
  const perRow = c.signers_per_row > 1 ? ` (${c.signers_per_row} people sign each of the ${plural(c.rows, 'row')})` : '';
  if (c.need === 0)
    return <div id="sn-batch-cost">{refused}<div className="notice">This batch uses none of your signatures. Approving, viewing and copies are always free, and so is your own signature on your own document.</div></div>;
  if (c.short === 0)
    return (
      <div id="sn-batch-cost">
        {refused}
        <div className="notice">
          <b>This batch holds {plural(c.need, 'signature')}</b> of the {c.have} you have ready, one for each person who signs{perRow}. That leaves you {c.have - c.need}.
          {' '}A signature is only used when that person actually signs. If you void the batch, or someone declines or runs out of time, theirs comes straight back.
        </div>
      </div>
    );
  // Not enough: say it before the Send button does, with the price and every way forward.
  const cost = c.cost!;
  const next = b?.free_next_at || b?.renews_at;
  const fits = c.signers_per_row > 0 ? Math.floor(c.have / c.signers_per_row) : 0;
  const tooBig = cost.top_up > PRICING.topUpMax;
  return (
    <div id="sn-batch-cost">
      {refused}
      <div className="notice warn" role="status">
        <b>This batch holds {plural(c.need, 'signature')} and you have {c.have} ready, so {c.short} {c.short === 1 ? 'is' : 'are'} missing.</b>
        {' '}One is held for each person who signs{perRow}. A batch only goes out when all of it can, so nothing would be sent yet. Nothing is charged unless you choose it. You can:
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {c.plan === 'grove'
            ? <li><b>Top up {plural(c.short, 'signature')} for {usd(cost.top_up_usd)}.</b> One payment, nothing recurring, and it plants {mangrovesFor(cost.top_up_usd)} mangrove trees.{tooBig ? ` One top-up holds up to ${PRICING.topUpMax}, so this takes more than one payment on the Plan page.` : ''}{!admin && ' An owner or admin of your team can do this on the Plan page.'}</li>
            : <li><b>Start the monthly plan for {usd(cost.plan_usd)} a month,</b> which brings {plural(cost.plan_signatures, 'signature')} with every payment and can be cancelled in one click.{cost.top_up > 0 ? <> Then <b>top up the other {cost.top_up} for {usd(cost.top_up_usd)}</b>. That is <b>{usd(cost.usd)} in all</b> before this batch can go out.</> : ' That covers this batch.'}{!admin && ' An owner or admin of your team can do this on the Plan page.'}</li>}
          {fits > 0 && <li><b>Send a shorter list now.</b> The first {plural(fits, 'row')} could go out with what you have.</li>}
          {next && c.plan === 'grove' && <li><b>Wait.</b> The next {plural(PRICING.monthlySignatures, 'signature')} arrive on {fmtDate(next)}.</li>}
        </ul>
        <p className="small" style={{ margin: '8px 0 0' }}>What nobody signs is not lost: it comes back to your balance when you void the batch or it runs out of time, and signatures you have not used are refunded on request within the refund window. Paying opens the payment page in this tab. Your list is kept in this browser tab, so it is still here when you come back to Bulk send.</p>
        <div className="row wrap" style={{ marginTop: 10 }}>
          {admin && b?.enabled && c.plan === 'grove' && !tooBig && <button type="button" className="btn sm primary" onClick={() => pay('/billing/topup', { quantity: c.short })}>Pay {usd(cost.top_up_usd)} and add {plural(c.short, 'signature')}</button>}
          {admin && b?.enabled && c.plan !== 'grove' && <button type="button" className="btn sm primary" onClick={() => pay('/billing/checkout')}>Start the plan for {usd(cost.plan_usd)} a month</button>}
          <Link href="/app/settings?tab=billing" className="btn sm" onClick={() => onPaying?.()}>Open the Plan page</Link>
        </div>
      </div>
    </div>
  );
}
