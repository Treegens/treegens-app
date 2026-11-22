'use client';
import { Dialog } from '@/components/sign/Dialog';
import { ZoomControl } from '@/components/sign/Zoom';
import { Icon } from '@/components/sign/parts';
import { useT } from '@/components/sign/lang';

// The toolbar's View on the signing page (it was called More, and a signer looking for Decline opened it: the one
// menu of actions is Other actions, so this one is named for what it holds) (research/ux-charter.md, 2.6): how the document is shown, the size of its
// pages, and its download. They used to stand in a row above the document and took the top of a phone screen.
// Never more than six lines (tests/ux/flows.cjs counts them): two views, three sizes, one download. The dialog's
// own Close is the way back, so there is no seventh. Questions and
// comments is in Other actions, once (src/components/sign/actions.ts).

/** The button. `data-more="screen"` marks it as this screen's one More, closed until it is pressed. */
export function MoreButton({ open, onOpen, className = 'btn sm sg-morebtn' }: { open: boolean; onOpen: () => void; className?: string }) {
  return <button type="button" className={className} data-more="screen" aria-haspopup="dialog" aria-expanded={open} onClick={onOpen}>View</button>;
}

export function MoreDialog({ view, onView, zoom, onZoom, downloadUrl, onClose }: {
  view: 'doc' | 'text';
  onView: (v: 'doc' | 'text') => void;
  zoom: number;
  onZoom: (z: number) => void;
  downloadUrl: string;
  onClose: () => void;
}) {
  const T = useT();
  return (
    <Dialog title="How the document looks" onClose={onClose}>
      <div className="sg-moredlg">
        <div role="group" aria-labelledby="sg-more-view">
          <h3 id="sg-more-view">{T('sign.read.title')}</h3>
          <div className="sg-seg">
            <button type="button" aria-pressed={view === 'doc'} onClick={() => (onView('doc'), onClose())}>{T('sign.read.page')}</button>
            <button type="button" aria-pressed={view === 'text'} onClick={() => (onView('text'), onClose())}>{T('sign.read.easy')}</button>
          </div>
          <p className="muted small">{T('sign.read.about')}</p>
        </div>
        {view === 'doc' && (
          <div>
            <h3 id="sg-more-size">Size of the pages</h3>
            <ZoomControl zoom={zoom} onZoom={(z) => (onClose(), onZoom(z))} />
          </div>
        )}
        <a className="btn" href={downloadUrl}><Icon name="download" /> Download the document</a>
      </div>
    </Dialog>
  );
}
