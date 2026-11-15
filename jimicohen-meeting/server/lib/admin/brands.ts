/**
 * PUT /admin/brands/:id: the owner's changes to a built-in brand (its look, its logo, its sender name),
 * stored in `site.brands`. The name and the link preview of a brand are built in and cannot be changed here.
 *
 * Like PUT /admin/site, the body is checked once against the settings as first read (images included),
 * and the same patch is then laid over the freshest settings inside the compare-and-swap.
 */
import { brandOf, BUILTIN_BRANDS, isBrandId, storedBrand, type BrandId } from '../../../shared/brands';
import type { BrandSettings, SiteSettings } from '../../../shared/types';
import type { Ctx } from '../ctx';
import { HttpError } from '../http';
import { FieldErrors, requireObject } from '../validate';
import { type AssetRef, given, readText, verifyAssets } from './fields';
import { mergeTheme, parseThemePatch, themeAssetIds, type ThemePatch } from './theme';

export const MAX_SENDER_NAME = 80;

interface BrandPatch {
  theme: ThemePatch | null;
  emailFromName: string | undefined;
}

function readBrandPatch(site: SiteSettings, id: BrandId, body: unknown, refs: AssetRef[], errors: FieldErrors): BrandPatch {
  const b = requireObject(body);
  const current = brandOf(site, { brandId: id })!;
  const theme = given(b, 'theme') ? parseThemePatch(b.theme, 'theme', themeAssetIds(current.theme), refs, errors) : null;
  const emailFromName = readText(b, 'emailFromName', 'emailFromName', MAX_SENDER_NAME, errors);
  return { theme, emailFromName };
}

/** The brand's stored entry with the patch laid over what `site` holds now. */
function patchedEntry(site: SiteSettings, id: BrandId, patch: BrandPatch, at: string): BrandSettings {
  const current = brandOf(site, { brandId: id })!;
  const stored = storedBrand(site, id);
  return {
    id,
    theme: patch.theme ? mergeTheme(current.theme, patch.theme) : current.theme,
    emailFromName: patch.emailFromName !== undefined ? patch.emailFromName : (stored?.emailFromName ?? ''),
    updatedAt: at,
  };
}

/** `site` with one brand entry replaced (or added). Entries of other ids, known or not, are kept. */
export function withBrandEntry(site: SiteSettings, entry: BrandSettings): SiteSettings {
  const list = Array.isArray(site.brands) ? site.brands : [];
  const at = list.findIndex((b) => b && b.id === entry.id);
  const brands = at === -1 ? [...list, entry] : list.map((b, i) => (i === at ? entry : b));
  return { ...site, brands };
}

/**
 * Checks a brand change against the settings as read now and returns the change as a function of the
 * settings, for repo.updateSite. Throws 404 for an id that is not built in and 422 with every bad field.
 */
export async function prepareBrandPatch(ctx: Ctx, site: SiteSettings, id: string, body: unknown): Promise<(fresh: SiteSettings) => SiteSettings> {
  if (!isBrandId(id)) throw new HttpError(404, 'not_found', 'That brand does not exist.');
  const errors = new FieldErrors();
  const refs: AssetRef[] = [];
  const patch = readBrandPatch(site, id, body, refs, errors);
  await verifyAssets(ctx, refs, errors);
  errors.throwIfAny();
  const at = ctx.now().toISOString();
  return (fresh) => withBrandEntry(fresh, patchedEntry(fresh, id, patch, at));
}

/** Every image a brand's stored look points at, for "is this upload still used". */
export function brandAssetIds(site: SiteSettings): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(site.brands) ? site.brands : []) {
    const t = entry?.theme;
    if (!t) continue;
    for (const id of [t.logoAssetId, t.coverAssetId, t.background?.imageAssetId]) if (typeof id === 'string' && id) out.push(id);
  }
  return out;
}

/** The settings with an image taken out of every brand's stored look (the image is being deleted). */
export function forgetBrandAsset(site: SiteSettings, id: string): SiteSettings {
  if (!Array.isArray(site.brands)) return site;
  const brands = site.brands.map((entry) => {
    const t = entry?.theme;
    if (!t || ![t.logoAssetId, t.coverAssetId, t.background?.imageAssetId].includes(id)) return entry;
    const theme = structuredClone(t);
    if (theme.logoAssetId === id) theme.logoAssetId = null;
    if (theme.coverAssetId === id) theme.coverAssetId = null;
    if (theme.background?.imageAssetId === id) theme.background.imageAssetId = null;
    return { ...entry, theme };
  });
  return { ...site, brands };
}

export { BUILTIN_BRANDS };
