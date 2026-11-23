'use client';
import { api, useLoad } from '@/components/ui';

// What limits sending on this account: a balance of signatures, some of them held for people who have been asked
// and have not signed yet. null means nothing is counted (no payment provider is connected), so there is nothing to show.
export type Allowance = {
  kind: 'signatures'; plan: string; balance: number; held: number; available: number; freeWith: string | null;
  /** When this month's signatures of the plan reset (or end, when no new month follows), from GET /billing `period`. */
  period?: { resets_at: string; fresh: string } | null;
  /** The first date any of the signatures left expires, when there is no plan month. */
  firstExpiry?: string | null;
  /** The signatures that expired most recently, when nothing was added since (GET /billing `last_expiry`). */
  lastExpiry?: { n: number; at: string; source?: string } | null;
  /** The month ended and the renewal payment is on its way (GET /billing `renewal_pending`). */
  renewalPending?: boolean;
} | null;

export function readAllowance(billing: any, me: any): Allowance {
  const plan = String(billing?.plan || me?.account?.plan || '');
  const s = billing?.signatures || me?.billing?.signatures;
  if (s && typeof s.available === 'number') return {
    kind: 'signatures', plan, balance: Number(s.balance) || 0, held: Number(s.held) || 0, available: s.available, freeWith: billing?.free_with || me?.account?.free_with || null,
    period: billing?.period ? { resets_at: billing.period.resets_at, fresh: billing.period.fresh } : null,
    firstExpiry: (billing?.lots || []).find((l: any) => l.live && l.left > 0 && l.expires_at)?.expires_at || null,
    lastExpiry: billing?.last_expiry || null, renewalPending: !!billing?.renewal_pending,
  };
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
  if (a?.kind === 'signatures') return 'Signatures held for people who have not signed yet go back to your balance, except any whose own date has passed while they were held: those expire instead.';
  return '';
}
