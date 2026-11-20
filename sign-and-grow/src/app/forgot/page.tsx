import { AuthForm } from '@/components/AuthForm';

export const metadata = { title: 'Reset password' };

export default function Page() {
  return <AuthForm mode="forgot" />;
}
