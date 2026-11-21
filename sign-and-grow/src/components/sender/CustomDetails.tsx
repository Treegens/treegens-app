'use client';
// The envelope page: the account's own details on this envelope, such as a case number (src/server/customfields.ts),
// folded and closed until asked for. Absent when the envelope has none. They are changed on the last step of the
// editor, also while the envelope is out; once it is completed they are fixed.
import Link from 'next/link';
import { SOURCE_LOCALE, t } from '@/lib/i18n';

const ui = SOURCE_LOCALE;

export function CustomDetails({ envelope: e, editHref }: { envelope: any; editHref: string | null }) {
  const rows: { name: string; value: string; on_certificate?: boolean }[] = e.custom_fields || [];
  if (!rows.length) return null;
  const open = e.status === 'draft' || e.status === 'sent';
  return (
    <details className="card cf-details" style={{ marginTop: 16 }}>
      <summary>{t(ui, 'customfields.page.title')} ({rows.length})</summary>
      <dl>
        {rows.map((r) => (
          <div key={r.name}>
            <dt>{r.name}</dt>
            <dd>{r.value} <span className="muted small">({t(ui, r.on_certificate ? 'customfields.page.printed' : 'customfields.page.not_printed')})</span></dd>
          </div>
        ))}
      </dl>
      {open && editHref && <p className="muted small" style={{ marginBottom: 0 }}><Link href={editHref}>{t(ui, 'customfields.page.change')}</Link></p>}
    </details>
  );
}
