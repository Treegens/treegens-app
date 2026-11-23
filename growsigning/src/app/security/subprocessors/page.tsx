import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { dataPlace } from '@/lib/dataplace';
import { outsideShown, unstatedSentence } from '@/lib/outside-shown';
import { dayText } from '@/lib/dates';
import { ProcessorTable, Stated } from '../DataPlace';

export const metadata = { title: 'Sub-processors', description: 'Who else handles data on this GrowSigning server, in which country and what for. Made from the settings it runs on.' };

// The same list as "Where your data is" on /security and the table of /security/processing: dataPlace() in
// src/lib/dataplace.ts, which reads the settings the server runs on. A provider is here because its switch is on;
// what the operator has not stated is printed as not stated. Below it, the other outside services that are on, from
// src/lib/outside.ts, so a reader sees every connection, also those that are not sent personal data.
export const dynamic = 'force-dynamic';

// A link in a sentence still gets a 44 px tall target: vertical padding grows the tap area without moving the lines.
const TAP = { padding: '14px 0' } as const;

// The rows of dataPlace() already cover these; the rest of outsideServices() are listed under "Also connected to".
const IN_TABLE = new Set(['mail', 'payments', 'google', 'microsoft', 'sms', 'chat']);

export default function Subprocessors() {
  const d = dataPlace();
  // Every service that is on, the time-stamp service too with or without a seal (src/lib/outside-shown.ts).
  const others = outsideShown().filter((s) => s.on && !IN_TABLE.has(s.id));
  const unstated = unstatedSentence(d.unstated);
  return (
    <div className="pub pub-print">
      <PublicNav />
      <main id="main" className="wrap pub-page pub-doc">
        <header className="pub-top">
          <h1 className="pub-h1">Sub-processors</h1>
          <p className="pub-lead">Who else handles data on this server, in which country, and what for.</p>
          <p className="pub-doc-meta">Made on {dayText(new Date())} from the settings this server runs on. Server operated by: {d.operator ? <Stated value={d.operator} what="who they are" /> : 'not stated.'}</p>
        </header>

        <p>A company is on this list because the setting that switches it on is set, not because someone wrote it down. Whatever the operator of this server has not stated about it is said as not stated. A signed agreement about these companies is between you and the operator, not the software.</p>

        <ProcessorTable d={d} />
        {d.off.length > 0 && <p style={{ marginTop: 12 }}><b>Not in use on this server:</b> {d.off.join(' ')}</p>}
        {unstated && <p id="unstated"><b>Not stated.</b> {unstated} Ask whoever gave you this address before you rely on this list, or write to them through <Link href="/help?topic=other#contact" style={TAP}>the contact form</Link>.</p>}

        {others.length > 0 && (
          <>
            <h2>Also connected to</h2>
            <p>Services this server is set up to reach for one job each. What each one is sent is said next to it.</p>
            <ul className="pub-list">
              {others.map((s) => (
                <li key={s.id}><b>{s.name}.</b> {s.purpose}{s.hosts.length ? ` (${s.hosts.join(', ')})` : s.hostWords && s.id !== 'webhooks' ? ` (${s.hostWords})` : ''}</li>
              ))}
            </ul>
          </>
        )}

        <p className="muted small" style={{ marginTop: 24 }}>Every outside service the software can reach, on or off, is on <Link href="/security#outside" style={TAP}>Security and trust</Link>. What is processed and for how long is in the <Link href="/security/processing" style={TAP}>data processing summary</Link>. The papers for a procurement team are on <Link href="/procurement" style={TAP}>Procurement documents</Link>.</p>
      </main>
      <PublicFooter />
    </div>
  );
}
