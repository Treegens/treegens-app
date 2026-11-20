import type { ReactNode } from 'react';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/Public';
import { WEBHOOK_EVENTS, MAX_WEBHOOKS, KEEP_BODIES } from '@/server/webhooks';
import { ROLES, FIELD_TYPES } from '@/server/envelopes';
import { DEFAULT_REMINDER_DAYS, PNG_MAX_PIXELS, JPEG_MAX_PIXELS } from '@/lib/policy';
import { mailEventsOn } from '@/lib/policy';

// Whether this server is told about bounces (MAIL_EVENTS_TOKEN) is a setting: read it when the page is asked for.
export const dynamic = 'force-dynamic';

export const metadata = { title: 'API reference', description: 'The Sign&Grow JSON API: the same on every plan, no go-live review. Send, correct, extend, export and get webhooks.' };

type Endpoint = [method: string, path: string, what: string, isNew?: boolean];

const GROUPS: [string, Endpoint[]][] = [
  ['Files and envelopes', [
    ['POST', '/api/files', 'Upload a PDF, PNG or JPEG as the multipart field "file", up to 25 MB and 500 pages. Returns the file id, page sizes and stored size. A phone photo is turned upright from its camera note. Repeat "file" to make one document from several pictures, a page for each, in the order sent.' + ` A PNG can have up to ${PNG_MAX_PIXELS / 1e6} million pixels and a JPEG up to ${JPEG_MAX_PIXELS / 1e6} million.`],
    ['POST', '/api/envelopes', 'Create a draft, or create from a template with template_id. Add "send": true to send straight away.'],
    ['GET', '/api/envelopes', 'List envelopes. Filters: box (drafts, sent, waiting, completed, closed), q, folder, kind=template, limit, offset.'],
    ['GET', '/api/envelopes/:id', 'One envelope with its documents, recipients and fields, the audit trail, the email delivery log and how far each signer has got.'],
    ['PUT', '/api/envelopes/:id', 'Replace a draft. On an envelope that is already out, the same call corrects it in place.', true],
    ['PATCH', '/api/envelopes/:id', 'Move to a folder.'],
    ['DELETE', '/api/envelopes/:id', 'Delete a draft, a template or a closed envelope for good. A completed envelope, or any envelope somebody has already signed, is taken out of your lists, search, export and reports, and its recipients keep their link and their copy.'],
    ['POST', '/api/envelopes/:id/send', 'Send a draft. The answer carries "warnings": what the check before sending found. The envelope has gone out either way.'],
    ['GET', '/api/envelopes/:id/warnings', 'The check before sending, to read before you send: words in the subject, a document name or the text of a document that name a kind of document which often needs paper, a witness, a notary or a qualified signature. It warns and never refuses.', true],
    ['POST', '/api/envelopes/:id/clone', 'Copy as a new draft or template. A copy of a template keeps who can use and change it, and a copy of a locked template made by someone who may not change it stays with its owner.'],
    ['GET', '/api/envelopes/:id/access', 'Who can use and change a template (everyone, admins only or chosen members; its owner and admins, chosen members as well or everyone), and whether its wording is locked. A template you may not use answers 403 with who to ask, wherever it is read or used.'],
    ['PUT', '/api/envelopes/:id/access', 'Set that rule and the chosen members. Only for the person the template belongs to and admins. Written to the template\'s history.'],
    ['GET', '/api/envelopes/:id/download', 'The signed PDF with its certificate, or a preview while signing is in progress. A voided, declined or expired envelope comes with a first page that says so and a mark across every page.'],
    ['GET', '/api/envelopes/:id/evidence', 'The evidence pack as a ZIP: the signed PDF, the certificate alone, the audit trail as text and JSON with its chain values, every stored email about it with what became of it, the consent wording and a README.'],
  ]],
  ['While an envelope is out', [
    ['POST', '/api/envelopes/:id/remind', 'Remind everyone whose turn it is. Send a recipient_id to remind one person only.', true],
    ['POST', '/api/envelopes/:id/extend', 'Push the deadline out by a number of days, or reopen an envelope that expired.', true],
    ['POST', '/api/envelopes/:id/correct', 'Fix one recipient\'s name, email or access code. A name fix keeps their link. A new email address gets a new one, and counts as a new person towards the daily limit of an account that has not paid. An access code needs at least 4 characters, and a new one unfreezes a code that was frozen after 10 wrong tries. Also takes "verify", "phone" and "text_link": see Checking who signs.'],
    ['POST', '/api/envelopes/:id/void', 'Void with a reason. Recipients see the reason.'],
    ['POST', '/api/envelopes/:id/recipient-view', 'Get one recipient\'s signing URL, for embedded signing.'],
    ['GET', '/api/envelopes/:id/comments', 'Every question and comment thread, private ones included, with who waits for an answer. Comments are not printed on the document and are not part of what is signed.'],
    ['POST', '/api/envelopes/:id/comments', 'Answer in a thread ("thread_id"), or start one: "for" is "everyone" or the id of one person, and is never guessed. The person answered is emailed, at most once every 10 minutes. The comment.created webhook fires.'],
    ['POST', '/api/envelopes/:id/comments/:thread/settle', 'Mark a thread as settled, or open it again with {"settled": false}.'],
  ]],
  ['Batches', [
    ['POST', '/api/bulk', 'Send a template to up to 500 people in one call. Returns the batch id and a result for every row.'],
    ['POST', '/api/bulk/check', 'What a list would hold before you send it: how many signatures, how many you have, how many are missing and what they cost, and whether a pause or the daily limit would refuse it. Sends nothing.', true],
    ['GET', '/api/bulk', 'List batches, with how many envelopes each created and completed.', true],
    ['GET', '/api/bulk/:id', 'One batch with every envelope and the status of every recipient.', true],
    ['POST', '/api/bulk/:id/remind', 'Remind everyone in the batch who has not finished.', true],
    ['POST', '/api/bulk/:id/void', 'Void everything in the batch that is still open, with one reason.', true],
  ]],
  ['Signing groups', [
    ['GET', '/api/groups', 'The account\'s signing groups: a name and 2 to 20 people, any one of whom can act for it. Put one on a recipient with "group_id" (signer, approver, viewer or copy). Every member gets their own email and link; the first who agrees takes it on, and it uses one signature.', true],
    ['POST', '/api/groups', 'Make a group. For admins.', true],
    ['PUT', '/api/groups/:id', 'Replace its name and members. For admins. Envelopes already sent keep the members they went out with: change those with PUT /api/envelopes/:id and "members".', true],
    ['DELETE', '/api/groups/:id', 'Delete a group. For admins. Envelopes already sent are not affected.', true],
    ['POST', '/api/envelopes/:id/recipients/:rid/release', 'Give a group\'s document back to the whole group, from the member who took it on and has not finished.', true],
  ]],
  ['Your data', [
    ['GET', '/api/export', 'One ZIP file with signed PDFs, audit trails and a CSV index. Add ?ids= for some envelopes only.', true],
    ['GET', '/api/reports/summary', 'Counts, completion time and paper saved.'],
  ]],
  ['API keys', [
    ['GET', '/api/api-keys', 'Your keys with their name, scope and last use. An admin gets every key in the account and who made it. The key itself is never returned.', true],
  ]],
  ['Webhooks (account admins; changing them needs a key with the admin scope)', [
    ['GET', '/api/webhooks', 'Your webhooks, the event names and the delivery log, newest first, 30 at a time. Add ?webhook= for one webhook, and ?before= with the next_before of the last page to go further back.'],
    ['POST', '/api/webhooks', `Add a webhook with a url and, if you like, a list of events. Leave events out to get all of them. Up to ${MAX_WEBHOOKS} per account.`],
    ['DELETE', '/api/webhooks/:id', 'Remove a webhook.'],
    ['POST', '/api/webhooks/deliveries/:id/redeliver', `Send a past delivery again, exactly as it was. Works for the latest ${KEEP_BODIES} deliveries of each webhook.`, true],
  ]],
  ['No key needed', [
    ['POST', '/api/public/verify', 'Check whether a PDF is, byte for byte, a completed document we hold. A match shows it is unchanged since signing finished, not who signed. For a completed document whose sender deleted it in the last year, "deleted" says so.'],
    ['GET', '/api/public/verify/:id', 'Look an envelope up by the ID printed on every page: status, dates, pages, signers, the fingerprint of the signed file and whether it is disputed. Never a name, an address or the title.'],
    ['POST', '/api/public/check/dispute', '"I did not sign this, or this was not me", with the security code of an email we sent. Marks the envelope as disputed; nothing is deleted.'],
    ['POST', '/api/public/check', 'Check the security code from a signing email.', true],
    ['GET', '/api/auth/providers', 'Which of Google and Microsoft people can sign in with on this server, next to email and password. Empty when the operator has set up neither. Signing in itself is for a person in a browser, never for a key.', true],
    ['GET', '/api/openapi.json', 'This API as an OpenAPI 3 description, for code generators and API clients.'],
  ]],
];

