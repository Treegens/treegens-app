import { AuthForm } from '@/components/AuthForm';

export const metadata = { title: 'Create account' };

export default function Page() {
  return <AuthForm mode="signup" />;
}
