'use client';
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../ui';
import { MAX_PHOTOS_PER_DOCUMENT, PHOTO_MAX_SIDE } from '@/lib/policy';
import { isPicture } from './photos';
import { plural } from './shared';

// Several pictures chosen at once are most often the pages of one paper document, photographed one after the other.
// Uploaded as they are they would become that many one-page documents. So the sender is asked once: one document,
// or separate ones. The order is the order they were chosen in, shown here with a small picture of each page, and
// it can be changed before anything is uploaded. Small pictures are only drawn for a handful: a phone that has to
// open fifty camera photos at once runs out of memory.
const THUMBS_UP_TO = 12;

export function PhotoAsk({ files, onPick, onClose }: { files: File[]; onPick: (files: File[], oneDocument: boolean) => void; onClose: () => void }) {
  const [pics, setPics] = useState<File[]>(() => files.filter(isPicture));
  const others = useMemo(() => files.filter((f) => !isPicture(f)), [files]);
  const urls = useMemo(() => (pics.length <= THUMBS_UP_TO ? new Map(files.filter(isPicture).map((f) => [f, URL.createObjectURL(f)])) : new Map<File, string>()), [files]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const [said, setSaid] = useState('');
  const n = pics.length;
  const tooMany = n > MAX_PHOTOS_PER_DOCUMENT;
  const move = (i: number, by: number) => {
    const next = [...pics];
    const [x] = next.splice(i, 1);
    next.splice(i + by, 0, x);
    setPics(next);
    // Said out loud for someone who cannot see the row jump.
    setSaid(`${x.name} is now page ${i + by + 1} of ${n}.`);
  };
  // The other files keep their place before or after the pictures, as they were chosen.
  const ordered = () => {
    const first = files.findIndex(isPicture);
    return [...files.slice(0, first).filter((f) => !isPicture(f)), ...pics, ...files.slice(first).filter((f) => !isPicture(f))];
  };
  return (
    <Modal title={`You chose ${n} pictures. Is this one document?`} onClose={onClose}>
      <p className="muted">If these are the pages of one paper document, we make one document from them, a page for each picture, in this order. If they are different documents, keep them apart.</p>
      <ol className="ed-photos" aria-label="Pictures, in page order">
        {pics.map((f, i) => (
          <li key={files.indexOf(f)}>
            <span className="num muted" aria-hidden="true">{i + 1}</span>
            {urls.get(f) && <img src={urls.get(f)} alt="" loading="lazy" decoding="async" />}
            <span className="truncate grow">{f.name}</span>
            <button type="button" className="btn sm ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${f.name} up, to page ${i}`}>↑</button>
            <button type="button" className="btn sm ghost" disabled={i === n - 1} onClick={() => move(i, 1)} aria-label={`Move ${f.name} down, to page ${i + 2}`}>↓</button>
          </li>
        ))}
      </ol>
      <div className="ed-sr" role="status" aria-live="polite">{said}</div>
      {others.length > 0 && <p className="muted small">{others.length === 1 ? `${others[0].name} is not a picture and is added as a document of its own.` : `The ${others.length} files that are not pictures are added as documents of their own.`}</p>}
      {tooMany && <p className="notice warn small" role="alert">One document can be made from up to {MAX_PHOTOS_PER_DOCUMENT} pictures. Cancel and choose fewer at a time.</p>}
      <p className="muted small">Pictures larger than a page needs are made smaller before they are uploaded (the long side becomes {PHOTO_MAX_SIDE.toLocaleString('en')} pixels), so the document opens quickly on a phone. Nothing is uploaded until you choose.</p>
      <div className="actions ed-photo-actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" onClick={() => onPick(ordered(), false)}>Keep them as {plural(n, 'document')}</button>
        <button type="button" className="btn primary" autoFocus disabled={tooMany} onClick={() => onPick(ordered(), true)}>Make one document, {plural(n, 'page')}</button>
      </div>
    </Modal>
  );
}
