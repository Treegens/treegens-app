'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { SiteFlowHeader } from '@/components/siteCheck/SiteFlowHeader'
import { LocationStep } from '@/components/siteCheck/wizard/LocationStep'
import { PhotosStep } from '@/components/siteCheck/wizard/PhotosStep'
import { QuestionsStep } from '@/components/siteCheck/wizard/QuestionsStep'
import { ResumeDraftBanner } from '@/components/siteCheck/wizard/ResumeDraftBanner'
import { ReviewStep } from '@/components/siteCheck/wizard/ReviewStep'
import { WizardProgress } from '@/components/siteCheck/wizard/WizardProgress'
import { Spinner } from '@/components/ui/Spinner'
import { buildSitePath, routes } from '@/config/appConfig'
import { useConnectivity } from '@/contexts/ConnectivityProvider'
import { useUser } from '@/contexts/UserProvider'
import { useGeolocation } from '@/hooks/useGeolocation'
import {
  usePendingPhotos,
  useSiteDraftSync,
  useSiteGeocode,
} from '@/hooks/useSiteWizard'
import {
  missingPhotoKinds,
  photoTitle,
  saveSite,
  uploadPendingPhotos,
} from '@/modules/siteCheck/sendSite'
import {
  draftToForm,
  EMPTY_SITE_FORM,
  formAnchor,
  hydrologySummaryOf,
  locationProblem,
  type SiteForm,
  siteToForm,
} from '@/modules/siteCheck/siteForm'
import {
  computeSiteVerdict,
  missingAnswers,
} from '@/modules/siteCheck/siteVerdict'
import { getSite, submitSite } from '@/services/siteService'
import type { ISiteDoc, SitePhotoKind } from '@/types'
import { apiErrorMessage } from '@/utils/apiErrorMessage'
import { clearSiteDraft } from '@/utils/siteDraftStore'

