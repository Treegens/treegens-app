'use client';
import Link from 'next/link';
import { api, useLoad, Leaf } from '@/components/ui';
import { PublicNav, PublicFooter } from '@/components/Public';
import { fmtNum, fmtTrees, IMPACT, PLANS } from '@/lib/impact';

const FEATURES: [string, string][] = [
  ['Send for signature', 'Upload PDFs or images, add signers, approvers, viewers and people who get a copy. Sign in order or all at once.'],
  ['Drag and drop fields', 'Signatures, initials, dates, text, checkboxes, radio buttons, dropdowns, attachments and notes. Required or optional, prefilled or validated.'],
  ['Sign anywhere', 'Recipients sign from any phone or computer with no account. Type, draw or upload a signature. Finish later, decline or pass it to someone else.'],
  ['Templates and bulk send', 'Set a document up once and reuse it. Send one template to hundreds of people from a spreadsheet.'],
  ['PowerForms', 'A public link or QR code that lets anyone fill in and sign a form on their own. Good for waivers, sign-ups and consent forms.'],
  ['In-person signing', 'Host a signing on your own tablet or laptop when the signer is standing next to you.'],
  ['Reminders and expiry', 'Automatic nudges, deadlines, voiding with a reason, and fixing a typo in an email address after sending.'],
  ['Proof you can check', 'Every envelope gets a certificate of completion and a hash-chained audit trail. Anyone can verify a signed PDF on our public page.'],
  ['Teams and branding', 'Invite colleagues, share templates, set roles, and put your own logo and colour on emails and the signing screen.'],
  ['API and webhooks', 'Create envelopes, embed signing in your own product and get notified of every event. Included on every plan.'],
  ['Access codes', 'Protect sensitive documents with a code you share with the signer separately.'],
  ['Reports', 'See what is waiting, how long signing takes and how much paper your team has kept out of the printer.'],
];

const COMPARE: [string, string, string][] = [
  ['Where your money goes', '100% of subscription revenue to tree planting', 'Company profit'],
  ['Signers pay', 'Never', 'Never'],
  ['API and webhooks', 'Every plan, including free', 'Often a separate, pricier plan'],
  ['Bulk send and public forms', 'Every plan', 'Usually higher tiers only'],
  ['Check a signed PDF', 'Public page, no account needed', 'Usually needs an account or the sender'],
  ['Audit trail', 'Hash chained, tampering is detectable', 'Event log'],
  ['Environmental impact', 'Shown on every envelope, with the maths published', 'Rarely shown'],
  ['Run it yourself', 'Yes, one server and one database file', 'No'],
];

