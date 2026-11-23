'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, useLoad, oops, fmtDate } from '@/components/ui';
import { useMe } from '@/components/AppShell';
import { PRICING, treesFor } from '@/lib/impact';
import { useST } from '@/components/senderLang';
import { senderT } from '@/lib/senderlang';
import type { BulkRow } from '@/components/sender/csv';
import type { BouncedAddress } from '@/lib/mailnews';

// What a batch will hold, said above the Send button and not in a refusal after it. The numbers are not worked out
// here: the page asks the server (POST /api/bulk/check), which counts with the same function the send itself is held
// to a moment later. The review step of the editor says the same for one envelope (SignatureCost in
// src/components/editor/StepReview.tsx).

export type BatchCheck = {
  counted: boolean; rows: number; signers_per_row: number; need: number; have: number; short: number; plan: string;
  cost: { usd: number; plan_usd: number; plan_signatures: number; top_up: number; top_up_usd: number } | null;
  refusal: { status: number; message: string } | null;
  // Addresses in the list at which an email of this account came back for good lately (src/lib/mailnews.ts).
  bounced?: BouncedAddress[];
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
export function batchLine(c: BatchCheck | null, lang = 'en'): string {
  if (!c?.counted) return '';
  if (c.need === 0) return senderT(lang, 'bulk.cost.none_used');
  return senderT(lang, 'bulk.cost.line', { count: c.need, have: c.have });
}

export function BatchCost({ check, failed, onPaying }: { check: BatchCheck | null; failed: boolean; onPaying?: () => void }) {
  const me = useMe();
  const T = useST();
  const [b] = useLoad(() => api('/billing'));
  if (failed) return <p className="muted small" role="status" id="sn-batch-cost">{T('bulk.cost.failed')}</p>;
  if (!check) return <p className="muted small" role="status" id="sn-batch-cost">{T('bulk.cost.counting')}</p>;
  const c = check;
  const admin = me.role !== 'member';
  const pay = (path: string, body?: any) => {
    onPaying?.();
    return api(path, { method: 'POST', body }).then((r) => { window.location.href = r.url; }).catch(oops);
  };
  const refused = c.refusal && (
    <div className="notice err" role="alert">
      <b>{T('bulk.cost.refused')}</b> {c.refusal.message}
    </div>
  );
  if (!c.counted) return refused ? <div id="sn-batch-cost">{refused}</div> : null; // payments are not connected, so nothing is counted
  const perRow = c.signers_per_row > 1 ? T('bulk.cost.per_row', { people: c.signers_per_row, count: c.rows }) : '';
  if (c.need === 0)
    return <div id="sn-batch-cost">{refused}<div className="notice">{T('bulk.cost.free')}</div></div>;
  if (c.short === 0)
    return (
      <div id="sn-batch-cost">
        {refused}
        <div className="notice">
          <b>{T('bulk.cost.holds', { count: c.need })}</b> {T('bulk.cost.holds_rest', { have: c.have, perRow, left: c.have - c.need })}
          {' '}{T('bulk.cost.holds_back')}
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
        <b>{T('bulk.cost.short', { count: c.need, have: c.have, short: c.short })}</b>
        {' '}{T('bulk.cost.short_rest', { perRow })}
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {c.plan === 'grove'
            ? <li><b>{T('bulk.cost.top_up', { count: c.short, price: usd(cost.top_up_usd) })}</b> {T('bulk.cost.top_up_rest', { trees: treesFor(c.short) })}{tooBig ? ` ${T('bulk.cost.too_big', { max: PRICING.topUpMax })}` : ''}{!admin && ` ${T('bulk.cost.admin_can')}`}</li>
            : <li><b>{T('bulk.cost.plan', { price: usd(cost.plan_usd) })}</b> {T('bulk.cost.plan_rest', { count: cost.plan_signatures })}{cost.top_up > 0 ? <> {T('bulk.cost.then')} <b>{T('bulk.cost.then_top_up', { count: cost.top_up, price: usd(cost.top_up_usd) })}</b>. {T('bulk.cost.that_is')} <b>{T('bulk.cost.in_all', { price: usd(cost.usd) })}</b> {T('bulk.cost.before_batch')}</> : ` ${T('bulk.cost.covers')}`}{!admin && ` ${T('bulk.cost.admin_can')}`}</li>}
          {fits > 0 && <li><b>{T('bulk.cost.shorter')}</b> {T('bulk.cost.shorter_rest', { count: fits })}</li>}
          {next && c.plan === 'grove' && <li><b>{T('bulk.cost.wait')}</b> {T('bulk.cost.wait_rest', { count: PRICING.monthlySignatures, day: fmtDate(next) })}</li>}
        </ul>
        <p className="small" style={{ margin: '8px 0 0' }}>{T('bulk.cost.not_lost')}</p>
        <div className="row wrap" style={{ marginTop: 10 }}>
          {admin && b?.enabled && c.plan === 'grove' && !tooBig && <button type="button" className="btn sm primary" onClick={() => pay('/billing/topup', { quantity: c.short })}>{T('bulk.cost.pay', { price: usd(cost.top_up_usd), count: c.short })}</button>}
          {admin && b?.enabled && c.plan !== 'grove' && <button type="button" className="btn sm primary" onClick={() => pay('/billing/checkout')}>{T('bulk.cost.start_plan', { price: usd(cost.plan_usd) })}</button>}
          <Link href="/app/settings?tab=billing" className="btn sm" onClick={() => onPaying?.()}>{T('bulk.cost.open_plan')}</Link>
        </div>
      </div>
    </div>
  );
}
