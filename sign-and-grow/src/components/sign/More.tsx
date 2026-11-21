'use client';
import { Dialog } from '@/components/sign/Dialog';
import { ZoomControl } from '@/components/sign/Zoom';
import { Icon } from '@/components/sign/parts';

// The toolbar's More on the signing page (research/ux-charter.md, 2.6): how the document is shown, the size of its
// pages, and its download. They used to stand in a row above the document and took the top of a phone screen.
// Never more than six lines (tests/ux/flows.cjs counts them): two views, three sizes, one download. The dialog's
// own Close is the way back, so there is no seventh. Questions and
// comments is in Other actions, once (src/components/sign/actions.ts).

/** The button. `data-more="screen"` marks it as this screen's one More, closed until it is pressed. */
export function MoreButton({ open, onOpen, className = 'btn sm sg-morebtn' }: { open: boolean; onOpen: () => void; className?: string }) {
  return <button type="button" className={className} data-more="screen" aria-haspopup="dialog" aria-expanded={open} onClick={onOpen}>More</button>;
}

export function MoreDialog({ view, onView, zoom, onZoom, downloadUrl, onClose }: {
  view: 'doc' | 'text';
  onView: (v: 'doc' | 'text') => void;
  zoom: number;
  onZoom: (z: number) => void;
  downloadUrl: string;
  onClose: () => void;
}) {
  return (
    <Dialog title="More" onClose={onClose}>
      <div className="sg-moredlg">
        <div role="group" aria-labelledby="sg-more-view">
          <h3 id="sg-more-view">How to read the document</h3>
          <div className="sg-seg">
            <button type="button" aria-pressed={view === 'doc'} onClick={() => (onView('doc'), onClose())}>Pages</button>
            <button type="button" aria-pressed={view === 'text'} onClick={() => (onView('text'), onClose())}>Text view</button>
          </div>
          <p className="muted small">Text view shows the same document as plain text, with your fields as an ordinary form.</p>
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
