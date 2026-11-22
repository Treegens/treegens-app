// What the API description says about the phone's home-screen app (src/server/routes-phoneapp.ts) and the photos
// that cleaned pages are kept with (src/server/scanphotos.ts), kept apart so the busy openapi.ts needs one reference.
import { MAX_SHARED_DOCUMENTS } from '../lib/phoneapp.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };

export const phoneAppPaths = () => ({
  '/share-target': {
    post: {
      summary: 'Start a draft from files shared on a phone',
      description: `What Android calls when a person shares a PDF or photos into GrowSigning saved on their home screen (the web app manifest's share_target, which posts to /share-target, a page that passes the request on to this route). Needs a person signed in in that browser and the "send" permission; without a session it answers 401 and keeps nothing. A request whose Sec-Fetch-Site is cross-site or same-site is refused with 403. The /share-target page passes "Origin: null" on only when Sec-Fetch-Site is "none" (a share from the phone itself), and refuses it with 403 otherwise. Every "file" part is checked as an upload (POST /files): PNG and JPEG pictures shared together become one document, a page for each in the order sent, and each other file a document of its own, up to ${MAX_SHARED_DOCUMENTS} documents. A file that cannot be added refuses the whole share, naming it. On success it answers 303 to the editor of the new draft, which has no recipients yet.`,
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'array', items: { type: 'string', format: 'binary' } }, title: { type: 'string' }, text: { type: 'string' } } } } } },
      responses: { 303: { description: 'The new draft was made. Location is its editor, /app/envelopes/{id}/edit.' }, default: err },
    },
  },
  '/files/{id}/undo-cleanup': {
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    post: {
      summary: 'Make a document again from the photos its pages were cleaned from',
      description: 'An upload to POST /files can carry, next to its pictures, "scan_original_0", "scan_original_1" and so on (the photo before cleanup, as the client sends it, for each picture in order, PNG or JPEG, up to 12 MB each and 40 MB together) and "scan_cleaned" (the places of the pictures that were cleaned, from 0, with commas). The photos are then kept with the file, its answer and the document list "cleaned_pages" (counted from 1), and the evidence pack has them in scan-photos/. They are never shown to signers. If one photo is missing or is not a picture, none are kept. This route makes a new file from those photos, checked as an upload, and answers it as "file"; asked again for the same file, it answers the same new file and makes no other. GrowSigning does not check that a cleaned page was made from its photo. The document still uses the old file until the draft is saved with the new one. Refused with 409 when the photos are not all kept (or the pages were changed since), and when a document using the file was already sent.',
      responses: { 200: { description: 'The new file, as POST /files answers it.', content: { 'application/json': { schema: { type: 'object', properties: { file: { type: 'object' } } } } } }, default: err },
    },
  },
});
