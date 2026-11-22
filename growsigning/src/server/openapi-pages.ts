// What the API description says about removing, turning and moving pages (src/server/routes-pages.ts), kept apart so
// the busy openapi.ts only needs one reference to it.
import { MAX_PAGE_OPS } from '../lib/pages.ts';

const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };

/** POST /envelopes/{id}/documents/{doc}/pages */
export const PAGES_PATH = {
  parameters: [
    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'doc', in: 'path', required: true, schema: { type: 'string' }, description: 'The id of one of its documents.' },
  ],
  post: {
    summary: 'Remove, turn or move pages of one document',
    description: `For drafts and templates, and for an envelope that is out for signature. The document's file is never changed: a new file is made from it with the pages in their new order, stored and read again for search, and the document then uses it, so the certificate's SHA-256 of the document is the new file's. Fields go with their pages; a field on a turned page stays on the same words, keeps its size and stays upright. Operations are applied in order, and each names a page as it is at that moment, counted from 1: {"op":"remove","page":3}, {"op":"turn","page":2,"by":90} (90 is a quarter turn to the right, 180 upside down, 270 a quarter turn to the left) and {"op":"move","page":4,"to":1}. At most ${MAX_PAGE_OPS} in one request, and a document keeps at least one page. Removing a page that has fields is refused with 409, "code": "page_fields" and the list of those fields, unless "drop_fields" is true. On an envelope that is out this is a correction (PUT /envelopes/{id}): when someone has finished it is refused with 409, "code": "sign_again", until it is sent again with "resign": true. The audit trail gets one line, "Pages changed", such as "Page 3 removed from "Contract". "Contract" now has 2 pages, SHA-256 ...". Refused with 409 for an envelope that is completed, declined, cancelled or expired, with 403 when the envelope was started from a template whose wording is locked, and with 429 once pages were changed 120 times on one account in an hour (only changes that store a file count; a refused request does not), with how many minutes to wait. A converted document (Word and the like) keeps its original and its conversion record on the new file. Someone asked to sign again is told which pages were turned, removed or moved. With "save": false only the new file is made and nothing on the envelope changes: the answer has "file" and "plan" (for each new page, which old page it is, counted from 0, and how far it was turned), and the line is written when the envelope is saved with that file. "file_id" can then name a file made the same way and not saved yet, so changes can follow each other. Merging documents and cropping are not offered.`,
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ops'], properties: {
      ops: { type: 'array', maxItems: MAX_PAGE_OPS, items: { type: 'object', required: ['op', 'page'], properties: { op: { type: 'string', enum: ['remove', 'turn', 'move'] }, page: { type: 'integer', minimum: 1 }, by: { type: 'integer', enum: [90, 180, 270] }, to: { type: 'integer', minimum: 1 } } } },
      drop_fields: { type: 'boolean', default: false, description: 'Remove the fields on removed pages too.' },
      resign: { type: 'boolean', default: false, description: 'On an envelope that is out: ask the people who finished to sign again.' },
      edit_version: { type: 'integer', description: 'As for PUT /envelopes/{id}: refused with 409, "code": "stale", when someone saved since.' },
      save: { type: 'boolean', default: true, description: 'false: only make the new file.' },
      file_id: { type: 'string', description: 'With "save": false: start from this file, made from the document by changing pages and not saved yet.' },
    } } } } },
    responses: {
      200: { description: 'With "save": true, the envelope as it is now, with "file", "said" (the changes in words) and "removed_fields". With "save": false, "file", "plan" and "said".', content: { 'application/json': { schema: { type: 'object', properties: {
        envelope: { $ref: '#/components/schemas/Envelope' }, file: { type: 'object' }, said: { type: 'array', items: { type: 'string' } }, removed_fields: { type: 'integer' },
        plan: { type: 'array', items: { type: 'object', properties: { from: { type: 'integer' }, turn: { type: 'integer' } } } },
      } } } } },
      default: err,
    },
  },
};
