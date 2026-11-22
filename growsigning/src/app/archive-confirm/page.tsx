import { ConfirmView } from './ConfirmView';

// Nobody finds this page by searching: it is reached from the email that asks an address to confirm.
export const metadata = { title: 'Copies of emails', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };

export default function Page() {
  return <ConfirmView />;
}