const Code = ({ label, children }: { label: string; children: string }) => (
  <pre className="pub-codeblock" tabIndex={0} role="region" aria-label={label}><code>{children}</code></pre>
);
const C = ({ children }: { children: ReactNode }) => <code className="i">{children}</code>;

export default function Developers() {
  return (
    <div className="pub">
      <PublicNav />
      <main id="main" className="wrap pub-page pub-api stack">
        <header>
          <h1 className="pub-h1">API reference</h1>
          <p className="pub-lead">Everything the app does goes through this JSON API. Create a key under Settings, then API and webhooks, and send it as a Bearer token.</p>
        </header>

        <div className="card">
          <h2>Before you start</h2>
          <ul className="pub-list">
            <li><b>The API is the same on every plan,</b> including the free one. There is no separate API plan and no feature held back for a higher tier.</li>
            <li><b>There is no go-live review.</b> A key works the moment you create it, against the real service. There is no separate test environment to move out of.</li>
            <li><b>Running out never turns into a charge.</b> A send needs one signature for each signer, the same as in the app. If the account has too few, the call returns <C>402</C> and says how many are needed and how many are left. Nothing is billed.</li>
            <li><b>The rules that keep scammers out are the same as in the app.</b> They apply to every call that emails a recipient: sending, a correction, a reminder, reopening and a bulk send. <C>403</C> means sending is paused on the account, and gives the reason. <C>422</C> means the request reads like a fake payment notice, or goes out under the name of a well-known brand, and says which words set it off. <C>429</C> means it would newly email more people than the daily limit, and says when there is room again. The last two apply until the account has a payment that is 14 days old and was not refunded or disputed, so paying does not lift them at once. A word with us lifts them sooner. While an account is paused, more time for an envelope that is out still works, and so does voiding.</li>
            <li><b>Errors are written for people.</b> Every error is JSON with an <C>error</C> that says what went wrong and what to do, and a <C>request_id</C>. The same id is in the <C>X-Request-Id</C> header of every response. Quote it when you ask for help.</li>
            <li><b>A key does everyday work, and nothing else unless you say so.</b> A new key has the <C>send</C> scope: envelopes, templates, files, contacts, bulk sends, export and reports. An admin can create a key with the <C>admin</C> scope, which also covers account settings, invitations and webhooks. No key of either scope can create or revoke keys, remove a team member, hand over or close the account, see or change the ways its creator signs in (a password link, Google or Microsoft), write, read or answer help requests, or change the plan, pay or refund. Those answer <C>403</C> and need a person signed in to the app.</li>
            <li><b>A key that cannot be used says why.</b> <C>401</C> tells you whether the header could not be read, the key is unknown or revoked, or the person who created it has left the account. While an account is being closed, or the person who created a key is closing their own login, the key answers <C>403</C> until that person signs in again. When a key stops because its creator left a team, by being removed or by closing their login, the admins of the team get an email that names it. The word <C>Bearer</C> may be in any case.</li>
            <li><b>Retries are safe.</b> Send an <C>Idempotency-Key</C> header, any text of up to 200 characters that you make up for that one call, with <C>POST /api/envelopes</C> and <C>POST /api/bulk</C>. A repeated call with the same key and the same body returns the envelope or batch the first call made instead of sending twice. A key is yours: the same text used by someone else on your team is their own key. The same key with a different body answers <C>409</C> and sends nothing. A key lasts as long as what it made: delete the envelope and the key is free again.</li>
            <li><b>Sending can come back with warnings, and never fails because of them.</b> Sign&Grow makes simple electronic signatures. Some documents often need ink on paper, a witness, a notary or a qualified signature, depending on the country: wills, trusts, powers of attorney, sales of land, and in some countries parts of an employment contract. When the subject, a document name or the text of a document names one, <C>POST /api/envelopes</C> with <C>&quot;send&quot;: true</C>, <C>POST /api/envelopes/:id/send</C> and <C>POST /api/bulk</C> answer with a <C>warnings</C> list that says which word was found and where, and the audit trail records it. Show it to whoever is sending. It is a reminder, not legal advice: <a href="/help#outside-us">what we know, country by country</a>.</li>
            <li><b>An envelope reminds people by itself unless you say otherwise.</b> A new envelope takes the account&apos;s default for <C>reminder_days</C>, which is {DEFAULT_REMINDER_DAYS} for an account made since reminders are on by default: whoever has their turn and has not finished is emailed again every {DEFAULT_REMINDER_DAYS} days, until they finish or the deadline passes. Send <C>&quot;reminder_days&quot;: 0</C> if your own system does the reminding. The account&apos;s default is <C>account.default_reminder_days</C> in <C>GET /api/me</C>.</li>
            <li>All times are ISO 8601 in UTC. A machine-readable description is at <a href="/api/openapi.json">/api/openapi.json</a>.</li>
          </ul>
        </div>

        <div className="card">
          <h2>Send a document in three calls</h2>
          <Code label="Example: send a document">{`# 1. Upload the PDF
curl -H "Authorization: Bearer $KEY" -F file=@contract.pdf https://YOUR_HOST/api/files
# => {"id":"fil_...","pages":2,...}

# 2. Create and send. Positions are fractions of the page, measured from the top left.
curl -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: contract-4471" \\
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
          <p><b>Fields may be sent without ids.</b> Each one gets its own id on the server. Documents and recipients take any short id you like, such as <C>d1</C> and <C>r1</C>, so that fields can point at them. The response carries the permanent ids.</p>
          <p className="muted small">Recipient roles: {ROLES.join(', ')}. Field types: {FIELD_TYPES.join(', ')}.</p>
        </div>

        <div className="card pad0">
          <table className="pub-ep">
            <thead><tr><th scope="col">Call</th><th scope="col">What it does</th></tr></thead>
            <tbody>
              {GROUPS.flatMap(([group, rows]) => [
                <tr key={group} className="group"><th colSpan={2} scope="colgroup">{group}</th></tr>,
                ...rows.map(([m, p, d, isNew]) => (
                  <tr key={m + p}>
                    <th scope="row" className="call"><span className="badge">{m}</span><span className="mono">{p}</span>{isNew && <span className="new">New</span>}</th>
                    <td>{d}</td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>

        <div className="card" id="correct">
          <h2>Correct an envelope that is already out</h2>
          <p><C>PUT /api/envelopes/:id</C> on a sent envelope is a correction. Nothing is voided, nobody starts again, and it does not count as another envelope. Read the envelope, change what is wrong, and send the whole thing back with the ids you were given.</p>
          <Code label="Example: correct a sent envelope">{`curl -s -H "Authorization: Bearer $KEY" https://YOUR_HOST/api/envelopes/env_... \\
  | jq '.envelope | .recipients[1].email = "right@example.com"' > fixed.json

curl -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\
  https://YOUR_HOST/api/envelopes/env_... -d @fixed.json`}</Code>
          <p><b>The lock rule.</b></p>
          <ul className="pub-list">
            <li>Until someone has finished, anything can change: documents, recipients, fields, subject, message and order.</li>
            <li>Once a signer, approver or viewer has finished, two things stay as they are. One is what is printed on the documents: the files and their order, every field and whose it is, any wording you wrote on the pages (notes, read-only values, values you filled in for a signer), any name or address a full name or email field prints, also of someone who only gets a copy, and the date format. The other is the people who finished: their name, email, role and place in the order, and whether they are on the envelope at all. A call that touches one of them returns <C>409</C> with <C>&quot;code&quot;: &quot;sign_again&quot;</C>, says who would have to sign again and what would change, and saves nothing.</li>
            <li>To make such a change anyway, send the same call with <C>&quot;resign&quot;: true</C>. Everyone who finished is then told what changed and asked to sign again. Their first signature and answers stay in the audit trail, the certificate shows both times, and signing again does not use another signature.</li>
            <li>Names, email addresses and the order of the people who have not finished can still change freely, unless a full name or email field prints that name or address on the pages. So can the subject, the message, what a field asks of its signer (label, required, choices), and the access code and private note of anyone, finished or not.</li>
            <li>A value a signer typed into their own field is never changed by a correction, whatever your body carries for it. The same goes for what a signer who has finished left empty or unticked: that is their answer.</li>
          </ul>
          <p><b>Nothing is dropped without a word.</b> A part of the body that cannot be carried out as you wrote it returns <C>400</C>, names the part and saves nothing: a field of a type that does not exist, or for a recipient or document that is not in the body; a role, date format or kind that does not exist; two items with the same id; a page the document does not have; text over its limit; a number out of range; a list that is not a list; a value on a signature, initials, attachment or automatic field. Send the <C>edit_version</C> you got from the GET call, and a save from an out-of-date copy returns <C>409</C> with <C>&quot;code&quot;: &quot;stale&quot;</C> and who changed the envelope, when, and how if it was not a save (<C>edited_how</C>: a quick correction, a signer who passed the document on or fixed their name, or sending), instead of undoing it. Leave it out and the call is not checked.</p>
          <p><b>What recipients notice.</b> Someone whose part did not change keeps the same link and hears nothing. Someone whose part changed keeps their link and gets an email that says the document was updated. A changed email address or role gets a fresh link, and the old one answers <C>410</C>. A new address is a new person, so they start with empty fields: nothing the first person typed or drew is passed on. Someone you remove is told they are no longer needed. If you change the signing order, someone who has the document but is now behind a person who has not finished is told to wait, and is emailed again when it is their turn. A signer who has the page open while you correct the document cannot finish on the old version: their page loads the new one, a replaced file included, and Finish stays off until its pages are on their screen. Someone who is asked to sign again can still download the document as they signed it the first time. The audit trail, which is printed on the certificate, records what each correction changed in words. The <C>envelope.corrected</C> webhook fires.</p>
          <p className="muted small">A list you send (documents, recipients, fields) replaces the list that was there, so send each list in full. A list or a setting you leave out altogether stays as it is. Keep the field ids from the GET call: a field sent without its id counts as a new field.</p>
        </div>

        <div className="card" id="extend">
          <h2>More time, one reminder, and everything out</h2>
          <p><b>Extend.</b> <C>POST /api/envelopes/:id/extend</C> with <C>{'{"days": 14}'}</C> pushes the deadline out. Days can be 1 to 365 and default to 30. On an expired envelope it reopens it: the same links work again, people who were waiting are told, and nobody who signed has to sign again.</p>
          <p><b>Remind one recipient.</b> <C>POST /api/envelopes/:id/remind</C> with <C>{'{"recipient_id": "rcp_..."}'}</C> reminds that person only. With no body it reminds everyone whose turn it is. The answer says how many were reminded. A recipient who switched reminders off is skipped and shows <C>muted: 1</C>.</p>
          <p><b>Export.</b> <C>GET /api/export</C> returns one ZIP file: <C>signed/</C> with every completed PDF and its certificate, <C>audit/</C> with each audit trail as JSON, and <C>envelopes.csv</C>. Add <C>?ids=env_a,env_b</C> to pick envelopes. It is free on every plan and keeps working after a paid plan ends.</p>
          <p><b>Batches.</b> A bulk send is one thing you can act on. <C>GET /api/bulk/:id</C> shows every envelope and recipient in it, <C>POST /api/bulk/:id/remind</C> nudges the people who have not finished, and <C>POST /api/bulk/:id/void</C> closes what is still open. Both work through the batch one envelope at a time. An envelope that someone finishes or declines while that is going on is left as it is, and the void answers with how many it <C>voided</C> and how many it <C>skipped</C> for that reason.</p>
          <p><b>A bulk send that is repeated.</b> <C>POST /api/bulk</C> answers when every row has been tried, which takes as long as the mail server needs for the whole list. Send it with an <C>Idempotency-Key</C>. If your call times out, repeat it with the same key and body: while the first call is still sending you get <C>202</C> with the same batch and what has gone out so far, and afterwards <C>200</C> with the full result. If our side stopped half way, the repeat sends the rows that had not gone out, and nobody gets a second copy. <C>GET /api/bulk/:id</C> lists every row as <C>sent</C>, <C>failed</C> (with the reason) or <C>pending</C>.</p>
        </div>

        <div className="card" id="webhooks">
          <h2>Webhooks</h2>
          <p>Add a URL under Settings, then API and webhooks. We POST JSON for these events: <span className="mono">{WEBHOOK_EVENTS.join(', ')}</span>.</p>
          <Code label="Example: a webhook delivery">{`{
  "id": "evt_Xk3...",
  "event": "envelope.completed",
  "created_at": "2026-11-20T09:12:44.000Z",
  "envelope": { "id": "env_...", "status": "completed", "subject": "Please sign: contract",
                "sent_at": "2026-11-19T15:02:10.000Z", "completed_at": "2026-11-20T09:12:44.000Z" },
  "text": "Please sign: contract: envelope completed"
}`}</Code>
          <ul className="pub-list">
            <li><b>New event: <C>envelope.corrected</C>.</b> Sent whenever an envelope that is out is corrected. Read the envelope again to see how it stands.</li>
            <li><b>Recipient events</b> and <C>envelope.declined</C> also carry a <C>recipient_id</C>.</li>
            {/* Only on a server that is told about bounces (MAIL_EVENTS_TOKEN). Elsewhere envelope.updated never fires. */}
            {mailEventsOn() && <li><b><C>envelope.updated</C></b> carries a <C>recipient_id</C> and a <C>change</C>: <C>email_bounced</C> (our email to them came back for good, and reminders to them stop), <C>email_marked_as_spam</C>, <C>email_tried_again</C> (you said the address works: <C>POST /api/envelopes/:id/try-again</C> with <C>recipient_id</C>), <C>email_works_again</C> (a later email arrived) or <C>email_wanted_again</C> (they asked for our emails again). Each recipient carries <C>bounced_at</C>, <C>bounce_reason</C> and <C>complained_at</C>, and each email in the delivery log <C>delivered_at</C>, which means their mail server took it, not that they read it. A send to an address that bounced in the last 30 days answers <C>409</C> with <C>&quot;code&quot;: &quot;bounced_address&quot;</C> until you repeat it with <C>&quot;send_anyway&quot;: true</C>.</li>}
            <li><b>The <C>text</C> property</b> is a one-line summary of the event. Slack and Microsoft Teams incoming webhooks show whatever is in <C>text</C>, so you can paste an incoming webhook URL as the webhook address and get every event as a chat message. No code needed.</li>
            <li><b>Retries.</b> A delivery that fails is tried three times in all, a few seconds apart. Your endpoint has 10 seconds to answer with a 2xx status. A redirect is not followed and counts as a failure. Only the status of your answer is read.</li>
            <li><b>Redelivery.</b> Every delivery is in the log from before the first try, so an event is listed even if our side restarts halfway. After you fix your side, send any of the latest {KEEP_BODIES} deliveries of that webhook again from Settings, or with <C>POST /api/webhooks/deliveries/:id/redeliver</C>. Older ones stay listed but can no longer be sent again. The <C>id</C> in the body stays the same, so you can ignore repeats.</li>
            <li><b>No silent failures.</b> After three failed deliveries in a row, the account admins get an email.</li>
          </ul>
          <Code label="Example: verify a webhook signature">{`// Verify a delivery (Node.js)
const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET)
  .update(req.headers["x-signandgrow-timestamp"] + "." + rawBody).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-signandgrow-signature"]));`}</Code>
          <p className="muted small">Webhook addresses must use https and point to a public address. The name is looked up once when each delivery starts, and the delivery only connects to an address that passed the check.</p>
        </div>

        <div className="card" id="checks">
          <h2>Checking who signs</h2>
          <p>Each recipient can carry a check that has to be passed before the document opens for them. Set it where you set the name and the email address, on <C>POST /api/envelopes</C>, on <C>PUT /api/envelopes/:id</C> and on <C>POST /api/envelopes/:id/correct</C>:</p>
          <Code label="Example: a recipient who is checked by text message">{`"recipients": [{
  "name": "Sam Signer", "email": "sam@example.org",
  "verify": "sms_code",        // "none" (the default), "email_code" or "sms_code"
  "phone": "+447700900123",    // E.164: plus sign, country code, number. Needed for "sms_code" and for "text_link"
  "text_link": true            // also text the signing link. Off unless you send true
}]`}</Code>
          <ul className="pub-list">
            <li><C>email_code</C> sends a 6-digit code to the recipient&apos;s email address, <C>sms_code</C> by text message to <C>phone</C>. The code is sent when the person asks for it on the signing page, works for 10 minutes and for 5 tries, and is never in any answer of this API. <C>access_code</C> works as before and can be combined with either: it is asked for first.</li>
            <li>Text messages exist only when the operator of this server has switched them on. <C>GET /api/me</C> says so in <C>text_messages</C>. When they are off, <C>&quot;verify&quot;: &quot;sms_code&quot;</C> and <C>&quot;text_link&quot;: true</C> are refused with 400, a sentence that says so, and <C>&quot;code&quot;: &quot;texts_off&quot;</C>. <C>email_code</C> always works.</li>
            <li>A phone number that is not in international form, or a missing one where a text is asked for, is refused with 400 when the envelope is sent or corrected. A draft may hold a half-typed number.</li>
            <li>What comes back: <C>verify</C>, <C>phone</C>, <C>text_link</C>, and <C>check</C> with <C>line</C> (the sentence the certificate will carry, such as &ldquo;Link sent by email only&rdquo;), <C>passed_at</C> and <C>stopped</C> (someone using the link said the number is not theirs, and no code goes to it until you correct it). <C>GET /api/envelopes/:id</C> also returns <C>texts</C>: what became of every text message, with the number masked.</li>
            <li>Changing <C>verify</C> or <C>phone</C> on an envelope that is out makes that person pass the check again and writes a line to the audit trail. Changing their email address to another person&apos;s needs their <C>phone</C> in the same call when a text is still asked for: a number typed for one person is never used for another. After someone using the link said the number is not theirs (<C>check.stopped</C>), no code and no text goes to it; send <C>&quot;number_confirmed&quot;: true</C> to <C>POST /api/envelopes/:id/correct</C> once you have checked with the person that it is right after all.</li>
            <li>A text counts like an email to that person: 403 while the account is paused, 429 when an account under the daily limit would text more phone numbers than it may email people, and 429 when the account has used the text messages this server allows it in 24 hours. Texts are not charged for.</li>
            <li>Templates keep the check. <C>POST /api/bulk</C> and <C>POST /api/envelopes</C> with a <C>template_id</C> take <C>phone</C> next to <C>name</C> and <C>email</C> for each role. A public form refuses <C>sms_code</C> and <C>text_link</C> on the role its visitors fill in, and accepts <C>email_code</C>.</li>
          </ul>
        </div>

        <div className="card" id="embedded">
          <h2>Embedded signing</h2>
          <p>Call <C>POST /api/envelopes/:id/recipient-view</C> with a <C>recipient_id</C> to get a signing URL, then send your user there in a new tab or with a redirect. The page cannot be shown inside a frame on another site. Any recipient can get a link, it stays the same while the envelope is open, and it survives a correction that leaves that person alone. Ask for it as often as you like: the audit trail on the certificate records that a link was issued at most once a day for each link.</p>
          <p className="muted small">Treat the URL like a password: whoever holds it can sign as that recipient.</p>
          <p>To deliver the link entirely yourself, give the recipient <C>&quot;link_by_sender&quot;: true</C> and no <C>email</C>. We then never email that person, not even reminders or the completed copy, and this URL is the only way in, also to the completed document afterwards. The certificate says &quot;Link shared by the sender&quot; for them. They count towards the daily limit on new people like anyone, and reminding everyone answers with them in <C>not_reminded</C>.</p>
        </div>

        <p className="muted">Stuck on something this page does not answer? <Link href="/help?topic=sending#contact">Write to us</Link>. A person replies.</p>
      </main>
      <PublicFooter />
    </div>
  );
}
