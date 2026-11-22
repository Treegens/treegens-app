// What the API description says about ready-made templates (src/server/routes-starters.ts), kept apart so the busy
// openapi.ts only needs one reference to it.
const err = { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'The id of a ready-made template, from GET /starters.' };

export const starterPaths = () => ({
  '/starters': {
    get: {
      summary: 'List the ready-made templates',
      description: 'Starting points written by GrowSigning for a small organisation: a volunteer agreement, consents (photos and stories, sharing personal data with a partner, a child taking part, planting trees on land), a donation or gift declaration, event risks, confidentiality, grant terms and an equipment loan. They are not legal advice and none is written for a particular country. Each says so in "note", with who reviewed it and for which country once a lawyer has ("reviewed_by", "place"). "asks" are the words printed in the document that are written in when one is used (always the organisation\'s name first). "made" lists up to three templates already made from it that you may use. "organisation" is the account\'s name, or empty while it is still the name made at sign-up. Nothing is added to the account by listing them.',
      responses: { 200: { description: 'The list.', content: { 'application/json': { schema: { type: 'object', properties: {
        organisation: { type: 'string' },
        starters: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, title: { type: 'string' }, purpose: { type: 'string' }, written: { type: 'string', format: 'date' }, place: { type: 'string' },
          reviewed_by: { type: 'string', nullable: true }, note: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } },
          asks: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, label: { type: 'string' }, max: { type: 'integer' }, example: { type: 'string', nullable: true } } } },
          made: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, subject: { type: 'string' }, created_at: { type: 'string' } } } },
        } } },
      } } } } }, default: err },
    },
  },
  '/starters/{id}/preview': {
    parameters: [id],
    get: {
      summary: 'See a ready-made template as a PDF before using it',
      description: 'The PDF as it would be made, with the words given in the query (?organisation=...&partner=...). A word left out, or one that reads like the name of a well-known company or of GrowSigning, is printed as its label in brackets. Nothing is saved. At most 120 previews an hour for one person.',
      responses: { 200: { description: 'The PDF.', content: { 'application/pdf': {} } }, default: err },
    },
  },
  '/starters/{id}/use': {
    parameters: [id],
    post: {
      summary: 'Make a template from a ready-made one',
      description: 'Makes a normal template in the account: a PDF of the text with the words written in, printed with our fonts in any script, its roles (names and email addresses empty, filled in each time it is used) and its fields placed under the paragraphs they belong to. It belongs to the person who made it, and everyone on the team may use it, like any new template; it can be changed, copied and deleted like any other. The template carries "starter_id" and "starter_note", the note as it read the day it was made, and its history says it was made from a ready-made template. Every word in "asks" is required, as text, at most its "max" characters; line breaks and control characters become spaces. A word that reads like the name of a well-known company, or of GrowSigning itself, is refused with "code": "poses_as". A copy of the template keeps its "starter_id" and "starter_note". A refusal makes nothing. At most 30 an hour for one person. Sending it runs the check before sending like any document.',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: { type: 'string' }, example: { organisation: 'Green Roots Community Group' } } } } },
      responses: { 200: { description: 'The template, its note and where to edit it.', content: { 'application/json': { schema: { type: 'object', properties: {
        template: { $ref: '#/components/schemas/Envelope' }, note: { type: 'string' }, edit_url: { type: 'string' },
      } } } } }, default: err },
    },
  },
});