/** Loads the draft named by ?siteId= into the form. */
function useEditedSite(siteId: string, onLoaded: (site: ISiteDoc) => void) {
  const [loading, setLoading] = useState(Boolean(siteId))
  const [error, setError] = useState('')
  useEffect(() => {
    if (!siteId) return
    let cancelled = false
    ;(async () => {
      try {
        const { data } = await getSite(siteId)
        if (!cancelled) onLoaded(data.data)
      } catch (e) {
        if (!cancelled)
          setError(apiErrorMessage(e, 'Could not load this site.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [siteId])
  return { loading, error }
}

export default function CreateSitePage() {
  const router = useRouter()
  const editSiteId = useSearchParams().get('siteId') ?? ''
  const { user } = useUser()
  const wallet = user?.walletAddress ?? ''
  const { isUserOnline } = useConnectivity()
  const topRef = useRef<HTMLDivElement>(null)

  const [step, setStep] = useState(1)
  const [form, setForm] = useState<SiteForm>(EMPTY_SITE_FORM)
  const [savedSite, setSavedSite] = useState<ISiteDoc | null>(null)
  const [sending, setSending] = useState(false)
  const [stage, setStage] = useState('')
  const [sendError, setSendError] = useState('')

  const photos = usePendingPhotos()
  // Once the server holds the site, the phone copy would only duplicate it.
  const draft = useSiteDraftSync(wallet, form, !editSiteId && !savedSite)
  useSiteGeocode(form, setForm, isUserOnline)
  const edited = useEditedSite(editSiteId, site => {
    setSavedSite(site)
    setForm(siteToForm(site))
  })
  const gps = useGeolocation({ enableHighAccuracy: true, maximumAge: 30000 })

  const hydrology = useMemo(
    () => hydrologySummaryOf(savedSite?.hydrology),
    [savedSite],
  )
  const verdict = useMemo(
    () =>
      computeSiteVerdict({
        answers: form.answers,
        hydrology,
        countryCode: form.countryCode,
      }),
    [form.answers, form.countryCode, hydrology],
  )

  const goTo = (next: number) => {
    setStep(next)
    topRef.current?.scrollIntoView({ block: 'start' })
    if (next === 3) gps.getCurrentPosition()
  }

  const resumeDraft = () => {
    if (!draft.offer) return
    const resumed = draftToForm(draft.offer)
    setForm(resumed)
    draft.dismiss()
    setStep(locationProblem(resumed) ? 1 : 2)
  }

  const pickPhoto = (kind: SitePhotoKind, file: File) => {
    const here =
      gps.latitude !== null && gps.longitude !== null
        ? { latitude: gps.latitude, longitude: gps.longitude }
        : formAnchor(form)
    photos.pick(kind, file, here)
  }

  const send = async (forReview: boolean) => {
    if (!isUserOnline || sending) return
    setSending(true)
    setSendError('')
    try {
      setStage('Saving the site…')
      const site = await saveSite(form, savedSite)
      setSavedSite(site)
      if (!editSiteId) clearSiteDraft(wallet)
      await uploadPendingPhotos(site._id, photos.pending, {
        onProgress: (kind, percent) =>
          setStage(`Sending photo: ${photoTitle(kind)} (${percent}%)`),
        onUploaded: (kind, updated) => {
          setSavedSite(updated)
          photos.remove(kind)
        },
      })
      if (forReview) {
        setStage('Sending for review…')
        await submitSite(site._id)
      }
      toast.success(forReview ? 'Site sent for review' : 'Draft saved')
      router.replace(buildSitePath(site._id))
    } catch (e) {
      console.error('Site Check send failed', e)
      setSendError(apiErrorMessage(e, 'Could not send the site. Try again.'))
    } finally {
      setSending(false)
      setStage('')
    }
  }

  const locked = savedSite != null && savedSite.status !== 'draft'
  const body = () => {
    if (edited.loading) {
      return (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      )
    }
    if (edited.error || locked) {
      return (
        <div className="mt-6 flex flex-col items-center gap-3 text-center">
          <p className="text-base text-gray-700">
            {edited.error ||
              'This site was already sent for review, so it cannot be changed.'}
          </p>
          <Link
            href={routes.Sites}
            className="font-semibold text-tree-green-2 underline"
          >
            Back to my sites
          </Link>
        </div>
      )
    }
    return (
      <>
        {draft.offer ? (
          <ResumeDraftBanner
            draft={draft.offer}
            onResume={resumeDraft}
            onDiscard={draft.discard}
          />
        ) : null}
        <WizardProgress step={step} />
        {step === 1 ? (
          <LocationStep form={form} setForm={setForm} onNext={() => goTo(2)} />
        ) : null}
        {step === 2 ? (
          <QuestionsStep
            answers={form.answers}
            countryCode={form.countryCode}
            hydrology={hydrology}
            onChange={answers => setForm(f => ({ ...f, answers }))}
            onBack={() => goTo(1)}
            onNext={() => goTo(3)}
          />
        ) : null}
        {step === 3 ? (
          <PhotosStep
            pending={photos.pending}
            saved={savedSite?.photos ?? []}
            onPick={pickPhoto}
            onRemove={photos.remove}
            onBack={() => goTo(2)}
            onNext={() => goTo(4)}
          />
        ) : null}
        {step === 4 ? (
          <ReviewStep
            form={form}
            verdict={verdict}
            missingAnswers={missingAnswers(form.answers)}
            missingPhotos={missingPhotoKinds(photos.pending, savedSite?.photos)}
            online={isUserOnline}
            sending={sending}
            stage={stage}
            error={sendError}
            onGoTo={goTo}
            onBack={() => goTo(3)}
            onSaveDraft={() => void send(false)}
            onSubmit={() => void send(true)}
          />
        ) : null}
      </>
    )
  }

  return (
    <div ref={topRef} className="relative flex min-h-screen flex-col bg-white">
      <SiteFlowHeader title={editSiteId ? 'Edit site' : 'Check a site'} />
      <div className="flex flex-1 flex-col px-5 pb-10 pt-3">{body()}</div>
    </div>
  )
}
