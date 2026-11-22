'use client';
// Forms: how many people may sign one form, and the day it closes (PATCH /api/powerforms/:id with "max_signed" and
// "closes_at", src/server/switches.ts). Both empty means no limit, as before. Opened from the form's More.
import { useState } from 'react';
import { api, Modal, toast } from '@/components/ui';
import { deviceZone } from '@/lib/dates';
import { formLimitLine, formLastDay } from '@/lib/switches';

export { formLimitLine };

export function FormLimits({ form, onClose, onSaved }: { form: any; onClose: () => void; onSaved: () => void }) {
  const [most, setMost] = useState(form.max_signed ? String(form.max_signed) : '');
  const [day, setDay] = useState(formLastDay(form) || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setError('');
    setBusy(true);
    try {
      await api(`/powerforms/${form.id}`, { method: 'PATCH', body: { max_signed: most.trim() ? Number(most) : null, closes_at: day || null, tz: deviceZone() } });
      toast('Saved');
      onSaved();
    } catch (e: any) {
      setError(e?.message || 'That was not saved. Try again.');
    }
    setBusy(false);
  };
  return (
    <Modal title={`When ${form.name} closes`} onClose={onClose}>
      <p className="muted small">Leave both empty for a form that stays open. After either one, the form says it is closed and who to write to. The last day ends at midnight where you are now. People who started before can still finish.</p>
      <label className="f"><span>Most people who may sign it</span>
        <input type="number" inputMode="numeric" min={1} value={most} onChange={(e) => setMost(e.target.value)} placeholder="No limit" />
      </label>
      <label className="f"><span>Last day it takes signatures</span>
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      </label>
      {error && <p className="notice err" role="alert">{error}</p>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn" style={{ minHeight: 44 }} onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" style={{ minHeight: 44 }} disabled={busy} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
