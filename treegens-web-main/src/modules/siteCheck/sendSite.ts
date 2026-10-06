/**
 * Sending a Site Check from the wizard: create or update the draft, then
 * upload the photos taken on this screen one by one.
 */
import { createSite, updateSite, uploadSitePhoto } from '@/services/siteService'
import type {
  IGpsCoordinates,
  ISiteDoc,
  ISitePhoto,
  SitePhotoKind,
} from '@/types'
import { compressImage } from '@/utils/imageCompression'
import { PHOTO_SLOTS } from './questions'
import { formToInput, formToPatch, type SiteForm } from './siteForm'

export interface PendingPhoto {
  file: File
  previewUrl: string
  /** Where the planter stood when the photo was picked */
  coords: IGpsCoordinates | null
}

export type PendingPhotos = Partial<Record<SitePhotoKind, PendingPhoto>>

/** Required photo kinds that are neither taken here nor already saved. */
export function missingPhotoKinds(
  pending: PendingPhotos,
  saved: ISitePhoto[] = [],
): SitePhotoKind[] {
  return PHOTO_SLOTS.filter(
    slot =>
      slot.required &&
      !pending[slot.kind] &&
      !saved.some(p => p.kind === slot.kind),
  ).map(slot => slot.kind)
}

export function photoTitle(kind: SitePhotoKind): string {
  return PHOTO_SLOTS.find(slot => slot.kind === kind)?.title ?? kind
}

/** Creates the site, or updates the saved draft, from the form. */
export async function saveSite(
  form: SiteForm,
  saved: ISiteDoc | null,
): Promise<ISiteDoc> {
  const res = saved
    ? await updateSite(saved._id, formToPatch(form, saved))
    : await createSite(formToInput(form))
  return res.data.data
}

/** Compresses and uploads each pending photo, reporting as it goes. */
export async function uploadPendingPhotos(
  siteId: string,
  pending: PendingPhotos,
  hooks: {
    onProgress: (kind: SitePhotoKind, percent: number) => void
    onUploaded: (kind: SitePhotoKind, site: ISiteDoc) => void
  },
) {
  for (const { kind } of PHOTO_SLOTS) {
    const photo = pending[kind]
    if (!photo) continue
    hooks.onProgress(kind, 0)
    const file = await compressImage(photo.file)
    const { data } = await uploadSitePhoto(
      siteId,
      file,
      kind,
      photo.coords,
      p => hooks.onProgress(kind, p),
    )
    hooks.onUploaded(kind, data.data)
  }
}
