'use client';
import { useEffect, useState } from 'react';
import { api, oops } from '@/components/ui';
import { useSaved } from '@/components/settings/Frame';
import { useST } from '@/components/senderLang';

// Settings, Team, for admins: signing at a service counter (src/server/counter.ts). Closed, and nothing of it shows
// anywhere else until an admin gives someone the counter permission here. Each switch saves as it changes.
export function CounterSettings() {
  const T = useST();
  const [d, setD] = useState<any>(null);
  const [contact, setContact] = useState('');
  const [saved, say] = useSaved();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || d) return;
    api('/counter/settings').then((x) => (setD(x), setContact(x.settings.contact || ''))).catch(oops);
  }, [open, d]);
  // A tick shows at once (`now` changes what is on screen), and goes back with the error if the save fails.
  const put = (path: string, body: any, now?: (x: any) => any) => {
    const before = d;
    if (now) setD(now(d));
    return api(path, { method: 'PUT', body }).then((x) => (setD(x), say())).catch((e) => (setD(before), oops(e)));
  };
  const tick = (list: 'members' | 'templates', id: string, patch: any) => (x: any) => ({ ...x, [list]: x[list].map((m: any) => (m.id === id ? { ...m, ...patch } : m)) });
  return (
    <details className="set-counter" data-fold="" data-feature="gov-G18" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary><b>{T('settings.counter.title')}</b> <span className="muted small">{T('settings.counter.lead')}</span></summary>
      {d && (
        <div className="stack" style={{ marginTop: 12 }}>
          {saved}
          <p className="muted small" style={{ margin: 0 }}>{T('settings.counter.intro')} {T('counter.cannot_check_id')}</p>
          <fieldset className="ct-radio" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend><b>{T('settings.counter.who')}</b></legend>
            {d.members.map((m: any) => (
              <label key={m.id} className="check" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 20, height: 20 }} checked={m.counter} onChange={(e) => put(`/counter/staff/${m.id}`, { counter: e.target.checked }, tick('members', m.id, { counter: e.target.checked }))} /> <span>{m.name} <span className="muted small">{m.email}</span></span></label>
            ))}
          </fieldset>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend><b>{T('settings.counter.docs')}</b></legend>
            {d.templates.length === 0 ? <p className="muted small" style={{ margin: 0 }}>{T('settings.counter.none')}</p> : d.templates.map((t: any) => (
              <div key={t.id} className="stack" style={{ gap: 0 }}>
                <label className="check" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 20, height: 20 }} checked={t.counter} onChange={(e) => put(`/counter/templates/${t.id}`, { counter: e.target.checked }, tick('templates', t.id, { counter: e.target.checked }))} /> <span>{t.subject}</span></label>
                {t.counter && <label className="check" style={{ minHeight: 44, marginLeft: 30 }}><input type="checkbox" style={{ width: 20, height: 20 }} checked={t.show_values} onChange={(e) => put(`/counter/templates/${t.id}`, { counter: true, show_values: e.target.checked }, tick('templates', t.id, { show_values: e.target.checked }))} /> <span className="small">{T('settings.counter.show_values')} <span className="muted">{T('settings.counter.show_values_hint')}</span></span></label>}
              </div>
            ))}
          </fieldset>
          <label className="check" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 20, height: 20 }} checked={d.settings.official_may_witness} onChange={(e) => put('/counter/settings', { official_may_witness: e.target.checked }, (x) => ({ ...x, settings: { ...x.settings, official_may_witness: e.target.checked } }))} /> <span>{T('settings.counter.witness')}</span></label>
          {d.pictures_possible && <label className="check" style={{ minHeight: 44 }}><input type="checkbox" style={{ width: 20, height: 20 }} checked={d.settings.id_scans} onChange={(e) => put('/counter/settings', { id_pictures: e.target.checked }, (x) => ({ ...x, settings: { ...x.settings, id_scans: e.target.checked } }))} /> <span>{T('settings.counter.id_pictures')}</span></label>}
          <label className="f" style={{ margin: 0 }}><span>{T('settings.counter.contact')}</span><input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={300} placeholder={T('settings.counter.contact_example')} /></label>
          <div><button type="button" className="btn" onClick={() => put('/counter/settings', { contact })}>{T('settings.counter.save_contact')}</button></div>
        </div>
      )}
    </details>
  );
}
