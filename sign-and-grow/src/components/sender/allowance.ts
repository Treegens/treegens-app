'use client';
import { api, useLoad } from '@/components/ui';

// What limits sending on this account, in whichever shape the server reports it:
//   envelopes   a number of envelopes per month, with a reset date   (GET /api/billing: used, limit, resets_at)
//   signatures  a balance of signatures, some held for people who have not signed yet   (billing.signatures)
//   null        nothing is counted, so there is nothing to show
export type Allowance =
  | { kind: 'envelopes'; plan: string; used: number; limit: number; resets_at: string | null }
  | { kind: 'signatures'; plan: string; balance: number; held: number; available: number }
  | null;

export function readAllowance(billing: any, me: any): Allowance {
  const plan = String(billing?.plan || me?.account?.plan || '');
  const b = billing || me?.billing;
  if (b && typeof b.limit === 'number') return { kind: 'envelopes', plan, used: Number(b.used) || 0, limit: b.limit, resets_at: b.resets_at || null };
  const s = billing?.signatures || me?.billing?.signatures;
  if (s && typeof s.available === 'number') return { kind: 'signatures', plan, balance: Number(s.balance) || 0, held: Number(s.held) || 0, available: s.available };
  return null;
}

/** Loads the allowance fresh, so the number on screen is the number the next send will be checked against. */
export function useAllowance(): [Allowance, () => void, boolean] {
  const [data, reload] = useLoad<{ billing: any; me: any }>(async () => {
    const [billing, me] = await Promise.all([api('/billing').catch(() => null), api('/me').catch(() => null)]);
    return { billing, me };
  });
  return [data ? readAllowance(data.billing, data.me) : null, reload, !!data];
}

/** A sentence for the moment something is voided, true for the way this account is counted. */
export function voidCostLine(a: Allowance): string {
  if (a?.kind === 'envelopes') return 'Voided envelopes do not count toward your plan.';
  if (a?.kind === 'signatures') return 'Signatures held for people who have not signed yet go back to your balance.';
  return '';
}
