'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { IoLeafOutline } from 'react-icons/io5'
import { DraftActions } from '@/components/siteCheck/DraftActions'
import { SiteDetailBody } from '@/components/siteCheck/SiteDetailBody'
import { SiteFlowHeader } from '@/components/siteCheck/SiteFlowHeader'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { routes } from '@/config/appConfig'
import { useUser } from '@/contexts/UserProvider'
import { useSite } from '@/hooks/useSite'
import {
  deleteSite,
  recheckSiteHydrology,
  submitSite,
  uploadSitePhoto,
} from '@/services/siteService'
import type { SitePhotoKind } from '@/types'
import { apiErrorMessage, notifyError } from '@/utils/apiErrorMessage'
import { compressImage } from '@/utils/imageCompression'

function DeleteDraftModal({
  open,
  deleting,
  onClose,
  onConfirm,
}: {
  open: boolean
  deleting: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open={open} onClose={onClose} title="Delete this draft?">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-gray-700">
          The site, its answers and photos will be removed. This cannot be
          undone.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button outline color="gray" onClick={onClose}>
            Keep it
          </Button>
          <Button color="red" disabled={deleting} onClick={onConfirm}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function PlantHereLink({ siteId }: { siteId: string }) {
  return (
    <Link
      href={`${routes.NewPlant}?siteId=${encodeURIComponent(siteId)}`}
      className="tg-cta inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-black uppercase tracking-wide text-[#16210c]"
    >
      <IoLeafOutline className="h-5 w-5" aria-hidden />
      Plant on this site
    </Link>
  )
}

export default function SiteDetailPage() {
  const params = useParams()
  const router = useRouter()
  const siteId = typeof params.id === 'string' ? params.id : ''
  const { user } = useUser()
  const { site, setSite, loading, error, reload } = useSite(siteId)
  const [refreshing, setRefreshing] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [uploading, setUploading] = useState<{
    kind: SitePhotoKind
    percent: number
  } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const wallet = user?.walletAddress?.toLowerCase() ?? ''
  const isOwner = !!site && site.userWalletAddress?.toLowerCase() === wallet
  const isDraft = site?.status === 'draft'

  const refresh = async () => {
    setRefreshing(true)
    await reload()
    setRefreshing(false)
  }

  const recheck = async () => {
    setRechecking(true)
    try {
      const { data } = await recheckSiteHydrology(siteId)
      setSite(data.data)
      toast.success('Satellite check started')
    } catch (e) {
      notifyError(apiErrorMessage(e, 'Could not start the satellite check'))
    } finally {
      setRechecking(false)
    }
  }

  const pickPhoto = async (kind: SitePhotoKind, file: File) => {
    setUploading({ kind, percent: 0 })
    try {
      const small = await compressImage(file)
      const { data } = await uploadSitePhoto(siteId, small, kind, null, p =>
        setUploading({ kind, percent: p }),
      )
      setSite(data.data)
      toast.success('Photo saved')
    } catch (e) {
      notifyError(apiErrorMessage(e, 'Photo upload failed'))
    } finally {
      setUploading(null)
    }
  }

  const sendForReview = async () => {
    setSubmitting(true)
    try {
      const { data } = await submitSite(siteId)
      setSite(data.data)
      toast.success('Site sent for review')
    } catch (e) {
      notifyError(apiErrorMessage(e, 'Could not send the site'))
    } finally {
      setSubmitting(false)
    }
  }

  const removeDraft = async () => {
    setDeleting(true)
    try {
      await deleteSite(siteId)
      toast.success('Draft deleted')
      router.replace(routes.Sites)
    } catch (e) {
      notifyError(apiErrorMessage(e, 'Could not delete the draft'))
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <SiteFlowHeader
        title="Site Check"
        onRefresh={() => void refresh()}
        refreshing={refreshing}
      />
      <main className="flex flex-col gap-4 px-5 pb-10 pt-4">
        {loading ? (
          <div className="flex justify-center py-16">
            <Spinner size="lg" />
          </div>
        ) : !site ? (
          <p className="mt-6 text-center text-base text-red-600">
            {error || 'Site not found.'}
          </p>
        ) : (
          <>
            {isOwner && isDraft ? (
              <DraftActions
                site={site}
                submitting={submitting}
                onSubmit={() => void sendForReview()}
                onDelete={() => setConfirmDelete(true)}
              />
            ) : null}
            {isOwner && site.status === 'approved' ? (
              <PlantHereLink siteId={site._id} />
            ) : null}
            <SiteDetailBody
              site={site}
              onRecheck={isOwner ? () => void recheck() : undefined}
              rechecking={rechecking}
              onPickPhoto={
                isOwner && isDraft
                  ? (kind, file) => void pickPhoto(kind, file)
                  : undefined
              }
              uploading={uploading}
            />
          </>
        )}
      </main>
      <DeleteDraftModal
        open={confirmDelete}
        deleting={deleting}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void removeDraft()}
      />
    </div>
  )
}
