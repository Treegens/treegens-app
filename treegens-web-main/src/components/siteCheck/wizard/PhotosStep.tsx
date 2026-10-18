'use client'

import { HiInformationCircle } from 'react-icons/hi2'
import { PhotoSlot } from '@/components/siteCheck/PhotoSlot'
import { PHOTO_SLOTS, PHOTO_TEXT } from '@/modules/siteCheck/questions'
import type { PendingPhotos } from '@/modules/siteCheck/sendSite'
import type { ISitePhoto, SitePhotoKind } from '@/types'
import { StepNav } from './StepNav'

type Props = {
  pending: PendingPhotos
  /** Photos already on a saved draft */
  saved: ISitePhoto[]
  onPick: (kind: SitePhotoKind, file: File) => void
  onRemove: (kind: SitePhotoKind) => void
  onBack: () => void
  onNext: () => void
}

/** Step 3: two required photos and two optional ones. */
export function PhotosStep({
  pending,
  saved,
  onPick,
  onRemove,
  onBack,
  onNext,
}: Props) {
  return (
    <div className="flex flex-col gap-5">
      <p className="flex flex-row gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-950">
        <HiInformationCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        {PHOTO_TEXT.notSavedOffline}
      </p>
      {PHOTO_SLOTS.map(slot => {
        const photo = pending[slot.kind]
        return (
          <PhotoSlot
            key={slot.kind}
            title={slot.title}
            help={slot.help}
            required={slot.required}
            previewUrl={
              photo?.previewUrl ??
              saved.find(p => p.kind === slot.kind)?.publicUrl
            }
            onPick={file => onPick(slot.kind, file)}
            onRemove={photo ? () => onRemove(slot.kind) : undefined}
          />
        )
      })}
      <StepNav onBack={onBack} onNext={onNext} />
    </div>
  )
}