export default function Landing() {
  const [imp] = useLoad(() => api('/public/impact'));
  return (
    <div>
      <PublicNav />
      <main>
        <section className="wrap hero">
          <div>
            <div className="badge completed" style={{ marginBottom: 16 }}>100% of subscription revenue plants trees</div>
            <h1>Sign it digitally.<br /><em>Leave the tree standing.</em></h1>
            <p className="lead">Treegens Sign does what you expect from an e-signature tool: send, sign, track and store agreements. The difference is where the money goes. Every cent of subscription revenue funds Treegens tree planting.</p>
            <div className="row wrap">
              <Link href="/signup" className="btn primary lg">Start free</Link>
              <Link href="/impact" className="btn lg">See the impact</Link>
            </div>
            <p className="muted small" style={{ marginTop: 14 }}>Free for {PLANS.seedling.envelopesPerMonth} envelopes a month. Signers never need an account.</p>
          </div>
          <div aria-hidden="true">
            <div className="doc-art">
              <div className="ln" style={{ width: '55%', height: 14, background: '#d9d3c4' }} />
              <div className="ln" /><div className="ln" style={{ width: '92%' }} /><div className="ln" style={{ width: '97%' }} /><div className="ln" style={{ width: '70%' }} />
              <div className="ln" style={{ marginTop: 22 }} /><div className="ln" style={{ width: '88%' }} /><div className="ln" style={{ width: '60%' }} />
              <div className="row between" style={{ marginTop: 30, alignItems: 'flex-end' }}>
                <div>
                  <div style={{ fontFamily: "'Sig Dancing', cursive", fontSize: 34, color: '#10243a', lineHeight: 1 }}>Wangari M.</div>
                  <div style={{ borderTop: '1.5px solid #17241c', width: 190, marginTop: 4 }} />
                  <div className="muted small">Signed via Treegens Sign</div>
                </div>
                <div style={{ background: 'var(--green-soft)', borderRadius: 12, padding: '10px 14px', textAlign: 'center' }}>
                  <Leaf color="#1f6f43" size={22} />
                  <div className="small" style={{ fontWeight: 700, color: 'var(--green-deep)' }}>6 sheets saved</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="band">
          <div className="wrap">
            <h2>Paper has a cost. So we count it.</h2>
            <p style={{ maxWidth: 640, margin: '8px 0 24px', color: '#c5dbc9' }}>
              One tree makes roughly {fmtNum(IMPACT.sheetsPerTree)} sheets of office paper, and each sheet takes about {IMPACT.litresWaterPerSheet} litres of water to produce. Everyone using Treegens Sign has so far kept this much out of the printer:
            </p>
            <div className="grid g4 keep2">
              <div className="stat"><div className="k">Sheets of paper saved</div><div className="v num">{imp ? fmtNum(imp.sheets) : '…'}</div></div>
              <div className="stat"><div className="k">Trees left standing</div><div className="v num">{imp ? fmtTrees(imp.trees) : '…'}</div></div>
              <div className="stat"><div className="k">Litres of water not used</div><div className="v num">{imp ? fmtNum(imp.litresWater) : '…'}</div></div>
              <div className="stat"><div className="k">Sent to tree planting</div><div className="v num">{imp ? `$${fmtNum(imp.donatedUsd)}` : '…'}</div><div className="s">{imp?.treesFunded != null ? `about ${fmtNum(imp.treesFunded)} trees funded` : 'all subscription revenue'}</div></div>
            </div>
            <p className="small" style={{ marginTop: 14, color: '#a8c9b0' }}>Live numbers from this service. <Link href="/impact" style={{ color: '#fff' }}>See exactly how we count</Link>.</p>
          </div>
        </section>

        <section className="wrap section">
          <h2>Everything you need to get documents signed</h2>
          <p className="muted" style={{ maxWidth: 620, marginBottom: 22 }}>No feature is locked behind a sales call.</p>
          <div className="grid g3">{FEATURES.map(([t, d]) => <div key={t} className="feat"><h3>{t}</h3><p>{d}</p></div>)}</div>
        </section>

        <section className="wrap section">
          <h2>How it compares</h2>
          <div className="card pad0" style={{ marginTop: 16 }}>
            <div className="tablewrap"><table className="t cmp">
              <thead><tr><th /><th>Treegens Sign</th><th>Typical e-signature tools</th></tr></thead>
              <tbody>{COMPARE.map(([k, a, b]) => <tr key={k}><td>{k}</td><td style={{ color: 'var(--green-deep)', fontWeight: 600 }}>{a}</td><td className="muted">{b}</td></tr>)}</tbody>
            </table></div>
          </div>
        </section>

        <section className="wrap section">
          <h2>Simple pricing that plants trees</h2>
          <div className="grid g2" style={{ marginTop: 16, maxWidth: 820 }}>
            {(['seedling', 'grove'] as const).map((id) => (
              <div key={id} className="card" style={id === 'grove' ? { borderColor: 'var(--green)', boxShadow: '0 0 0 1px var(--green)' } : undefined}>
                <h3 style={{ fontSize: 18 }}>{PLANS[id].name}</h3>
                <div className="serif" style={{ fontSize: 38, fontWeight: 700 }}>${PLANS[id].price}<span className="muted" style={{ fontSize: 15, fontWeight: 400 }}> / month</span></div>
                <p className="muted">{PLANS[id].blurb}</p>
                <ul style={{ paddingLeft: 18, lineHeight: 1.8 }}>
                  <li>{id === 'grove' ? 'Unlimited envelopes' : `${PLANS.seedling.envelopesPerMonth} envelopes a month`}</li>
                  <li>Every feature included</li>
                  <li>{id === 'grove' ? '100% goes to Treegens tree planting' : 'Free forever'}</li>
                </ul>
                <Link href="/signup" className={`btn ${id === 'grove' ? 'primary' : ''}`}>{id === 'grove' ? 'Start free, upgrade any time' : 'Start free'}</Link>
              </div>
            ))}
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
