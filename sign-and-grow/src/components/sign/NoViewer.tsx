'use client';
import { useEffect, useState } from 'react';
import { toast } from '@/components/ui';
import { Icon } from './parts';
import { CANNOT_SHOW_WAYS, SIGNING_BROWSERS } from '@/lib/mobile';
import type { ViewFailure } from '@/components/PdfDoc';
import type { ServerSaid } from '@/components/viewFailure';

// Shown in place of the pages when they cannot be shown on this device. Never a blank page and never the viewer's
// own error text: what happened, that nothing is lost, and a way forward that works from here.
export function NoViewer({ why, retry, sender, downloadUrl, onAsk, said }: { why: ViewFailure; retry: () => void; sender: string; downloadUrl: string; onAsk: () => void; said?: ServerSaid | null }) {
  const [copied, setCopied] = useState(false);
  // A document that did not arrive is fetched again by itself as soon as the device says it is back online.
  useEffect(() => {
    if (why !== 'offline') return;
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [why, retry]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      toast('Link copied. Paste it into another browser to open the document there.');
    } catch {
      toast('This browser did not let us copy. Copy the address at the top of the screen instead.', true);
    }
  }

  if (why === 'offline')
    return (
      <div className="notice warn sg-noview" role="alert">
        <b>The document did not arrive.</b> This device seems to be offline, or the signal is too weak. Nothing was signed and nothing is lost. We try again by ourselves when the connection is back.
        <div className="row wrap sg-actions"><button type="button" className="btn" onClick={retry}>Try again now</button></div>
      </div>
    );
  // The server said why it could not hand the file over: its stored copy failed its check, or it is locked with a
  // key the server was not given (src/server/filestore.ts). A download would fail the same way, so none is offered:
  // its words, a way to try again later, and the sender.
  if (why === 'file' && said)
    return (
      <div className="notice err sg-noview" role="alert" data-stored={said.code}>
        <b>The document cannot be opened at the moment.</b> {said.text} Nothing you did here is lost. You can carry on once it opens again.
        <div className="row wrap sg-actions">
          <button type="button" className="btn" onClick={retry}>Try again</button>
          <button type="button" className="btn" onClick={onAsk}><Icon name="mail" /> Ask {sender}</button>
        </div>
      </div>
    );
  if (why === 'file')
    return (
      <div className="notice err sg-noview" role="alert">
        <b>The document could not be opened here.</b> Try again in a moment. If it keeps happening, download it, or ask {sender} to check it.
        <div className="row wrap sg-actions">
          <button type="button" className="btn" onClick={retry}>Try again</button>
          <a className="btn" href={downloadUrl}><Icon name="download" /> Download PDF</a>
          <button type="button" className="btn" onClick={onAsk}><Icon name="mail" /> Ask {sender}</button>
        </div>
      </div>
    );
  return (
    <div className="notice err sg-noview" role="alert">
      <b>This browser cannot show the document.</b> Nothing is wrong with your link or with the document: this browser is too old for the page that shows it, or something it needs is switched off. You cannot sign in it, because the pages have to be on your screen before you finish.
      <ul>
        <li>{CANNOT_SHOW_WAYS[0]} <button type="button" className="sg-link" onClick={copy}>{copied ? 'Link copied' : 'Copy this link'}</button></li>
        <li>{CANNOT_SHOW_WAYS[1]} <a className="sg-link" href={downloadUrl}>Download PDF</a></li>
        <li>{CANNOT_SHOW_WAYS[2].replace('the sender', sender)} <button type="button" className="sg-link" onClick={onAsk}>Ask {sender}</button></li>
      </ul>
      <p className="small">Browsers that can show it: {SIGNING_BROWSERS}</p>
    </div>
  );
}
