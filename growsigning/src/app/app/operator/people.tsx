'use client';
// The people of one account with the phone number each gave (src/server/signuprules.ts), for the people who run the
// service. Nobody else is ever sent these numbers: senders and team admins do not see each other's. Loaded only
// when it is opened. A number can be allowed for more than one login here (a family, a shop with one phone).
import { useState } from 'react';
import { api, fmtDate, oops, toast } from '@/components/ui';

export function AccountPeople({ id }: { id: string }) {
  const [people, setPeople] = useState<any[] | null>(null);
  const load = () => api(`/operator/accounts/${id}/people`).then((r) => setPeople(r.people)).catch(oops);
  const share = (phone: string, shared: boolean) => {
    if (!window.confirm(shared ? `Allow ${phone} for more than one login? Anyone can then sign up with this number as well.` : `Stop allowing ${phone} for more than one login? Logins that already have it keep it.`)) return;
    api('/operator/phones', { body: { phone, shared } }).then(() => (toast(shared ? 'This number can now be used by more than one login.' : 'This number is for one login again.'), load())).catch(oops);
  };
  return (
    <details data-fold="" className="small" style={{ margin: '0 0 8px' }} onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && !people && load()}>
      <summary style={{ cursor: 'pointer', minHeight: 32 }}>People and phone numbers</summary>
      {!people ? <p className="muted">Loading</p> : (
        <ul className="rules" style={{ marginTop: 6 }}>{people.map((u) => (
          <li key={u.id}>
            <b>{u.name}</b> · {u.email} · {u.role} · login made {fmtDate(u.created_at)} · {u.phone
              ? <>{u.phone}{u.phone_verified ? ' (checked by code)' : ' (not checked by code)'}{u.phone_also_on > 0 ? ` · also on ${u.phone_also_on} other ${u.phone_also_on === 1 ? 'login' : 'logins'}` : ''}{' '}
                <button className="btn sm" onClick={() => share(u.phone, !u.phone_shared)}>{u.phone_shared ? 'One login per number again' : 'Allow for more than one login'}</button></>
              : u.asked === 'now' ? 'no phone number yet: asked before the app opens' : u.asked ? 'no phone number yet: asked, needed before the next new send' : 'no phone number: not asked'}
          </li>
        ))}</ul>
      )}
    </details>
  );
}
