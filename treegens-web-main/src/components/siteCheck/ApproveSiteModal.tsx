'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

type Props = {
  isOpen: boolean
  onClose: () => void
  onApprove: (payload: { reasons: string[] }) => void
}

const APPROVE_INSTRUCTIONS = [
  { id: 1, title: 'Photos look like this place and match the answers' },
  { id: 2, title: 'Tide answers fit the photos and the satellite result' },
]

export function ApproveSiteModal({ isOpen, onClose, onApprove }: Props) {
  const [note, setNote] = useState('')

  const handleApprove = () => {
    onApprove({ reasons: note.trim() ? [note.trim()] : [] })
    setNote('')
  }

  return (
    <Modal open={isOpen} onClose={onClose} title="Approve site">
      <div className="flex flex-col gap-4">
        <h4 className="text-sm text-gray-900">
          By approving this site, you confirm that:
        </h4>
        <div className="flex flex-col gap-2">
          {APPROVE_INSTRUCTIONS.map(item => (
            <div key={item.id} className="flex items-start gap-2">
              <span aria-hidden className="mt-[2px] text-sm text-gray-900">
                •
              </span>
              <p className="text-sm font-semibold text-gray-900">
                {item.title}
              </p>
            </div>
          ))}
        </div>
        <textarea
          placeholder="Add an optional note"
          rows={4}
          className="rounded-lg border border-gray-300 bg-gray-50 p-2 text-sm text-gray-900 placeholder:text-gray-500"
          value={note}
          onChange={e => setNote(e.target.value)}
        />
        <Button onClick={handleApprove} outline color="green">
          Approve
        </Button>
      </div>
    </Modal>
  )
}
