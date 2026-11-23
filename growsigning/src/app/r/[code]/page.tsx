// An invite link: growsigning.com/r/<code> (src/server/referrals.ts). It is the short form people pass on, and it
// only leads to the sign-up page, which asks the server whether the code still counts. A code that is not one of
// ours leads to the plain sign-up page: nobody is turned away for a mistyped link.
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { isReferralCode } from '@/lib/referral';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'You are invited', robots: { index: false, follow: false } };

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const code = String((await params).code || '').toLowerCase();
  redirect(isReferralCode(code) ? `/signup?ref=${code}` : '/signup');
}
