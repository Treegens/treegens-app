'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

type Props = {
  isOpen: boolean
  onClose: () => void
  onReject: (payload: { reasons: string[] }) => void
}

const REJECT_SITE_LIST = [
  { id: 1, title: 'Photos do not match the answers' },
  { id: 2, title: 'Looks like seagrass or open mudflat' },
  { id: 3, title: 'Planting into healthy forest' },
  { id: 4, title: 'Photos not taken at this site' },
  { id: 5, title: 'Another reason (noted below)' },
]

export function RejectSiteModal({ isOpen, onClose, onReject }: Props) {
  const [selectedReasonIds, setSelectedReasonIds] = useState<number[]>([])
  const [note, setNote] = useState('')

  const toggleReason = (id: number) => {
    setSelectedReasonIds(prev =>
      prev.includes(id) ? prev.filter(rid => rid !== id) : [...prev, id],
    )
  }

  const noteTrim = note.trim()
  const canSubmit = selectedReasonIds.length > 0 || noteTrim.length > 0

  const handleReject = () => {
    if (!canSubmit) return
    const selected = REJECT_SITE_LIST.filter(item =>
      selectedReasonIds.includes(item.id),
    ).map(item => item.title)
    onReject({ reasons: noteTrim ? [...selected, noteTrim] : selected })
    setSelectedReasonIds([])
    setNote('')
  }

  return (
    <Modal open={isOpen} onClose={onClose} title="Reject site">
      <div className="flex flex-col gap-4">
        <h4 className="text-sm text-gray-900">
          Why are you rejecting this site?
        </h4>
        <p className="text-xs text-gray-500">
          A reason is required: choose one or more, or add a note.
        </p>
        {REJECT_SITE_LIST.map(item => (
          <div key={item.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`reject-site-${item.id}`}
              checked={selectedReasonIds.includes(item.id)}
              onChange={() => toggleReason(item.id)}
              className="h-5 w-5 rounded border-gray-300 accent-red-600 focus:ring-red-500"
            />
            <label
              className="text-sm font-semibold text-gray-900"
              htmlFor={`reject-site-${item.id}`}
            >
              {item.title}
            </label>
          </div>
        ))}
        <textarea
          placeholder="Add a note"
          rows={4}
          className="rounded-lg border border-gray-300 bg-gray-50 p-2 text-sm text-gray-900 placeholder:text-gray-500"
          value={note}
          onChange={e => setNote(e.target.value)}
        />
        <Button
          onClick={handleReject}
          outline
          color="red"
          disabled={!canSubmit}
        >
          Reject
        </Button>
      </div>
    </Modal>
  )
}
