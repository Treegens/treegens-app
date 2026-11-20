'use client';
import { api, useLoad } from '@/components/ui';

// What limits sending on this account: a balance of signatures, some of them held for people who have been asked
// and have not signed yet. null means nothing is counted (no payment provider is connected), so there is nothing to show.
export type Allowance = { kind: 'signatures'; plan: string; balance: number; held: number; available: number; freeWith: string | null } | null;

export function readAllowance(billing: any, me: any): Allowance {
  const plan = String(billing?.plan || me?.account?.plan || '');
  const s = billing?.signatures || me?.billing?.signatures;
  if (s && typeof s.available === 'number') return { kind: 'signatures', plan, balance: Number(s.balance) || 0, held: Number(s.held) || 0, available: s.available, freeWith: billing?.free_with || me?.account?.free_with || null };
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
  if (a?.kind === 'signatures') return 'Signatures held for people who have not signed yet go back to your balance.';
  return '';
}
