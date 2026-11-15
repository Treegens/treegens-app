import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Globe } from 'lucide-react';
import { ApiFailure, errorMessage, setup } from '../../lib/api';
import { detectZone, zoneLabel } from '../../lib/tz';
import { Button, Field, Input } from '../../ui';
import { AuthLayout, PasswordInput } from '../components/AuthLayout';
import { Notice } from '../components/Page';

const MIN_PASSWORD = 10;
const KNOWN_FIELDS = ['code', 'password', 'repeat', 'email'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CODE_ALREADY_USED = 'This setup code was already used. Deploy the hash of a new code first, then try again.';

export interface SetupProps {
  onDone: () => void;
  onRecheck?: () => void;
  /** "reset": a forgotten password, replaced with a new setup code (opened from the sign-in screen) */
  mode?: 'first-run' | 'reset';
  /** reset only: back to the sign-in screen */
  onBack?: () => void;
}

/**
 * First run: the one-time setup code plus a new password. Signs in and lands on Home.
 * Reset: the same form with a NEW setup code replaces a forgotten password and signs every other device out.
 */
export default function Setup({ onDone, onRecheck, mode = 'first-run', onBack }: SetupProps) {
  const resetting = mode === 'reset';
  const zone = useMemo(() => detectZone(), []);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [email, setEmail] = useState('');
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
    if (email.trim() && !EMAIL.test(email.trim())) next.email = 'Please enter a full email address, or leave this empty.';
    setFields(next);
    setFormError(null);
    if (Object.keys(next).length) return;

    setBusy(true);
    try {
      await setup(resetting ? { code: code.trim(), password } : { code: code.trim(), password, deviceTimezone: zone, ...(email.trim() ? { email: email.trim() } : {}) });
      onDone();
    } catch (err) {
      const failure = err instanceof ApiFailure ? err : null;
      const mapped = Object.fromEntries(Object.entries(failure?.fields ?? {}).filter(([k]) => KNOWN_FIELDS.includes(k)));
      if (Object.keys(mapped).length) setFields(mapped);
      else if (failure && (failure.status === 401 || failure.status === 403)) setFields({ code: failure.message || 'That setup code is not right.' });
      // Reset: the code on file has set a password already, so a new one was not deployed (yet).
      else if (resetting && failure?.status === 409) setFormError(CODE_ALREADY_USED);
      else setFormError(errorMessage(err));
      // 409 on the first run: setup was already finished (another tab, or an earlier visit). Offer the way to the sign-in screen.
      setAlreadyDone(!resetting && failure?.status === 409);
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      eyebrow={resetting ? 'Forgot your password' : 'First run'}
      title={resetting ? 'Choose a new password' : 'Set up your dashboard'}
      description={
        resetting
          ? 'A new setup code replaces a forgotten password. Your meetings, settings and connections stay as they are.'
          : 'Enter the one-time setup code from your deployment, then choose the password you will sign in with.'
      }
    >
      <form className="adm-auth__fields" onSubmit={submit} noValidate>
        {resetting ? (
          <Notice tone="info" title="First, give this site a new setup code">
            <ol style={{ margin: '4px 0 0', paddingLeft: '1.25em' }}>
              <li>Make up a new code that you have not used before.</li>
              <li>In the Netlify settings of this site, put the SHA-256 hash of that code in MEETING_SETUP_CODE_HASH.</li>
              <li>Deploy the site again, then enter the new code here.</li>
            </ol>
            <p style={{ margin: '6px 0 0' }}>The README of this app lists the exact commands. Every other device is signed out once the new password is saved.</p>
          </Notice>
        ) : null}
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
        <Field
          label={resetting ? 'New setup code' : 'Setup code'}
          error={fields.code}
          hint={resetting ? 'The code whose hash you just deployed. It works once.' : 'It works once. After this, only your password opens the dashboard.'}
        >
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
        {resetting ? null : (
          <>
            <Field label="Your email" optional error={fields.email} hint="Where we tell you about new, moved and cancelled bookings. You can change it under Settings.">
              <Input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" size="lg" />
            </Field>
            <p className="adm-auth__zone">
              <Globe size={16} aria-hidden="true" />
              <span>
                Your time zone is set to <strong>{zoneLabel(zone)}</strong>, read from this device. It keeps itself up to date when you travel.
              </span>
            </p>
          </>
        )}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          loading={busy}
          loadingLabel={resetting ? 'Saving' : 'Setting up'}
          iconRight={<ArrowRight size={18} />}
        >
          {resetting ? 'Save my new password' : 'Create my dashboard'}
        </Button>
        {resetting && onBack ? (
          <Button variant="link" onClick={onBack} disabled={busy}>
            Back to sign in
          </Button>
        ) : null}
      </form>
    </AuthLayout>
  );
}
