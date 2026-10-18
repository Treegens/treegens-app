'use client'

import { PHOTO_SLOTS } from '@/modules/siteCheck/questions'
import type { ISitePhoto, SitePhotoKind } from '@/types'
import { PhotoSlot } from './PhotoSlot'

type Props = {
  photos: ISitePhoto[]
  /** Lets the owner of a draft add or replace photos */
  onPick?: (kind: SitePhotoKind, file: File) => void
  uploading?: { kind: SitePhotoKind; percent: number } | null
}

/** The site's photo slots, filled from the server record. */
export function SitePhotos({ photos, onPick, uploading }: Props) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <h3 className="mb-3 text-base font-bold text-gray-900">Photos</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {PHOTO_SLOTS.map(slot => (
          <PhotoSlot
            key={slot.kind}
            title={slot.title}
            help={slot.help}
            required={slot.required}
            previewUrl={photos.find(p => p.kind === slot.kind)?.publicUrl}
            uploadingPercent={
              uploading?.kind === slot.kind ? uploading.percent : null
            }
            onPick={onPick ? file => onPick(slot.kind, file) : undefined}
          />
        ))}
      </div>
    </section>
  )
}
