import { AuthForm } from '@/components/AuthForm';

export const metadata = { title: 'Sign in' };

export default function Page() {
  return <AuthForm mode="login" />;
}
