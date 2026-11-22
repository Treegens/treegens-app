'use client';
// The SAML 2.0 part of the Single sign-on card (OrgSso.tsx), shown when "SAML 2.0" is chosen as the standard there
// (research/ux-notes.json, ds-sso-saml-scim: one card, the kind chosen inside). Our two addresses to give the
// identity provider, then its name and metadata, pasted or read from its file in this browser. The server side is
// PUT /api/account/sso/saml (src/server/routes-saml.ts, saml.ts). "Try a sign-in" and the switches stay in OrgSso.
import { useEffect, useState } from 'react';
import { CopyValue } from '@/components/settings/CopyValue';
import { api, fmtDate } from '@/components/ui';
import { SAML_METADATA_MAX } from '@/lib/samlscim';
import { useST } from '@/components/senderLang';


export type SamlCard = { entity_id: string; metadata_url: string; acs_url: string; idp: { idp_entity_id: string; sso_url: string; certificates: { ends: string }[] } | null };
type Props = { saml: SamlCard; name: string; saved: boolean; busy: boolean; act: (fn: () => Promise<any>, ok?: string) => Promise<boolean>; withCode: (b: any) => any };

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

export function OrgSaml({ saml, name: savedName, saved, busy, act, withCode }: Props) {
  const say = useST();
  const [name, setName] = useState(savedName);
  const [metadata, setMetadata] = useState('');
  const [fileProblem, setFileProblem] = useState('');
  // Bumped after a good save, so the file box empties too: the line about what is saved says the rest.
  const [fileKey, setFileKey] = useState(0);
  useEffect(() => setName(savedName), [savedName]);
  const idp = saml.idp;
  const lastEnd = idp?.certificates.map((c) => c.ends).sort().slice(-1)[0];
  const ended = !!lastEnd && lastEnd < new Date().toISOString();
  const readFile = async (f: File | undefined) => {
    setFileProblem('');
    if (!f) return;
    try {
      if (f.size > SAML_METADATA_MAX * 2) throw 0;
      const text = await f.text();
      if (!/<[\w:]*EntityDescriptor/.test(text)) throw 0;
      setMetadata(text);
    } catch {
      setFileProblem(say('saml.upload_bad'));
    }
  };

  return (
    <div className="stack" style={{ gap: 8 }} data-feature="ds-sso-saml-scim">
      <p className="small" style={{ margin: 0 }}>{say('saml.give')}</p>
      <CopyValue label={say('saml.entity_id')} value={saml.entity_id} button={say('saml.copy_entity')} />
      <CopyValue label={say('saml.acs')} value={saml.acs_url} button={say('saml.copy_acs')} />
      <p className="muted small" style={{ margin: 0 }}>{say('saml.needs')}</p>
      {idp && (
        <p className={`small${ended ? ' notice warn' : ''}`} style={{ margin: 0, overflowWrap: 'anywhere' }} role={ended ? 'status' : undefined}>
          {say('saml.signs_in_at', { host: host(idp.sso_url) })} {lastEnd ? say(ended ? 'saml.cert_ended' : 'saml.cert_ends', { day: fmtDate(lastEnd) }) : ''}
        </p>
      )}
      <form className="stack" style={{ gap: 0 }} onSubmit={(e) => {
        e.preventDefault();
        act(() => api('/account/sso/saml', { method: 'PUT', body: withCode({ name, ...(metadata.trim() ? { metadata } : saved ? {} : { metadata: '' }) }) }).then(() => { setMetadata(''); setFileKey((k) => k + 1); }), say('settings.saved_dot'));
      }}>
        <label className="f"><span>{say('sso.service.name')} <span className="hint">{say('sso.service.name_hint')}</span></span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></label>
        <label className="f"><span>{say('saml.metadata')} <span className="hint">{say(saved ? 'saml.metadata_kept' : 'saml.metadata_hint')}</span></span>
          <textarea value={metadata} onChange={(e) => setMetadata(e.target.value)} rows={4} spellCheck={false} autoCapitalize="off" required={!saved} style={{ fontFamily: 'monospace', fontSize: 13 }} />
        </label>
        <label className="f"><span>{say('saml.upload')}</span><input key={fileKey} type="file" accept=".xml,application/xml,text/xml,application/samlmetadata+xml" onChange={(e) => readFile(e.target.files?.[0])} style={{ minHeight: 44 }} /></label>
        {fileProblem && <p className="notice err small" role="alert" style={{ margin: '0 0 10px' }}>{fileProblem}</p>}
        <div><button className="btn" disabled={busy} style={{ minHeight: 44 }}>{say('sso.service.save')}</button></div>
      </form>
    </div>
  );
}
