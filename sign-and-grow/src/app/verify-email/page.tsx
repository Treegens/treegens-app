'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/components/ui';

export default function VerifyEmail() {
  const [state, setState] = useState<'wait' | 'ok' | string>('wait');
  useEffect(() => {
    api('/auth/verify', { body: { token: new URLSearchParams(window.location.search).get('token') } }).then(() => setState('ok')).catch((e) => setState(e.message));
  }, []);
  return (
    <div className="authbox">
      <div className="card center">
        <h1 className="serif" style={{ fontSize: 24 }}>{state === 'wait' ? 'Confirming…' : state === 'ok' ? 'Email confirmed' : 'That did not work'}</h1>
        <p className="muted" style={{ margin: '10px 0 16px' }}>{state === 'ok' ? 'Documents sent to this address will now show up in your inbox.' : state === 'wait' ? '' : state}</p>
        <Link href="/app" className="btn primary">Go to Sign&Grow</Link>
      </div>
    </div>
  );
}
