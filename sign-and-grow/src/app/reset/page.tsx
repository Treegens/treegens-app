import { AuthForm } from '@/components/AuthForm';

export const metadata = { title: 'New password' };

export default function Page() {
  return <AuthForm mode="reset" />;
}
