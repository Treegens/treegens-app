'use client'

import { Button } from '@/components/ui/Button'
import type { SiteDraft } from '@/utils/siteDraftStore'
import { formatTimeAgo } from '@/utils/timeAgo'

type Props = {
  draft: SiteDraft
  onResume: () => void
  onDiscard: () => void
}

/** Offers the unsent site kept on this phone. */
export function ResumeDraftBanner({ draft, onResume, onDiscard }: Props) {
  return (
    <section className="mb-5 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3">
      <p className="text-sm font-semibold text-sky-950">
        You have an unfinished site on this phone
      </p>
      <p className="mt-1 text-sm text-sky-900/90">
        {draft.name?.trim() || 'No name yet'}
        {draft.updatedAt ? ` · saved ${formatTimeAgo(draft.updatedAt)}` : ''}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button color="success" className="rounded-xl py-3" onClick={onResume}>
          Resume draft
        </Button>
        <Button
          outline
          color="gray"
          className="rounded-xl py-3"
          onClick={onDiscard}
        >
          Start over
        </Button>
      </div>
    </section>
  )
}
