import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Globe } from 'lucide-react';
import { ApiFailure, errorMessage, setup } from '../../lib/api';
import { detectZone, zoneLabel } from '../../lib/tz';
import { Button, Field, Input } from '../../ui';
import { AuthLayout, PasswordInput } from '../components/AuthLayout';
import { Notice } from '../components/Page';

const MIN_PASSWORD = 10;
const KNOWN_FIELDS = ['code', 'password', 'repeat'];

/** First run: the one-time setup code plus a new password. Signs in and lands on Home. */
export default function Setup({ onDone, onRecheck }: { onDone: () => void; onRecheck?: () => void }) {
  const zone = useMemo(() => detectZone(), []);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [alreadyDone, setAlreadyDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    if (!code.trim()) next.code = 'Enter the setup code.';
    if (password.length < MIN_PASSWORD) next.password = `Use at least ${MIN_PASSWORD} characters.`;
    else if (repeat !== password) next.repeat = 'The two passwords do not match.';
    setFields(next);
    setFormError(null);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      await setup({ code: code.trim(), password, deviceTimezone: zone });
      onDone();
    } catch (err) {
      const failure = err instanceof ApiFailure ? err : null;
      const mapped = Object.fromEntries(Object.entries(failure?.fields ?? {}).filter(([k]) => KNOWN_FIELDS.includes(k)));
      if (Object.keys(mapped).length) setFields(mapped);
      else if (failure && (failure.status === 401 || failure.status === 403)) setFields({ code: failure.message || 'That setup code is not right.' });
      else setFormError(errorMessage(err));
      // 409: setup was already finished (another tab, or an earlier visit). Offer the way to the sign-in screen.
      setAlreadyDone(failure?.status === 409);
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      eyebrow="First run"
      title="Set up your dashboard"
      description="Enter the one-time setup code from your deployment, then choose the password you will sign in with."
    >
      <form className="adm-auth__fields" onSubmit={submit} noValidate>
        {formError ? (
          <Notice
            tone="danger"
            action={
              alreadyDone && onRecheck ? (
                <Button variant="secondary" size="sm" onClick={onRecheck}>
                  Go to sign in
                </Button>
              ) : undefined
            }
          >
            {formError}
          </Notice>
        ) : null}
        <Field label="Setup code" error={fields.code} hint="It works once. After this, only your password opens the dashboard.">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="u-mono"
            size="lg"
            autoFocus
          />
        </Field>
        <Field label="New password" error={fields.password} hint={`At least ${MIN_PASSWORD} characters. A short sentence works well.`}>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" size="lg" />
        </Field>
        <Field label="Repeat password" error={fields.repeat}>
          <PasswordInput value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" size="lg" />
        </Field>
        <p className="adm-auth__zone">
          <Globe size={16} aria-hidden="true" />
          <span>
            Your time zone is set to <strong>{zoneLabel(zone)}</strong>, read from this device. It keeps itself up to date when you travel.
          </span>
        </p>
        <Button type="submit" variant="primary" size="lg" block loading={busy} loadingLabel="Setting up" iconRight={<ArrowRight size={18} />}>
          Create my dashboard
        </Button>
      </form>
    </AuthLayout>
  );
}
