'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from '@/components/ui';
import { useST } from '@/components/senderLang';
import { onePersonLineShown } from '@/lib/simplicity';

// repair-simplicity-r6: Home's "only you can manage this team" line. It used to be a 55-word warning that nobody could
// close, shown to every paying person who works alone (charter P8 and P9). Now it is one line, only for a team of two
// or more people, with a close button that remembers. The full explanation stays where the job is done: Settings, Team.
const KEY = 'sg_one_person_line';

export function OnePersonLine({ me }: { me: any }) {
  const T = useST();
  const [gone, setGone] = useState(true);
  useEffect(() => {
    try {
      setGone(localStorage.getItem(KEY) === '1');
    } catch {
      setGone(false);
    }
  }, []);
  if (gone || !onePersonLineShown({ role: me?.role, admins: me?.admins, members: me?.members })) return null;
  const hide = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* storage can be unavailable: then it shows again next time, which is harmless */
    }
    setGone(true);
    try {
      const h = document.querySelector<HTMLElement>('main h1') || document.querySelector<HTMLElement>('h1');
      if (h) {
        if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
        h.focus();
      }
    } catch {
      /* nothing to focus: the toast still says what happened */
    }
    toast(T('home.add_dismissed'));
  };
  return (
    <p className="sn-drafts ph-hint" role="note">
      <span>
        {T('home.one_person.title')} {T('home.one_person.body', { email: me.user.email })}{' '}
        <Link href="/app/settings?tab=team" style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>{T('home.one_person.button')}</Link>
      </span>
      <button type="button" className="ph-hint-x" onClick={hide} aria-label={T('home.add_dismiss_label')}>×</button>
    </p>
  );
}
