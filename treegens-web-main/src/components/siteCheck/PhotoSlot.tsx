'use client'

import cn from 'classnames'
import { HiCamera } from 'react-icons/hi2'
import { MdClose } from 'react-icons/md'
import { Spinner } from '@/components/ui/Spinner'
import { PHOTO_TEXT, QUESTIONNAIRE_TEXT } from '@/modules/siteCheck/questions'

type Props = {
  title: string
  help: string
  required: boolean
  previewUrl?: string | null
  /** Upload progress in percent while this photo is being sent */
  uploadingPercent?: number | null
  onPick?: (file: File) => void
  onRemove?: () => void
}

function CaptureInput({ onPick }: { onPick: (file: File) => void }) {
  return (
    <input
      className="absolute inset-0 cursor-pointer opacity-0"
      type="file"
      accept="image/*"
      capture="environment"
      onChange={e => {
        const file = e.target.files?.[0]
        if (file) onPick(file)
        e.target.value = ''
      }}
    />
  )
}

function Preview({
  url,
  onPick,
  onRemove,
}: Pick<Props, 'onPick' | 'onRemove'> & { url: string }) {
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-gray-100 shadow-md">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" className="h-full w-full object-cover" />
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 p-1.5 shadow"
          aria-label={PHOTO_TEXT.remove}
        >
          <MdClose className="h-6 w-6 text-brown-2" />
        </button>
      ) : null}
      {onPick ? (
        <label className="absolute bottom-3 right-3 cursor-pointer rounded-full bg-white/95 px-4 py-2.5 text-sm font-semibold text-tree-green-2 shadow">
          {PHOTO_TEXT.replace}
          <CaptureInput onPick={onPick} />
        </label>
      ) : null}
    </div>
  )
}

function EmptySlot({ onPick }: Pick<Props, 'onPick'>) {
  if (!onPick) {
    return (
      <div className="flex aspect-[4/3] w-full items-center justify-center rounded-xl bg-gray-100 text-sm text-gray-500">
        {PHOTO_TEXT.none}
      </div>
    )
  }
  return (
    <label className="relative flex aspect-[4/3] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl bg-[#f7fbf3] shadow-md">
      <HiCamera
        className="pointer-events-none h-10 w-10 text-[#435f24]"
        aria-hidden
      />
      <span className="pointer-events-none text-sm font-semibold text-[#435f24]">
        {PHOTO_TEXT.add}
      </span>
      <CaptureInput onPick={onPick} />
    </label>
  )
}

/** One required or optional Site Check photo: preview, capture or upload state. */
export function PhotoSlot({
  title,
  help,
  required,
  previewUrl,
  uploadingPercent,
  onPick,
  onRemove,
}: Props) {
  const uploading = uploadingPercent != null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-row items-start justify-between gap-2">
        <p className="text-sm font-semibold text-gray-900">{title}</p>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
            required
              ? 'bg-amber-100 text-amber-900'
              : 'bg-gray-100 text-gray-600',
          )}
        >
          {required ? QUESTIONNAIRE_TEXT.required : QUESTIONNAIRE_TEXT.optional}
        </span>
      </div>
      <p className="text-xs text-gray-500">{help}</p>
      {uploading ? (
        <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-xl bg-gray-100">
          <Spinner size="md" />
          <span className="text-sm text-gray-600">{uploadingPercent}%</span>
        </div>
      ) : previewUrl ? (
        <Preview url={previewUrl} onPick={onPick} onRemove={onRemove} />
      ) : (
        <EmptySlot onPick={onPick} />
      )}
    </div>
  )
}
