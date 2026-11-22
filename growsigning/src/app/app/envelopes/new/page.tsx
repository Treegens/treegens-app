'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api, oops } from '@/components/ui';
import { useMe } from '@/components/AppShell';

// Creates a blank draft (or template) and opens the editor.
export default function NewEnvelope() {
  const router = useRouter();
  const me = useMe();
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const q = new URLSearchParams(window.location.search);
    const kind = q.get('kind') === 'template' ? 'template' : 'envelope';
    const body: any = { kind };
    if (q.get('self')) body.recipients = [{ id: 'me', role: 'signer', name: me.user.name, email: me.user.email, routing_order: 1 }];
    api('/envelopes', { body })
      // ?write=1 ("Write a template" on the empty Templates page) opens step 1 on the writing view (editor/WriteDoc.tsx).
      .then((d) => router.replace(`/app/${kind === 'template' ? 'templates' : 'envelopes'}/${d.envelope.id}/edit${q.get('write') ? '?write=1' : ''}`))
      .catch((e) => (oops(e), router.replace('/app')));
  }, [router, me]);
  return <div className="muted center" style={{ padding: 80 }}>Starting a new {'envelope'}…</div>;
}
