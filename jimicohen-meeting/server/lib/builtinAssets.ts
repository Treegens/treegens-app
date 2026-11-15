/**
 * Images that ship with the app but are served by the asset route (GET /meeting/api/assets/<id>) instead
 * of as static files. Static files reached through jimicohen.com carry Cross-Origin-Resource-Policy:
 * same-origin, which tells a webmail page that loads a picture straight from us not to show it. A function
 * response carries no such header, which is why uploaded email pictures already go through the asset route.
 *
 * The ids are not storage ids that can ever be uploaded (those start with "ast_"), and nothing is stored.
 * tests/unit/brands.test.ts checks that these bytes equal the file in public/.
 */

/** public/brand/eco-champions/email-logo.png (96 x 96), the Eco Champions logo at the top of its emails. */
const ECO_CHAMPIONS_EMAIL_LOGO_PNG =
  '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';

const BUILTIN: Record<string, { base64: string; contentType: string; file: string }> = {
  builtin_eco_champions_email: { base64: ECO_CHAMPIONS_EMAIL_LOGO_PNG, contentType: 'image/png', file: 'public/brand/eco-champions/email-logo.png' },
};

export function isBuiltinAssetId(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN, id);
}

/** The bytes and type of a built-in image, or null for any other id. */
export function builtinAsset(id: string): { data: Uint8Array; contentType: string } | null {
  if (!isBuiltinAssetId(id)) return null;
  const entry = BUILTIN[id];
  return { data: new Uint8Array(Buffer.from(entry.base64, 'base64')), contentType: entry.contentType };
}

/** For the test that ties the bytes to the files: id → path of the file in the repository. */
export const BUILTIN_ASSET_FILES: Record<string, string> = Object.fromEntries(Object.entries(BUILTIN).map(([id, e]) => [id, e.file]));
