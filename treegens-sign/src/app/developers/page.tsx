import { PublicNav, PublicFooter } from '@/components/Public';

export const metadata = { title: 'API reference' };

const ENDPOINTS: [string, string, string][] = [
  ['POST', '/api/files', 'Upload a PDF, PNG or JPEG (multipart field "file"). Returns the file id and page sizes.'],
  ['POST', '/api/envelopes', 'Create a draft, or create from a template with template_id. Add "send": true to send straight away.'],
  ['GET', '/api/envelopes', 'List envelopes. Filters: box (drafts, waiting, completed, closed), q, folder, kind=template.'],
  ['GET', '/api/envelopes/:id', 'Envelope with documents, recipients, fields and the audit trail.'],
  ['PUT', '/api/envelopes/:id', 'Replace a draft: documents, recipients and fields.'],
  ['POST', '/api/envelopes/:id/send', 'Send a draft.'],
  ['POST', '/api/envelopes/:id/remind', 'Remind everyone who has not finished yet.'],
  ['POST', '/api/envelopes/:id/void', 'Void with a reason.'],
  ['POST', '/api/envelopes/:id/correct', 'Change a recipient\'s name, email or access code after sending.'],
  ['POST', '/api/envelopes/:id/recipient-view', 'Get a signing URL for one recipient, for embedded signing.'],
  ['GET', '/api/envelopes/:id/download', 'The signed PDF with certificate, or a preview while in progress.'],
  ['POST', '/api/bulk', 'Send a template to many recipients at once.'],
  ['GET', '/api/reports/summary', 'Counts, completion time and paper saved.'],
  ['POST', '/api/public/verify', 'Check whether a PDF is an unmodified completed document (no key needed).'],
];

const Code = ({ children }: { children: string }) => (
  <pre style={{ background: '#17241c', color: '#e3efe5', padding: 16, borderRadius: 12, overflowX: 'auto', fontSize: 13, lineHeight: 1.55 }}><code>{children}</code></pre>
);

export default function Developers() {
  return (
    <div>
      <PublicNav />
      <main className="wrap stack" style={{ maxWidth: 860, paddingTop: 24 }}>
        <div>
          <h1 className="serif" style={{ fontSize: 38 }}>API reference</h1>
          <p className="muted" style={{ fontSize: 17, marginTop: 8 }}>Everything the app does goes through this JSON API, and it is included on every plan. Create a key under Settings, then send it as a Bearer token.</p>
        </div>

        <div className="card">
          <h2 style={{ marginBottom: 10 }}>Send a document in three calls</h2>
          <Code>{`# 1. Upload the PDF
curl -H "Authorization: Bearer $KEY" -F file=@contract.pdf https://YOUR_HOST/api/files
# => {"id":"fil_...","pages":2,...}

# 2. Create and send. Positions are fractions of the page, measured from the top left.
curl -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\
  https://YOUR_HOST/api/envelopes -d '{
    "subject": "Please sign: contract",
    "send": true,
    "documents":  [{"id": "d1", "file_id": "fil_..."}],
    "recipients": [{"id": "r1", "role": "signer", "name": "Ada Lovelace", "email": "ada@example.com"}],
    "fields":     [{"document_id": "d1", "recipient_id": "r1", "type": "signature",
                    "page": 0, "x": 0.1, "y": 0.8, "w": 0.25, "h": 0.06}]
  }'

# 3. Download the signed PDF once the envelope.completed webhook fires
curl -H "Authorization: Bearer $KEY" -o signed.pdf https://YOUR_HOST/api/envelopes/env_.../download`}</Code>
          <p className="muted small" style={{ marginBottom: 0 }}>Recipient roles: signer, approver, viewer, cc, inperson. Field types: signature, initials, date_signed, full_name, email, text, number, date, company, title, checkbox, radio, dropdown, attachment, note.</p>
        </div>

        <div className="card pad0">
          <div className="tablewrap"><table className="t">
            <thead><tr><th>Method</th><th>Path</th><th>What it does</th></tr></thead>
            <tbody>{ENDPOINTS.map(([m, p, d]) => <tr key={m + p}><td><span className="badge">{m}</span></td><td className="mono">{p}</td><td>{d}</td></tr>)}</tbody>
          </table></div>
        </div>

        <div className="card">
          <h2 style={{ marginBottom: 10 }}>Webhooks</h2>
          <p>Add a URL under Settings. We POST JSON for these events: <span className="mono">envelope.sent, envelope.completed, envelope.declined, envelope.voided, envelope.expired, recipient.viewed, recipient.completed</span>. Failed deliveries are retried twice.</p>
          <Code>{`// Verify a delivery (Node.js)
const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET)
  .update(req.headers["x-treegens-sign-timestamp"] + "." + rawBody).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-treegens-sign-signature"]));`}</Code>
        </div>

        <div className="card">
          <h2 style={{ marginBottom: 10 }}>Embedded signing</h2>
          <p style={{ marginBottom: 0 }}>Call <span className="mono">POST /api/envelopes/:id/recipient-view</span> with a <span className="mono">recipient_id</span> to get a signing URL, then send your user there from your own app. Treat the URL like a password: whoever holds it can sign as that recipient.</p>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
