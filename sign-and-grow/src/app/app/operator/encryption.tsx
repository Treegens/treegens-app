'use client';
// One line on /app/operator when this server runs without an encryption key, or when encrypted values in the
// database need a look (GET /api/operator/encryption, src/server/routes-colcrypt.ts). With a key and nothing wrong,
// nothing is drawn.
import { api, useLoad } from '@/components/ui';

export function EncryptionLine() {
  const [d] = useLoad<{ on: boolean; warning: string | null } | null>(() => api('/operator/encryption').catch(() => null));
  if (!d?.warning) return null;
  return (
    <p className="notice small" role="status" data-feature="ds-db-encrypt">
      {d.on ? 'Encryption needs a look: ' : 'Encryption off: '}
      {d.warning}
    </p>
  );
}
