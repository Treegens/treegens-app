'use client'

import Link from 'next/link'
import { HiPencilSquare, HiTrash } from 'react-icons/hi2'
import { Button } from '@/components/ui/Button'
import { buildEditSitePath } from '@/config/appConfig'
import { questionFor } from '@/modules/siteCheck/answers'
import { missingPhotoKinds, photoTitle } from '@/modules/siteCheck/sendSite'
import { missingAnswers } from '@/modules/siteCheck/siteVerdict'
import type { ISiteDoc } from '@/types'

type Props = {
  site: ISiteDoc
  submitting: boolean
  onSubmit: () => void
  onDelete: () => void
}

/** What the owner can do with a draft: finish it, send it, or delete it. */
export function DraftActions({ site, submitting, onSubmit, onDelete }: Props) {
  const missing = [
    ...missingAnswers(site.answers ?? {}).map(
      key => `Answer: ${questionFor(key)?.title ?? key}`,
    ),
    ...missingPhotoKinds({}, site.photos).map(
      kind => `Photo: ${photoTitle(kind)}`,
    ),
  ]
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-gray-200 bg-[#f7fbf3] p-4">
      <p className="text-sm font-semibold text-gray-900">
        This site is a draft. Send it so verifiers can check it.
      </p>
      {missing.length ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2">
          <p className="text-sm font-semibold text-amber-950">Still needed</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-amber-950">
            {missing.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Button
        color="success"
        size="lg"
        className="w-full rounded-2xl"
        disabled={submitting || missing.length > 0}
        onClick={onSubmit}
      >
        {submitting ? 'Sending…' : 'Send for review'}
      </Button>
      <div className="grid grid-cols-2 gap-2">
        <Link
          href={buildEditSitePath(site._id)}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white text-sm font-semibold text-gray-800"
        >
          <HiPencilSquare className="h-5 w-5" aria-hidden />
          Edit answers
        </Link>
        <Button
          outline
          color="red"
          className="rounded-xl py-2.5"
          onClick={onDelete}
        >
          <HiTrash className="h-5 w-5" aria-hidden />
          Delete draft
        </Button>
      </div>
    </section>
  )
}
