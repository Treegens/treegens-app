import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BellRing, CalendarCheck2, Eye, EyeOff, Globe, Users } from 'lucide-react';
import { Input } from '../../ui';
import type { InputProps } from '../../ui';

function Mark() {
  return (
    <svg width="40" height="40" viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#143524" />
      <rect x="13" y="16" width="38" height="35" rx="8" fill="none" stroke="#f2ede2" strokeWidth="4.5" />
      <path d="M23 11v9M41 11v9" stroke="#f2ede2" strokeWidth="4.5" strokeLinecap="round" />
      <path d="M23.5 34.5l6 6 11.5-12" fill="none" stroke="#5ede8e" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const POINTS = [
  { icon: CalendarCheck2, text: 'Every booking lands in Google Calendar on its own.' },
  { icon: Users, text: 'Joint meetings only offer times when everyone is free.' },
  { icon: BellRing, text: 'Reminders go out by email, text and an AI phone call.' },
  { icon: Globe, text: 'Time zones are worked out for you and for your guests.' },
];

export interface AuthLayoutProps {
  /** small line above the title: "First run", "Welcome back" */
  eyebrow: string;
  title: string;
  description: ReactNode;
  children: ReactNode;
}

/** Shared frame for the setup and sign-in screens: brand panel next to the form. */
export function AuthLayout({ eyebrow, title, description, children }: AuthLayoutProps) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · Scheduling dashboard`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  return (
    <div className="adm-auth">
      <aside className="adm-auth__brand">
        <div className="adm-auth__brandtop">
          <Mark />
          <span>Scheduling dashboard</span>
        </div>
        <div className="adm-auth__pitch">
          <p className="adm-auth__headline">Your time, booked the way you like it.</p>
          <ul className="adm-auth__points" role="list">
            {POINTS.map((p) => (
              <li key={p.text}>
                <p.icon size={18} aria-hidden="true" />
                <span>{p.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main className="adm-auth__main">
        <div className="adm-auth__form">
          <p className="adm-auth__eyebrow">{eyebrow}</p>
          <h1 className="adm-auth__title">{title}</h1>
          <p className="adm-auth__desc">{description}</p>
          {children}
        </div>
      </main>
    </div>
  );
}

/** Password field with a show / hide toggle. */
export function PasswordInput(props: Omit<InputProps, 'type' | 'trailing'>) {
  const [shown, setShown] = useState(false);
  return (
    <Input
      {...props}
      type={shown ? 'text' : 'password'}
      trailing={
        <button type="button" className="adm-auth__reveal" aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} onClick={() => setShown((v) => !v)}>
          {shown ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
        </button>
      }
    />
  );
}
