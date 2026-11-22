'use client';
// The sender screen inside a customer's app: the editor of one draft, without our menus (src/server/embed.ts).
// The link opens once, within 5 minutes; the token it gives is kept in this tab only, so a reload carries on. When
// the draft is sent or the screen is closed, the app around it is told (to its website only) and the frame goes back
// to the app's return_url, with ?event=sent or ?event=closed.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/components/ui';
import { setScreenToken } from '@/components/screenToken';
import { MeProvider } from '@/components/AppShell';
import { Editor } from '@/components/Editor';
import { StateCard } from '@/components/sign/parts';
import '../../../styles/embed.css';

type Screen = { session: string; envelope_id: string; origin: string; return_url: string };
const opening = new Map<string, Promise<Screen>>();
const keyOf = (ticket: string) => `gs-screen:${ticket.slice(0, 16)}`;

function kept(ticket: string): Screen | null {
  try {
    return JSON.parse(sessionStorage.getItem(keyOf(ticket)) || 'null');
  } catch {
    return null;
  }
}

export default function SenderScreen() {
  const { ticket } = useParams<{ ticket: string }>();
  const [screen, setScreen] = useState<Screen | null>(null);
  const [me, setMe] = useState<any>(null);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');

  const loadMe = useCallback(() => api('/me').then(setMe).catch((e) => setProblem(e?.message || 'We could not open the sender screen. Go back to the app you came from and open it again.')), []);
  useEffect(() => {
    const was = kept(ticket);
    const start = (s: Screen) => (setScreenToken(s.session), setScreen(s), loadMe());
    if (was) return void start(was);
    // The link opens once, so it is asked for once per page, also when React runs this effect twice.
    if (!opening.has(ticket)) opening.set(ticket, api('/embed/sender/open', { body: { ticket } }).then((s: Screen) => {
      try {
        sessionStorage.setItem(keyOf(ticket), JSON.stringify(s));
      } catch {
        // A browser that keeps nothing for this tab still works; only a reload would need a new link.
      }
      return s;
    }));
    opening.get(ticket)!.then(start).catch((e) => setProblem(e?.message || 'We could not open the sender screen. Go back to the app you came from and open it again.'));
  }, [ticket, loadMe]);

  const finish = async (event: 'sent' | 'closed') => {
    if (!screen) return;
    let back = screen.return_url;
    let said: string = event;
    try {
      const r = await api('/embed/sender/close', { method: 'POST', body: {} });
      back = r.return_url || back;
      said = r.event || event;
    } catch {
      // Ended already (sent, or an hour went by): go back all the same.
    }
    try {
      sessionStorage.removeItem(keyOf(ticket));
    } catch {}
    setScreenToken('');
    if (window.parent !== window) window.parent.postMessage({ source: 'growsigning', event: said, envelope_id: screen.envelope_id }, screen.origin);
    setDone(said === 'sent' ? 'Sent. Taking you back.' : 'Closed. Taking you back.');
    const u = new URL(back);
    u.searchParams.set('event', said);
    window.location.assign(u.toString());
  };

  if (problem) return <main className="embed-screen"><StateCard tone="warn" title="This screen cannot open"><p>{problem}</p></StateCard></main>;
  if (done) return <main className="embed-screen" aria-live="polite"><p className="muted">{done}</p></main>;
  if (!screen || !me?.user) return <main className="embed-screen" aria-busy="true"><p className="muted">Opening the document…</p></main>;
  return (
    <MeProvider value={{ ...me, reload: loadMe }}>
      <main className="embed-screen">
        <Editor id={screen.envelope_id} embedded={{ onDone: finish, onProblem: (said) => setProblem(`${said} Go back to the app you came from.`) }} />
      </main>
    </MeProvider>
  );
}
