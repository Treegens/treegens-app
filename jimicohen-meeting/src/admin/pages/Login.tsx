import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { ApiFailure, errorMessage, login } from '../../lib/api';
import { Button, Field } from '../../ui';
import { AuthLayout, PasswordInput } from '../components/AuthLayout';
import { Notice } from '../components/Page';

export default function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setFormError(null);
    if (!password) {
      setFieldError('Enter your password.');
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      await login(password);
      onDone();
    } catch (err) {
      const failure = err instanceof ApiFailure ? err : null;
      if (failure && (failure.status === 401 || failure.status === 403 || failure.status === 422)) {
        setFieldError(failure.fields?.password ?? (failure.status === 401 ? 'That password is not right. Please try again.' : failure.message));
      } else {
        setFormError(errorMessage(err));
      }
      setBusy(false);
    }
  };

  return (
    <AuthLayout eyebrow="Welcome back" title="Sign in" description="This dashboard is private. Enter your password to manage your meetings.">
      <form className="adm-auth__fields" onSubmit={submit} noValidate>
        {formError ? <Notice tone="danger">{formError}</Notice> : null}
        <Field label="Password" error={fieldError}>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" size="lg" autoFocus />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy} loadingLabel="Signing in" iconRight={<ArrowRight size={18} />}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
