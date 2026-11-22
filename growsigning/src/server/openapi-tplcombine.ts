// Several templates in one envelope ("template_ids" on POST /envelopes) and the template an upload looks like, as
// part of /api/openapi.json (tplcombine.ts, tplmatch.ts, routes-tplmatch.ts). openapi.ts spreads it into its paths.
const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema: any) => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, default: err });
const str = { type: 'string' };
const level = { type: 'object', properties: { percent: { type: 'integer', enum: [80, 90, 95], description: 'How alike, in percent, an upload must be to a template before it is offered. 80 unless an admin chose another here. There is no setting for it on a screen.' }, choices: { type: 'array', items: { type: 'integer' } } } };

/** The "template_ids" property of POST /envelopes. */
export const TEMPLATE_IDS_PROP = {
  type: 'array', minItems: 2, maxItems: 5, items: str,
  description: 'Instead of template_id: start one envelope from 2 to 5 templates. Their documents come one after the other, in this order. A role with the same name (capitals and spaces do not matter) in more than one template is one person, with every field the templates give that role; "recipients" fills roles by name as with template_id. Everything else of each template comes too. The subject is the templates\' names joined ("NDA and Photo release") unless you send one; the message is the first template\'s, or the first locked one\'s. Each template is checked for you as with template_id: one you may not use answers 403 and nothing is made. A template whose wording is locked for you keeps its own part locked (its documents, fields, fixed wording and people), and then the message and the signing order stay too; the other parts can be changed with PUT /envelopes/{id}. The parts stay locked on a copy (POST /envelopes/{id}/clone), and a person who can change the document on their turn cannot change a locked part unless that part\'s template gave them the role. A template made from it (clone with "kind": "template") is refused with 403 when one of its templates is not for everyone or is locked and you may not set its rules, or when you may no longer use one of them. Refused with 400 "code": "roles_differ", and nothing made, when one role name has two different jobs, is a group in one template and a person in another, or is a named person who differs between templates. Cannot be used with template_id, with "kind": "template", or with "anchor" and "auto_tags".',
};

const MATCH_WHAT = 'The words of the uploaded file (read when it was uploaded; a scan nobody read has none and is never matched) are compared with the documents of the templates you may use: runs of 5 words, and how many of them the two have in common out of the runs of the longer one. The best template at or above the account\'s level (PUT /account/template-match) is answered, otherwise null. Templates you may not use are never compared, so their names are never said. Nothing is changed.';

export function tplcombinePaths() {
  return {
    '/files/{id}/template-match': {
      get: {
        summary: 'The template an uploaded file looks like, if any',
        description: MATCH_WHAT,
        parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
        responses: ok({ type: 'object', properties: { match: { type: 'object', nullable: true, properties: {
          template_id: str, template: str, percent: { type: 'integer' },
          locked: { type: 'boolean', description: 'The template\'s wording is locked for you: its fields cannot go on another file (the use call answers 403). Start an envelope from the template itself instead.' },
          differences: { type: 'object', properties: { pages: { type: 'object', properties: { upload: { type: 'integer' }, template: { type: 'integer' } } }, changed_pages: { type: 'array', items: { type: 'integer' }, description: 'Pages, counted from 1, whose words differ.' }, only_in_upload: { type: 'array', items: str, description: 'Up to 8 words only in the upload.' }, only_in_template: { type: 'array', items: str, description: 'Up to 8 words only in the template.' } } },
        } } } }),
      },
    },
    '/files/{id}/template-match/use': {
      post: {
        summary: 'The template\'s people and fields, placed on this file, to add to your draft',
        description: 'Answers the template\'s people and its fields for the file, with new ids, the fields on "document_id" (the id the file has on your draft), from the template document most like the file. Fields on pages the file does not have are left out and counted in left_out. Nothing is saved: send them with PUT /envelopes/{id}. 404 for a template you may not use, 403 "code": "wording_locked" for one whose wording is locked for you.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: str }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['template_id', 'document_id'], properties: { template_id: str, document_id: str } } } } },
        responses: ok({ type: 'object', properties: { template: str, people: { type: 'array', items: { type: 'object' } }, fields: { type: 'array', items: { type: 'object' } }, left_out: { type: 'integer' } } }),
      },
    },
    '/account/template-match': {
      get: { summary: 'How alike an upload must be to a template before it is offered (admins)', responses: ok(level) },
      put: {
        summary: 'Choose how alike an upload must be to a template before it is offered (admins)',
        description: '80, 90 or 95, as a number. Anything else answers 400 and changes nothing. The change is written to the security record.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['percent'], properties: { percent: { type: 'integer', enum: [80, 90, 95] } } } } } },
        responses: ok(level),
      },
    },
  };
}
