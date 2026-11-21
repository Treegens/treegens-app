import fs from 'node:fs';
import path from 'node:path';
import { outsideServices, outsideMode, outsidePolicy, switchedOff, NOT_BUILT } from '@/lib/outside';
import { PRODUCT } from '@/lib/site';

// "What this server connects to", for /security. Every row comes from src/lib/outside.ts, which reads the settings the
// server runs on, the same list the server logs when it starts and holds itself to under OUTSIDE_CALLS. Two facts are
// kept apart on purpose: what the settings tell the software to connect to, and what the network around the server
// allows. The software knows the first. The second is set by whoever runs the server, and this page cannot see it.

export function WhatItConnectsTo() {
  const { mode } = outsideMode();
  const p = outsidePolicy();
  const off = switchedOff();
  const services = outsideServices();
  const offWhy = (id: string) => off.find((s) => s.id === id);
  // Made by scripts/sbom.mjs when the server is built; a server run from source without a build has none.
  const sbom = fs.existsSync(path.join(/* turbopackIgnore: true */ process.cwd(), 'public', 'security', 'sbom.json'));
  const guard = mode === 'all'
    ? 'Off. Nothing inside the software stops a connection to a host that is not listed here. Only the network around the server can.'
    : mode === 'listed'
      ? `On. The software refuses to connect to any host that is not in this list${p.extra.length ? ` or one the operator added (${p.extra.join(', ')})` : ''}, before anything is sent.`
      : `On, for a closed network. The software connects only to the mail relay${p.extra.length ? ` and to hosts the operator added (${p.extra.join(', ')})` : ''}. Every service below that would need another host is switched off.`;
  return (
    <section className="card pub-trust" id="outside" aria-labelledby="outside-h">
      <h2 id="outside-h">What this server connects to</h2>
      <p className="muted">Every outside service {PRODUCT} can call, and whether the settings of this server switch it on. Two separate facts follow: what the software is configured to connect to, and what the network is allowed to reach.</p>
      <table className="pub-data">
        <caption>Configured to connect to</caption>
        <thead><tr><th scope="col">Service</th><th scope="col">On this server</th><th scope="col">Connects to</th><th scope="col">What for</th></tr></thead>
        <tbody>
          {services.map((s) => {
            const why = offWhy(s.id);
            return (
              <tr key={s.id}>
                <th scope="row">{s.name}</th>
                <td data-label="On this server">{s.on ? 'On' : why ? 'Switched off: this server makes no outside calls' : 'Off'}</td>
                <td data-label="Connects to">{s.on ? (s.hosts.length ? s.hosts.join(', ') : s.hostWords || 'Not known before a call') : 'Nothing'}</td>
                <td data-label="What for">{s.purpose}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ul className="pub-points" style={{ marginTop: 14 }}>
        <li><b>The software&apos;s own guard.</b><span>{guard} It is a second line of defence: it checks connections the server opens itself, not what a program it starts does (such as LibreOffice for office files).</span></li>
        <li><b>Allowed by the network.</b><span>That is decided outside the software, by a firewall or a network policy of whoever runs this server, and this page cannot see it. Ask them what the network lets this server reach.</span></li>
        <li><b>Not in the software, so never called.</b><span>{NOT_BUILT.map((x) => x[0].toUpperCase() + x.slice(1)).join('. ')}.</span></li>
        {sbom && <li><b>What it is built from.</b><span>Every package this server was built with, with its version and licence, as a <a href="/security/sbom.json">software bill of materials</a> (CycloneDX, made by npm when the server was built) and as a <a href="/security/third-party-licences.txt">plain list of licences</a>.</span></li>}
      </ul>
    </section>
  );
}
