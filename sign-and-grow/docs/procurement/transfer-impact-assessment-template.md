# Transfer impact assessment: a template

**Template. Not legal advice.**

Written on 21 November 2026, from the code as it was that day.

## What this is not

- It is not a finished assessment and it reaches no conclusion. Whether a transfer is allowed, and under which
  safeguard, is for the body that transfers and its lawyer.
- It does not describe the law of any country.
- It is not about the software's authors. They receive no data from any server.

## Step 1: what leaves the country

Print `/security/subprocessors` of the server. Each row there is a provider whose switch is on, with the country the
operator stated for it, or "not stated". Copy each row here, and also each service under "Also connected to" on
the same page: those are set up to reach a service for one job, and some of them receive personal data or whole
documents (see the facts below).

| Provider | Country it handles data in | What reaches it | Whose data |
| --- | --- | --- | --- |
| [from the page] | [from the page] | [from the page] | [from the page] |

Facts from the software, for every server:

- The server itself and every stored file are in one place, where the operator runs it (`DATA_REGION`). The
  software has no second region and copies nothing to another one (`src/lib/dataplace.ts`).
- The authors of the software receive nothing: there is no service that sends data to them (`src/lib/outside.ts`).
- A time-stamp service, when set up, receives fingerprints, never the document: one of the last line of each
  document's record when everyone has finished, with or without a seal (`src/server/auditstamp.ts`), and one of the
  seal when a seal is set up (`src/server/tsa.ts`).
- With a seal and a time-stamp service both set up, the server also asks the places named inside the seal's and the
  service's certificates (their OCSP services and revocation lists) whether those certificates are still good. It
  sends them a certificate's serial number. Their addresses come from the certificates, so no page can list them in
  advance: read them from the certificates (`src/server/ltv.ts`).
- A document converter at `CONVERTER_URL` (Gotenberg), when set up, receives the whole of every Word, Excel,
  PowerPoint or similar file someone uploads, to turn it into a PDF (`src/server/convert.ts`). It is listed under
  "Also connected to" with its address only: write down who runs it and in which country. LibreOffice on the
  server itself (`CONVERTER=soffice`) sends nothing anywhere.
- The list of leaked passwords receives the first five characters of a fingerprint of a new password, never the
  password and never who is asking (`src/server/pwned.ts`). `PWNED_CHECK=0` switches it off.
- Email leaves through the operator's mail relay to wherever the recipients' mail is. That is how email works; the
  software cannot keep a recipient's mailbox in one country.
- Sign-in with Google or Microsoft, when set up, tells that company that a person signed in, and nothing about any
  document.

## Step 2: for each transfer

For each row of step 1 that is outside [the customer's country or region]:

1. The safeguard used: [ ]
2. The law of the destination that could give public authorities access, and how likely that is for this data: [ ]
3. Extra measures: [for example, stored files encrypted with a key that stays in the country
   (`FILE_ENCRYPTION_KEY`), the service switched off, or a provider in the country instead]
4. Conclusion, who reached it, and when: [ ]

## Step 3: what can be switched off instead

Every outside service in step 1 except the mail relay can be switched off, and `OUTSIDE_CALLS=none` holds the server
to the mail relay and the hosts the operator lists (`src/server/outside.ts`). A transfer that is not needed can be
removed rather than assessed.
