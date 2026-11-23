'use client';
import { SentHead } from '@/components/impact/SenderTrees';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../ui';
import { useMe } from '../AppShell';
import { joinNames } from './lib';
import { ownLink } from './OwnLink';
import { sentForAfter } from '@/lib/shares';
import { ShareLinkLine, ShareLinkDialog } from './ShareLink';

// Shown once, on the page a sender lands on right after sending (the editor sends them here with ?sent=1). Someone
// waiting for a signature on their phone hears nothing until the end unless they found the setting, so the one
// switch that matters is offered here, at the moment it matters. It sets the same preference as Settings,
// Notifications ("Each time someone signs"), for all of this person's envelopes. Nothing here is a second setting.
// `sentFor`: the colleague this person just sent it for (src/server/shares.ts). The emails about it go to them, so this
// card says so, and offers no switch of this person's own.
// The line under the first paragraph offers the document's readable address, growsigning.com/<name>, for a chat or
// a QR code next to the emails that already went out (sender/ShareLink.tsx, the same dialog as "Share link" in More).
export function AfterSend({ envelope, sentFor }: { envelope: any; sentFor?: string }) {
  const me = useMe();
  const [show, setShow] = useState(false);
  const [on, setOn] = useState(!!me.user.notify?.signed);
  const [said, setSaid] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  // The share link as this card last heard of it: from the page, or from its own dialog a moment ago.
  const [sharing, setSharing] = useState(false);
  const [link, setLink] = useState<any>(envelope.share_link || null);
  useEffect(() => setLink(envelope.share_link || null), [envelope.share_link?.name, envelope.share_link?.active]);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('sent') !== '1') return;
    setShow(true);
    // Taken out of the address, so going back to this page later does not say "Sent" again.
    q.delete('sent');
    window.history.replaceState(null, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
  }, []);
  if (!show || envelope.status !== 'sent') return null;

  // The people whose finishing is news: everyone who signs, approves or has to view. An email "as each person signs"
  // only differs from the one at the end when there is more than one of them.
  const acting: any[] = envelope.recipients.filter((r: any) => r.role !== 'cc');
  // Whose link the sender said they would send, and whose turn it is now. The others are told about when it comes.
  const own = acting.filter((r: any) => ownLink(r) && r.status === 'sent');
  const flip = () => {
    const next = !on;
    setOn(next);
    setBusy(true);
    setSaid(null);
    api('/me', { method: 'PATCH', body: { notify: { signed: next } } })
      .then(() => (me.reload(), setSaid({ text: next ? 'Saved. You get an email as each person finishes, for this document and the ones you send from now on.' : 'Saved. No email for each signature.' })))
      .catch((e: any) => (setOn(!next), setSaid({ text: `${e?.status ? e.message : 'We could not reach the server.'} The setting was not changed. Try the switch again.`, err: true })))
      .finally(() => setBusy(false));
  };
  return (
    <section className="card sn-sent" aria-labelledby="sn-sent-h">
      {/* "Sent.", and the first time an account sends anything, the picture and its words (impact/SenderTrees.tsx). */}
      <SentHead envelopeId={envelope.id} id="sn-sent-h" />
      <p className="muted">
        {sentFor ? sentForAfter(sentFor, acting.length === 1 ? `${acting[0].name} has` : 'everyone has')
          : me.user.notify?.completed !== false
          ? <>We email you at {me.user.email} when {acting.length === 1 ? `${acting[0].name} has` : 'everyone has'} finished.</>
          : <>You have switched off the email that tells you when everyone has finished. You can switch it back on under <Link href="/app/settings?tab=notifications">Settings, Profile</Link>.</>}
      </p>
      {!sentFor && <ShareLinkLine envelope={{ ...envelope, share_link: link }} onOpen={() => setSharing(true)} />}
      {sharing && <ShareLinkDialog kind="envelope" id={envelope.id} onClose={() => setSharing(false)} onChanged={setLink} />}
      {/* People with no address, whose link the sender said they would send: nobody else will (OwnLink.tsx). */}
      {own.length > 0 && sentFor && <p className="sn-hint warn"><b>Tell {sentFor} to send {joinNames(own.map((r: any) => r.name))} the link.</b> Only {sentFor} or an admin can. We do not write to them.</p>}
      {own.length > 0 && !sentFor && <p className="sn-hint warn"><b>Now send {joinNames(own.map((r: any) => r.name))} the link yourself.</b> It is next to {own.length === 1 ? 'their name' : 'each of their names'} below. We do not write to them.</p>}
      {acting.length > 1 && !sentFor && (
        <>
          <label className="setting-row sn-switch">
            <input type="checkbox" role="switch" checked={on} disabled={busy} onChange={flip} aria-describedby="sn-sent-hint" />
            <span>
              <b>Email me each time someone signs</b>
              <span id="sn-sent-hint" className="muted small" style={{ display: 'block' }}>One email as each of {joinNames(acting.map((r: any) => r.name))} finishes, not only at the end. This is your setting for every document you send, the same one as under Settings, Notifications.</span>
            </span>
          </label>
          {said && <p className={`small${said.err ? ' sn-bad' : ' muted'}`} role={said.err ? 'alert' : 'status'} style={{ margin: '4px 0 0' }}>{said.text}</p>}
        </>
      )}
    </section>
  );
}
