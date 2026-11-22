'use client';
// The one way from Documents to the documents an admin brought in (src/app/app/imported). With none brought in, an
// empty list offers to bring some in (research/ux-notes.json, gov-G19); a list with documents shows nothing. Once any
// are brought in, the link to them takes that place, on an empty list and under a full one.
import Link from 'next/link';
import { api, useLoad } from '@/components/ui';

const TALL = { display: 'inline-flex', alignItems: 'center', minHeight: 44 } as const;

export function BroughtInLink({ empty = false }: { empty?: boolean }) {
  const [r] = useLoad<any>(() => api('/imported/count'), []);
  const n: number = r?.count || 0;
  if (n > 0) return <div style={{ marginTop: 14 }}><Link href="/app/imported" style={TALL}>Documents brought in ({n})</Link></div>;
  if (empty && r) return <div style={{ marginTop: 14 }}><Link href="/app/settings?tab=data#bring-in" style={TALL}>Bring in documents from DocuSign or an export</Link></div>;
  return null;
}
