# DocuSign fixtures (made by hand, not real exports)

These files are **fixtures written from DocuSign's documented layouts**, for
`tests/gov-g19.test.ts` and `src/server/importer-docusign.ts`. They are not
downloads from a real DocuSign account. The owner is to provide sample exports
from a test account (research/government.json, G19, "needs_from_operator"); the
importer must then be checked against those, and these fixtures replaced or kept
beside them.

- `envelopes.csv`: the envelope report export, one row per recipient, with the
  column names DocuSign's envelope report uses ("Envelope ID", "Subject",
  "Status", "Sender Name", "Sender Email", "Sent On", "Completed On",
  "Recipient Name", "Recipient Email", "Recipient Status").
- `template-volunteer.json`: a template download (envelopeTemplate JSON) with
  its document in `documentBase64` and tabs in `recipients.signers[].tabs`,
  positioned in points from the top left of the page. It holds tabs we map and
  tabs we do not (a formula, an approve button) and a recipient kind we do not
  have (an editor).
- The "combined documents with certificate" PDF is made by the test itself with
  pdf-lib: the document pages with "Docusign Envelope ID: <GUID>" at the top, then
  a "Certificate Of Completion" page with "Envelope Id", "Subject" and "Status".
