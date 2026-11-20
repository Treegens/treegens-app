# GrowSigning UX charter

The owner asked: "build out all the features but make sure it's always user friendly and as simple and easy as
possible to use". About 90 features are planned (the batches in docusign-gaps.json, government.json and
briefs.json). This charter says where every one of them goes, what it may and may not add, and how we check that
the six core flows never get harder.

Every engineer follows it. If a brief and this charter disagree on where something appears or what it is called,
the charter wins. Behaviour, rules and the record still come from the brief. If you think the charter is wrong,
say so in your report. Do not work around it.

Baseline: tests/out/ux-baseline/ux-flows.json, measured with tests/ux/flows.cjs on a fresh server with zero setup.

---

## 1. Principles

Each principle has a test. A change that fails one is not finished.

**P1. The core flows never get longer.** The six measured flows (send a first document, sign on a phone and a
desktop, send from a template, find and download, change your name, a signer who needs help) never get more
actions, screens, choices or words than the budget in section 3. They never get a new required step, screen or
choice unless the person (or their admin) switched the thing on.
*Test:* run tests/ux/flows.cjs with zero setup and compare it with the budget (section 5). Every number must be at
or under its ceiling. The script must pass without new patterns.

**P2. Zero setup, good defaults.** A new account on a new server can sign up, send, sign and download with nothing
configured. Every setting has a default that works. A setting is never asked for at first use. When unsure, the
default is what the product does today.
*Test:* the flows run on an empty DATA_DIR with only DEV_OUTBOX and APP_URL set.

**P3. Hidden until set up.** A feature that needs an operator's setup (keys, a converter, a provider, a
certificate, a contract) does not appear anywhere until it is set up: no greyed-out button, no "not configured",
no upsell. The only place that lists what is not set up is the operator page (/app/operator) and the README.
*Test:* with no settings, grep the rendered pages for the feature's words: none.

**P4. One "More options" per screen, closed by default.** Advanced options live behind one "More options" control
per screen, closed when the screen opens, and remembered closed. Each item (a person, a document, a field) may also
have one "More" of its own. Nothing else expands options. No feature adds a second expander, an extra tab or a
second panel to a core screen.
*Test:* count expanders per screen in the inventory: at most one "More options" plus one "More" per item.

**P5. One main button per screen.** Each screen has exactly one primary (filled) button: the thing most people do
next. Everything else is a secondary button, a link, or inside More. On the envelope page the main button depends
on its state (section 2.5).
*Test:* count elements with the primary button class in each screenshot state: exactly one (dialogs count on their
own).

**P6. Plain words.** Every screen uses the words in section 4. A technical name (PAdES, SAML, SCIM, SIEM, OIDC,
QES, PDF/A, RFC 3161, FIPS, PKCS#11) appears only in an admin's Settings or on the operator page, always next to a
plain name and a one-line explanation, never on a signer's screen and never in a sender's daily path. Sentences on
signer screens are 20 words or fewer. Buttons start with a verb.
*Test:* a word scan of the signing page states, the editor, the envelope page and emails to signers finds none of
the "avoid" words in section 4.

**P7. A signer sees only what that signer needs.** The signing page shows the sender, the document, what to do,
and the way out (Other actions, Help). Never prices, plans, IP addresses, hashes, internal ids, other people's
private notes, sender-side settings, or explanations of features the sender did not use. A check (code, identity,
sign-in) appears only when the sender chose it.
*Test:* the consent screen fits one phone screenful (390x844) with 120 words or fewer before the tick.

**P8. Admin and government features live in Settings.** Security, records, single sign-on, keys, organisations,
seals, rules engines, exports and connections live in Settings (or the operator page). They never appear in the
sidebar's top part, on Home, on the editor's default view, or as a main button on the envelope page. A government
deployment (DEPLOYMENT_PROFILE=government) changes defaults, not the layout.
*Test:* the sidebar, Home and the editor's three steps have the same controls in the default and government
profiles with zero setup.

**P9. No popup tours.** No coach marks, welcome tours, "what's new" dialogs, install prompts or modals that have to
be closed before you can go on. A hint is one line, in place, dismissible, shown once. The first-send and
first-sign celebration plays inside the screen it belongs to and never blocks the next step.
*Test:* no flow step has a dialog the person did not open.

**P10. Errors say what to do.** Every error says what happened and what to do, in that order, with the fix as a
button when there is one: "This file is protected with a password. Open it, save a copy without the password, and
add it again." Never a code alone, never "Something went wrong" alone, never blame.
*Test:* every refusal string in the server has a second sentence that starts with a verb.

**P11. Phone first.** Every screen is designed at 390x844 first and checked at 320x568 and 1440x900. Touch targets
are at least 44 px. No horizontal scroll. The main button is reachable without scrolling back up. Toasts appear at
the bottom and never cover a button.
*Test:* screenshots at 320, 390 and 1440 for every screen you changed; axe-core finds no target-size failure.

**P12. One way to do each thing.** Each task has one place. When two batches build the same thing (the seal in
ds-seal and gov-G05, single sign-on in ds-sso-oidc, ds-sso-saml-scim and gov-G08, the security record in ds-sec-log
and gov-G12, records in ds-retention and gov-G11, languages in ds-lang-* and gov-G15, keys in ds-cmk and gov-G22,
certificate signing in ds-qtsp, ds-webeid, gov-G16 and gov-G23, signer identity in ds-id-login, ds-id-docs,
gov-G09, gov-G24 and gov-G25), they share one screen, one name and one setting. Help is one entry per screen.
Download is one button.
*Test:* the inventory lists no two controls with the same job on one screen.

**P13. Honest words.** Never claim a certification, a legal effect or a level that is not true and checked
(gov-G01). Say "checked by", "as declared by the operator", "not reviewed by a lawyer" where the brief asks.
Honest and short go together: one line, not a paragraph of disclaimers.

**P14. Count before and after.** A batch that changes a core screen runs the tap-count check before and after and
puts both tables in its report.

---

## 2. Information architecture

Feature keys in brackets show where each planned batch lands. Section 6 has a note for every key.

### 2.1 App navigation (sidebar on desktop, bottom bar on phones)

Desktop sidebar, in this order:

1. **Send a document** (the one yellow start button; the only start button in the app)
2. **Home**: what waits for you, what waits for others, recently completed with Download on each row. A phone-only
   line "Add GrowSigning to your home screen" once, dismissible [ds-phone-app].
3. **Documents** (today "Envelopes"): tabs All, Drafts, Waiting, Completed, Closed; search; filters in one row, more
   filters in More options (sender, template, folder, details [ds-custom-fields], shared with me [ds-colleagues]).
4. **To sign** (today "Inbox").
5. **Templates**: Use on each row, everything else in the row's More. "Start from a ready-made one"
   [ds-templates-lib]. The Use dialog has "Add another template" [ds-tpl-combine].
6. **Contacts**: people and groups.
7. **More** (a group, closed by default):
   - Send to many (today "Bulk send"), with Saved lists [ds-reports]
   - Forms: links anyone can sign and phone-first forms (today "PowerForms") [ds-web-forms, ds-switches form limits]
   - Website terms (today "Click-to-agree"; admins)
   - Reports [ds-reports]
   - Key dates (only when AI may read documents) [ds-ai-repo]
   - Trees planted (today "Our impact") [impact]
   - Counter (only for people with the counter permission) [gov-G18]
8. **Settings**
9. **Help** (one entry: opens the helper; the help page is linked from inside it) [chat]

Then the account switcher, Sign out, and for operators only "Operator". "Dev outbox" only in development.

Phone bottom bar: Home, Documents, **Send** (centre, the main button), To sign, Menu (everything else in the order
above).

The usage line (signatures left) sits under the account name, one line [expiry].

### 2.2 Settings

A list on the left (desktop) or a list page (phone). Each section is one page of cards. Each card saves on its own
with "Saved" next to its button, never a toast over other fields. A section that has nothing for this person is not
listed. Explanations are one line under the control; long rules sit behind "How this works".

**For you** (everyone)

| Section | What goes in it |
|---|---|
| Profile | Name, job title, company, email address, language of your screens [ds-lang-sender], your signature and initials |
| Sign-in and security | Password, two-step login, ways to sign in (Google, Microsoft, smart card when set up [gov-G23]), where you are signed in and how (single sign-on, method) [gov-G08] |
| Notifications | The 4 email switches; monthly report email for admins [ds-reports] |
| Away and sharing | Only on accounts with 2 or more members. Share my documents with a colleague, shares given and received [ds-colleagues]; someone signs for me while I am away, only when an admin switched it on [ds-delegate] |

**Your account** (owner and admins; members see a read-only line where a rule affects them)

| Section | What goes in it |
|---|---|
| Account | Account name, logo, brand colour; your name on emails and pages and a verified sending domain [gov-G17]; default language for people you send to [ds-lang-core]; Trees on screens and emails, impact lines on the certificate [gov-G01, impact]; AI card: AI helper on or off, let the AI read document text [gov-G01, gov-G20, ds-ai-assist] |
| Sending | Defaults for new documents: reminders, deadline, date format (moved here from Account); people may pass it on, questions and comments, words across unfinished copies, ways to make a signature [ds-switches]; signing on paper [ds-paper]; each person sees only their documents [ds-visibility]; access code rules and the in-person ID question [ds-id-small]; details on each document [ds-custom-fields]; saved fields [ds-fields-kinds]; your consent text [ds-consent-own]; strict signing [ds-part11]; signature level rules by country [gov-G10] |
| Team | Members, invite, role; "What each role can do" and groups of members in More options [ds-perm-profiles]; move a member's documents and templates to another member [ds-colleagues]; allow "signs for me while I am away" [ds-delegate]; records officer and counter roles come from role permissions [gov-G11, gov-G18] |
| Stamps and seals | Account stamps [stamp]; members may place stamps [ds-switches]; organisation seal [ds-eseal] |
| Plan | What is left and when it resets, top-ups with their dates, Top up, Have a code, money back, history; the rules behind "How signatures work" [expiry]. In deployment billing mode the whole section is one line naming the agreement [gov-G14] |
| Security | Single sign-on and your email domains [ds-sso-oidc, ds-sso-saml-scim, gov-G08]; members from your directory [ds-sso-saml-scim]; sign-in rules: password length, sign out when idle, one session at a time, two-step for everyone, smart card required [ds-sec-policy, gov-G23]; security record with alerts and "Send to your security system" [ds-sec-log, gov-G12]; your own encryption key, owner only [ds-cmk, gov-G22] |
| Records and data | Keep and delete, holds, deletion record [ds-retention, gov-G11]; copies of every email [ds-mail-records]; archive format PDF/A, only when the operator installed the checker [ds-pdfa, gov-G06]; digital seal status line [ds-seal, gov-G05]; where your data is kept [ds-regions]; export everything [gov-G19]; bring in documents (from an export or from DocuSign) [gov-G19]; close your account |
| Connections | Listed only when the operator set up at least one service. File sources [ds-cloud-pick]; WhatsApp [ds-channels]; identity checks for signers [ds-id-login, ds-id-docs, gov-G09, gov-G24, gov-G25]; signing with a certificate or an ID card [ds-qtsp, ds-webeid, gov-G16, gov-G23]; notary [ds-notary]; take payments [ds-pay-collect] |
| Developers | API keys, webhooks, signing inside your site or portal [ds-dev-api, gov-G17], the sender screen in your app [ds-dev-api], pulling the security record [gov-G12], API reference link |
| Organisation | Only for organisation admins: agencies below, policies passed down, delegated admin [gov-G13]. A setting set above shows "Set by Ministry of X" wherever it appears |

Removed or merged: "Your data" becomes Records and data; "API and webhooks" becomes Developers; the password,
two-step and session parts of Profile move to Sign-in and security.

### 2.3 The editor

Three steps, never four. The top bar: Save and close, the three step names, Help, Next or Send (main button).

**Step 1. Documents and people**
- Drop zone "Choose a file or drop it here" (PDF, photos, and office files when the converter is set up
  [ds-convert]). Under it, up to four "From Google Drive" style buttons only when set up [ds-cloud-pick]. A
  shared file opens here [ds-phone-app]. A line under a file that already has signatures: "This file has
  signatures. They are kept." [gov-G07]. A line when it looks like a template: "Use your template Volunteer
  agreement?" [ds-tpl-combine].
- Each document row: name (title-cased from the file name), Pages (remove, turn, move) [ds-page-tools], and More:
  Replace, Remove, Move up or down, To read, not sign [ds-supplements].
- People: one empty row is already there. Name and Email only, then "Add another person" and "Add me". Each person's
  More holds, in this order:
  1. Role: Needs to sign (default), Needs to approve, Gets a copy, Needs to view, Signs in person, Is a witness
     [ds-witness-two], Can change the document, Chooses the next person, Can update addresses [ds-recipient-types],
     Notary [ds-notary]
  2. Language, only when 2 or more languages ship [ds-lang-core]
  3. How they get it: Email (default), Text, WhatsApp [ds-channels], I will send the link myself
  4. Check who signs: None (default), Access code [ds-id-small], Code by email or text, Sign in to sign
     [ds-part11], and only when set up: Prove who you are with <scheme> [ds-id-login, gov-G09, gov-G24, gov-G25],
     Photo ID check [ds-id-docs]
  5. How they sign: On screen (default), with a certificate from <provider> or an ID card, only when set up
     [ds-qtsp, ds-webeid, gov-G16, gov-G23]; on paper allowed or required [ds-paper]
  6. Only when... [ds-routing-if]; Wait before this person [ds-timing]
  7. Private note
- More options (one per screen, closed): Set signing order, Add a group, Write a document here [ds-write-doc].

**Step 2. Fields**
- "Fields for" person picker; six common fields: Signature, Initials, Date signed, Name, Text, Checkbox.
- "More fields": Email, Company, Title, Number, Date, Radio, Dropdown, Attachment, Note, Strike out, Stamp [stamp],
  Organisation seal [ds-eseal], Drawing, Approve and Decline buttons, date formula [ds-fields-kinds], saved fields
  [ds-fields-kinds].
- "Place fields for me": one button for the {{signature}} tags and, when allowed, AI suggestions [ds-ai-assist].
- Field panel: Assigned to (or "Anyone on the document" [ds-collab-fields]), Required, Label. More options: Format
  and limits [ds-fields-checks], prefilled value, read only, only show when, calculate from, look (font, size,
  colour) [ds-fields-kinds], same answer as, size, duplicate, copy to every page, delete.
- Undo, Redo and zoom stay as small icon buttons. Keyboard help sits behind the Help button.

**Step 3. Review and send**
- Who gets it, in order, each with "See what they see" [ds-preview].
- Email subject and message (moved here from step 1), with "Draft a message" when the AI helper is on
  [ds-ai-assist].
- Details, only when an admin defined them [ds-custom-fields].
- "For: Kenya, employment contract. Change", only when signature level rules are on [gov-G10].
- At most one notice line; more checks fold into "2 more things to check". One line when signatures will run out
  [expiry].
- More options (closed): Send later [ds-timing], reminders, deadline, date format, people may pass it on, questions
  and comments, words across unfinished copies [ds-switches], each person sees only their documents
  [ds-visibility], people must sign in to sign [ds-part11], plain summary for signers [ds-ai-assist], ask for a
  payment [ds-pay-collect], send for a colleague [ds-colleagues].
- One Send button. With Send later chosen its label becomes "Send at 9:00 on 3 December".

### 2.4 Templates, forms and the rest of the sender's app

- Templates: same editor; per template the "Who can use this" rules stay in the template's More.
- Forms: one list for "Anyone with the link can sign" and "Fill-in form" [ds-web-forms]; limits and closing date on
  each form [ds-switches].
- Send to many: template, list, check, send; Saved lists [ds-reports].
- Counter: today's in-person queue and second-screen pairing [gov-G18].
- Key dates: dates and duties found in completed documents, "found by AI, check it", Remind me per row [ds-ai-repo].

### 2.5 The envelope page (on screen: the document page)

- Title (the document name), one status sentence ("Waiting for Ana Silva to sign. Sent 2 minutes ago."), a hold or
  delete date when there is one [ds-retention].
- One main button by state:

  | State | Main button |
  |---|---|
  | Draft | Continue |
  | Scheduled | Send now [ds-timing] |
  | Waiting | Send a reminder |
  | Scan waiting | Look at the scan [ds-paper] |
  | Completed | Download |
  | Expired | Reopen |
  | Declined | Copy and fix |

- People: one status line each. Each person's More: Remind, Copy link, QR code, WhatsApp, Text, Change person. For
  "I will send the link myself", the share buttons are shown directly because that is what the sender came for.
- The page's More: Download (when not main), Full record for disputes, Preview, Edit, Give more time, Pause or
  Resume [ds-timing], Copy, Save as template, Move to a colleague [ds-colleagues], Keep it, Hold (admins),
  Delete now [ds-retention], Cancel the request, Delete.
- Folded sections, closed by default: Questions and comments (with a count), History, Details [ds-custom-fields,
  ds-ai-repo], Emails sent, Checks on the file (seal, long-term, PDF/A, signature checks) [ds-seal, ds-seal-ltv,
  ds-pdfa, gov-G05, gov-G06, gov-G07, ds-qtsp].
- History shows plain lines. IP addresses, hashes and time-zone reports are in the full record, not on the page.
- After the first send ever, the celebration plays inside the status area [impact].

### 2.6 The signing page

Screens, in order; each one only when it applies:

1. Access code or one-time code (only when the sender chose it). "Call me with the code" when voice is set up
   [ds-channels]. "Use another number" when the signer gives their own [ds-id-small].
2. Prove who you are (only when the sender chose it): sign in [ds-part11], national eID or bank ID
   [ds-id-login, gov-G09, gov-G24, gov-G25], photo ID with a plain screen first [ds-id-docs].
3. Consent: who sent it (named once), the document name, one sentence on what this is, the account's own terms
   behind "Read <Org>'s terms" [ds-consent-own], one tick, Continue. One line "10 mangroves will be planted when
   you finish" for paid signatures [impact]. Other actions is already here.
4. The document: "Also for you: Privacy notice" list when there are supplements [ds-supplements]. Toolbar: Next or
   Finish (main) and More (page view or easy reading [ds-reading-view], zoom, download, questions and comments,
   summary [ds-ai-assist]). Next jumps to the field and opens it. Approve and Decline buttons on the page when the
   sender placed them [ds-fields-kinds].
5. Your signature: Type (prefilled), Draw, Upload, as the account allows [ds-switches]; button "Sign". With a
   certificate or ID card the provider's step replaces this dialog [ds-qtsp, ds-webeid, gov-G16, gov-G23]. Strict
   signing adds the reason and a password check here [ds-part11]. The stamp dialog for stamp fields [stamp].
6. Finish: goes straight to Done unless something needs attention (an unanswered question, a name to fix).
7. Done: what happens next, Download, and the first-time celebration in place [impact].

Header: sender, document name, language menu only with 2 or more languages [ds-lang-signing], Help [chat].
Idle for 30 minutes: "Still there? Continue" [ds-sec-policy]. No signal for an in-person signer on the host's
installed app: "Saved on this device. It is sent when you are back online." [ds-offline-inperson].

Other actions: at most 6 at a time, no descriptions, only those that apply: Finish later, Ask for more time, Print,
sign by hand and send a photo [ds-paper], Pass to someone else, Questions and comments, Decline. When relevant:
Hand back to the group, Change my signature, Stop reminder emails, I was not there, Stop signing electronically
[ds-consent-own]. Dates are in the signer's own time.

### 2.7 Public pages

- Top bar: Pricing, Help, Sign in, Start free. Nothing else.
- Landing: what it is, the price, the trees, one Start free button. At most 3 phone screenfuls and 800 words. Live
  counters appear only once they show at least 1 tree.
- Footer, in groups: For signers (Check an email, Check a signed document [gov-G07], Find my documents, Help in
  your language [ds-lang-mail]); Trust (Security, Certifications [gov-G01], Sub-processors and Procurement
  [gov-G03], Accessibility [ds-a11y, gov-G04], Report a weakness [ds-self-host]); Product (Pricing, Government
  prices [gov-G14], Trees planted, Developers).
- /verify is the one page that checks a file: "completed here", "deleted since", and the signatures inside it
  [gov-G07, ds-retention].
- Login: email first; "Continue with <Org> sign-in" appears when the domain is claimed [ds-sso-oidc, gov-G08];
  "Sign in with a smart card" only when set up [gov-G23]. A region select at sign-up only when the operator offers
  2 or more regions [ds-regions].

### 2.8 Places that are not screens

No app UI, only README, docs, /security pages and the operator page: ds-self-host, ds-db-encrypt, gov-G02,
gov-G21, gov-G26, the converter and seal settings, LTV wait, OCR [ds-a11y], Require TLS [ds-mail-records].

---

## 3. Budget for the core flows

Ceilings are hard: no batch may push a number above them with zero setup. Targets are where the quick wins should
take us. Words include the dev-only notices (no mail server, dev outbox link: 1 notice and a few words).

| Flow | | actions | screens | choices_seen | max_choices | words | notices |
|---|---|---|---|---|---|---|---|
| a-send-first | baseline and ceiling | 19 | 10 | 193 | 42 | 3751 | 2 |
| | target | 14 | 8 | 120 | 25 | 1800 | 1 |
| b-sign-phone | baseline and ceiling | 8 | 6 | 48 | 13 | 751 | 0 |
| | target | 6 | 5 | 35 | 10 | 450 | 0 |
| b-sign-desktop | baseline and ceiling | 8 | 6 | 48 | 13 | 761 | 0 |
| | target | 6 | 5 | 35 | 10 | 450 | 0 |
| c-template-send | baseline and ceiling | 5 | 4 | 92 | 34 | 666 | 1 |
| | target | 5 | 4 | 60 | 20 | 450 | 1 |
| d-find-download | baseline and ceiling | 4 | 3 | 99 | 43 | 739 | 0 |
| | target | 3 | 2 | 60 | 25 | 450 | 0 |
| e-settings-name | baseline and ceiling | 3 | 2 | 68 | 36 | 487 | 0 |
| | target | 3 | 2 | 30 | 15 | 250 | 0 |
| f-signer-help | baseline and ceiling | 7 | 5 | 42 | 10 | 927 | 2 |
| | target | 4 | 3 | 30 | 8 | 500 | 1 |
| Totals | ceiling | 54 | 36 | | | 8082 | |

Rules:
- When a quick win lowers a number, the new number becomes the ceiling. Write it in this table in the same change.
- Timings (wall_s, klm_s) are not ceilings because the machine is shared, but a rise of more than 20 percent in
  klm_s needs a reason in the report.
- A feature that is switched on may add to a flow. Measure that variant in the feature's own test, not here, and
  keep it as small as the feature allows: one screen at most for a check the sender chose, no new screen for
  anything else.

---

## 4. Words

Use the plain name on screens. The technical name may follow in an admin's Settings, once, with its one-line
explanation. "Avoid" words never appear on signer screens and should leave sender screens.

| Technical thing | Say | Avoid on screens |
|---|---|---|
| Envelope | document (the list is "Documents"; several files are "files") | envelope |
| Recipient | person, the people | recipient |
| Bulk send | Send to many | bulk |
| PowerForm, web form | Form, "Anyone with this link can sign" | PowerForm, web form |
| Click-to-agree | Website terms | clickwrap |
| Adopt signature | Your signature, button "Sign" | adopt |
| Audit trail | History | audit trail (fine in the full record and API) |
| Certificate of completion | Signing record | certificate of completion |
| Evidence pack | Full record for disputes | evidence pack |
| Void | Cancel the request | void |
| Clone | Copy | clone |
| Correct | Change person | correct |
| Nudge | Remind | nudge |
| Inbox | To sign | inbox |
| Our impact | Trees planted | |
| Credits, lots | signatures left, "reset on 3 December" | credits, lots, ledger |
| Custom fields, metadata | Details | custom fields, metadata |
| Supplemental documents | To read, not sign | supplemental |
| Document visibility | Each person sees only their documents | visibility |
| Conditional routing | Only when... | conditional, routing |
| Delayed routing | Wait before this person | delayed routing |
| Scheduled sending | Send later | scheduled |
| Editor, agent, intermediary roles | Can change the document, Chooses the next person, Can update addresses | editor, agent, intermediary |
| Composite templates | Use several templates together | composite |
| Collaborative fields | Anyone on the document can fill it in | collaborative |
| Validation, mask, regex | Format, My own pattern | validation, regex, mask |
| Delegated signing | Someone signs for me while I am away | delegate |
| Shared access, on behalf of | Share with a colleague, "sent by Ana Silva" | on behalf of |
| Permission profiles | What each role can do | permission profile |
| Signing group | Group (any one of them can sign) | |
| Access code | Access code (a code you tell them) | |
| OTP, voice OTP | Code by email, Code by text, Call me with the code | OTP |
| Identity verification, IDV, liveness | Prove who you are with <scheme>, Photo ID check, Photo ID and selfie | IDV, liveness, IAL, AAL |
| eIDAS levels, NIST IAL/AAL/FAL | (certificate and admin only) "level substantial, as declared by the operator" | on signer screens |
| EUDI Wallet, OpenID4VP, PID | EU Digital Identity Wallet | OpenID4VP, PID |
| QES, AES, QTSP, CSC API | Sign with your <provider> certificate; admin: "Qualified signature (QES) through <provider>, a trust service on the EU list" | QES, AES, QTSP on signer screens |
| Web eID, PIV, CAC | Sign with your ID card, Sign in with a smart card | PIV, CAC, Web eID on signer screens |
| PAdES seal, PKI | Digital seal; admin: "Digital seal (PAdES): PDF readers show if the file changed after signing" | PAdES, PKI, CMS |
| RFC 3161 timestamp | Trusted time stamp | RFC 3161, TSA |
| PAdES B-LT, B-LTA, LTV | Can be checked for years | LTV, B-LT, OCSP, CRL |
| PDF/A | Archive format (PDF/A) | |
| eSeal | Organisation seal | eSeal |
| Signature validation, DSS | Check a signed document; "Signature intact", "Changed after signing", "Could not check" | DSS, ETSI, indication |
| SSO, SAML, OIDC | Single sign-on, "Continue with <Org> sign-in"; admin: "SAML 2.0 or OpenID Connect: the standard your sign-in service uses" | SAML, OIDC on login |
| SCIM | Members from your directory | SCIM outside Settings, Security |
| Claimed domain | Your email domains | |
| SIEM, syslog | Your security system; admin: "Send to your security system (SIEM: Splunk, Elastic, Sentinel)" | SIEM, events |
| Security event log | Security record | event log |
| Retention policy, purge | Delete after, Delete now | retention, purge |
| Legal hold | Hold (never delete) | |
| Disposition | Deletion record | disposition |
| Redaction | Remove names and answers | redact |
| BCC archive | Copies of every email | BCC, journaling |
| Require TLS | (operator only) | |
| Data residency, region | Where your data is kept | residency |
| Customer-managed keys, KMS, KEK | Your own encryption key | CMK, KEK |
| Tenant | account | tenant |
| Multi-agency org | Organisation, agencies | tenant, org |
| White label | Your name instead of ours | white label |
| Embedded signing, iframe, origin | Signing inside your site | iframe, embed |
| Webhook | Webhook (Developers only, with "Tell your system when something happens") | |
| 21 CFR Part 11 | Strict signing; admin: "Used for 21 CFR Part 11" | Part 11 on signer screens |
| Watermark | Words across unfinished copies | watermark |
| Rotate | Turn | rotate |
| Locale, i18n | Language | locale |
| Help chat, LLM | Help; "Talk to a person"; one line "Answers are written by AI and can be wrong" | chatbot, LLM, model (except the one model line) |

Numbers: never show an impact figure under 1 tree ("0.0002 of a tree"). Dates: the reader's own time with the
zone name, never UTC alone on a signer screen.

---

## 5. The tap-count check

Run it before and after any change to a core screen, and before every merge of a batch that touches the sidebar,
Home, the editor, the envelope page, the signing page, Settings, the landing page or an email to signers.

1. Start a dev server on a throwaway database with its own build folder:

   ```
   cd /home/user/treegens-app/sign-and-grow
   NEXT_DIST_DIR=.next-uxbase DATA_DIR=$(mktemp -d) DEV_OUTBOX=1 APP_URL=http://localhost:3690 npx next dev -p 3690
   ```

   Zero setup: do not set converter, seal, SMS, WhatsApp, AI, SSO or payment settings.

2. In another shell, run the flows into a new folder (never overwrite the baseline):

   ```
   node tests/ux/flows.cjs http://localhost:3690 tests/out/ux-now/
   ```

   It exits 1 if a step fails. A failure because a button moved is a finding: fix the pattern only when the new path
   is not longer. `UX_WARMUP=0` skips the warm-up, `UX_HEADED=1` shows the browser.

3. Compare with the ceilings:

   ```
   node -e '
   const ceil = {
     "a-send-first":   {actions:19, screens:10, choices_seen:193, max_choices:42, words:3751, notices:2},
     "b-sign-phone":   {actions:8,  screens:6,  choices_seen:48,  max_choices:13, words:751,  notices:0},
     "b-sign-desktop": {actions:8,  screens:6,  choices_seen:48,  max_choices:13, words:761,  notices:0},
     "c-template-send":{actions:5,  screens:4,  choices_seen:92,  max_choices:34, words:666,  notices:1},
     "d-find-download":{actions:4,  screens:3,  choices_seen:99,  max_choices:43, words:739,  notices:0},
     "e-settings-name":{actions:3,  screens:2,  choices_seen:68,  max_choices:36, words:487,  notices:0},
     "f-signer-help":  {actions:7,  screens:5,  choices_seen:42,  max_choices:10, words:927,  notices:2}
   };
   const base = require("./tests/out/ux-baseline/ux-flows.json").table;
   const now = require("./tests/out/ux-now/ux-flows.json").table;
   let bad = 0;
   for (const r of now) {
     const c = ceil[r.flow]; if (!c) continue;
     const b = base.find((x) => x.flow === r.flow) || {};
     if (!r.ok) { bad++; console.log(r.flow, "FAILED"); }
     for (const k of Object.keys(c)) {
       const flag = r[k] > c[k] ? "OVER" : "";
       if (flag) bad++;
       console.log(r.flow.padEnd(16), k.padEnd(13), String(b[k]).padStart(5), "->", String(r[k]).padStart(5), "ceiling", c[k], flag);
     }
   }
   process.exit(bad ? 1 : 0);'
   ```

   Keep the ceilings in this command equal to section 3. Put its output in your report.

4. Look at the screenshots in tests/out/ux-now/<flow>/ next to tests/out/ux-baseline/<flow>/ for every screen you
   changed, at 390 and 1440 wide. Check: one main button, one More options, no toast over a button, no cut-off
   text.

5. Clean up: stop the server, delete .next-uxbase, take the two ".next-uxbase" lines back out of tsconfig.json if
   next dev added them. Leave other sessions' edits alone. If a migration landed while the server ran, restart it
   on a fresh DATA_DIR.

---

## 6. Where every planned feature lives

One note per batch. "Lives" is where it appears and where it never appears; "Default" is what it does with zero
setup; "First sight" is what a person sees first; "Words" is the plain name; "Never" is what it may never add to
the core flows.

**ds-lang-core** (Languages 1: the foundation for other languages)

- Lives: Settings > Account: one select 'Language for the people you send to'. Editor step 1, a person's More: 'Language', only once a second language ships. Never on the main person row, never on the signing page in this batch.
- Default: English for everyone; with one language shipped nothing new is visible and LANGUAGE_NOTE stays as it is.
- First sight: An admin sees one 'Language for the people you send to' select in Settings > Account. Senders see 'Language' in a person's More once there is a real choice.
- Words: Language; each language in its own name (Français, Español). Avoid locale, i18n, catalogue.
- Never: A select with one option, a language field on the main person row, a new required choice in the editor.

**ds-convert** (Word, OpenDocument and other office files become PDFs)

- Lives: Editor step 1: the same drop zone takes office files; the converted note sits under the document. Operator settings only. Never a second upload button or a sender setting.
- Default: Off until the operator sets a converter; without it the refusal says 'Save it as a PDF and add it again' and names the kinds.
- First sight: A sender drops Contract.docx and sees the PDF with one line: 'Converted from Contract.docx. Check every page before you send.'
- Words: Converted from <file>. Avoid LibreOffice, Gotenberg, MIME, conversion on screen.
- Never: A conversion choice, a wait screen that blocks the editor, more than one note line per document.

**ds-seal** (A digital seal on every completed PDF)

- Lives: No sender or signer control. Envelope page > Checks on the file (closed) and History line; Settings > Records and data shows one read-only status line for admins; /security explains. Shares one name and one place with gov-G05.
- Default: Off with no seal settings; the output is byte for byte what it was.
- First sight: Someone opens the signed PDF in a PDF reader and sees the seal panel; the envelope page History says 'Digital seal added'.
- Words: Digital seal, trusted time stamp. Admin line: 'Digital seal (PAdES): PDF readers show if the file changed after signing.' Avoid PAdES, PKI, CMS, RFC 3161 elsewhere.
- Never: A signer step or wait, a sender choice, any 'qualified' or 'certified' wording unless the registry says held.

**ds-mail-records** (Archive copies of every email, and encrypted hand-over to the mail server)

- Lives: Settings > Records and data > 'Copies of every email' (admins), up to 5 addresses. Require TLS is an operator setting with no screen. Never in the editor or on the envelope page.
- Default: Off, no addresses.
- First sight: An admin adds an archive address and reads 'We sent a link to confirm it. Copies start once it is confirmed.'
- Words: Copies of every email. Avoid BCC, journaling, TLS on screens.
- Never: A copy address field per document, a notice to senders or signers.

**ds-templates-lib** (Ready-made templates for charities and small public bodies)

- Lives: Templates page: 'Start from a ready-made one' as the empty state and as a link next to New template, opening a list inside Templates. Never on Home or in the editor's step 1.
- Default: Available; nothing is added to the account until someone picks one.
- First sight: An account with no templates sees 'Start from a ready-made one: volunteer agreement, consent form, ...' on Templates.
- Words: Ready-made templates; note 'A starting point written by GrowSigning, not legal advice.' Avoid library, gallery.
- Never: A popup, a step before the first send, ready-made templates in the send flow.

**ds-sec-log** (A security record for admins, with alerts and export to a security system)

- Lives: Settings > Security > 'Security record' (admins), with Alerts and 'Send to your security system' in that card's More options. Same place as gov-G12. Never for members, never in the sidebar or on the envelope page.
- Default: Recording always on and invisible to everyone else; export off until an admin sets a destination.
- First sight: An admin opens Settings > Security and sees 'Who signed in and what changed', newest first, with a search box.
- Words: Security record, Alerts, Send to your security system (SIEM). Avoid events, syslog outside the destination form.
- Never: Notices or lines in senders' or signers' screens, a new step at sign-in.

**ds-retention** (Keep documents for a set time, then delete them; legal holds; redaction)

- Lives: Settings > Records and data > 'Keep and delete', 'Holds', 'Deletion record' (admins). Envelope page More: Keep it, Hold (admins), Delete now; the status line shows the delete or hold date. Same place as gov-G11.
- Default: Off: nothing is deleted automatically.
- First sight: An admin sees 'Delete closed documents after [ ] days (off)' with one line on what stays. A sender first meets it in the 14-day email.
- Words: Delete after, Keep it, Hold (never delete), Deletion record, Remove names and answers. Avoid retention policy, purge, disposition, redact.
- Never: A choice in the editor, a banner on the envelope page, a confirmation on the signing page.

**ds-custom-fields** (Case numbers and other details on each envelope (custom fields))

- Lives: Settings > Sending > 'Details on each document' (admins define). Editor step 3 shows the details only when defined; envelope page Details section; Documents filter in More options. Never on the signing page or steps 1 and 2.
- Default: None defined, nothing shown anywhere.
- First sight: A sender in an account with details sees 'Case number' on the review step, prefilled from the template when it has one.
- Words: Details (each by its own name, like Case number). Avoid custom fields, metadata, envelope fields.
- Never: A required detail unless the admin marked it required, anything on signer screens.

**ds-channels** (WhatsApp delivery and codes by phone call)

- Lives: Editor person More > 'How they get it': Email, Text, WhatsApp, I will send the link myself. Signing page code screen: 'Call me with the code' under the code box. Both only when the operator set them up.
- Default: Off until set up; email stays the default.
- First sight: A sender sees 'WhatsApp' as one more choice in 'How they get it', with the tick 'They agreed to get messages about this by WhatsApp'.
- Words: WhatsApp, Call me with the code. Avoid channel, voice OTP, Business API.
- Never: A choice on the main person row, a second phone field, WhatsApp and text together for one person.

**ds-self-host** (Run it yourself: a kit for public bodies, and the evidence auditors ask for)

- Lives: No app screens. README 'Running it yourself', the container files, /api/health, /.well-known/security.txt and a 'Report a weakness' page linked from /security and the footer.
- Default: Hosted service unchanged; the container starts with safe defaults.
- First sight: An IT person reads 'Running it yourself' in the README.
- Words: Run it yourself, Report a weakness. Avoid compliance jargon on public pages.
- Never: A setup wizard in the app, anything in sender or signer screens.

**ds-reports** (Reports by template and sender, filters, export, and saved bulk lists)

- Lives: Sidebar More > Reports: date and status filters in one row, other filters in More options, Download CSV. Monthly email in Settings > Notifications (admins). Saved lists inside Send to many.
- Default: Last 30 days, all senders; monthly email off.
- First sight: Reports shows sent, finished and how long it took for the last 30 days, with a table by template.
- Words: Reports, Finished, Time to finish, Saved lists. Avoid completion rate, KPIs.
- Never: Charts or numbers on Home, a Reports entry in the sidebar's top part.

**ds-lang-signing** (Languages 2: the signing page in other languages)

- Lives: Signing page header: a language menu only when 2 or more languages ship; right to left automatic. Never a question before the consent.
- Default: The language the sender set, else the browser's among shipped ones, else English; menu hidden with one language.
- First sight: A French signer opens the link and the page is in French, with 'Français' in the header.
- Words: Language names in their own language. Avoid flags, locale.
- Never: A language step, flags, untranslated keys (fall back to English).

**ds-lang-mail** (Languages 3: emails, text messages and the public pages a signer uses)

- Lives: No new controls. Emails and texts follow the person's language; /check, /verify and signer help get the same header menu as the signing page.
- Default: As ds-lang-signing.
- First sight: The invitation email arrives in the person's language.
- Words: As ds-lang-signing.
- Never: Two languages mixed in one email, except the one sentence saying the legal part is in English.

**ds-consent-own** (The account's own consent text, in each language, with a way to withdraw)

- Lives: Settings > Sending > 'Your consent text' (admins), per language. Signing page consent screen: under our one sentence, behind 'Read <Org>'s terms' when longer than 60 words. Withdrawal in Other actions: 'Stop signing electronically'.
- Default: Off: our own short text only, once per document.
- First sight: A signer sees 'Read Acme's terms' above the one tick.
- Words: Your consent text, Read <Org>'s terms, Stop signing electronically. Avoid ERSD, disclosure.
- Never: A second tick, the full text open on a phone when it is long, ESIGN claims for our default text.

**ds-seal-ltv** (Seals that can be checked for years, and a time-stamped audit trail)

- Lives: No new control. Envelope page > Checks on the file says 'Can be checked for years'. Operator settings only. Shared with gov-G06.
- Default: Off unless the seal and a time stamp service are set; then automatic in the background.
- First sight: Checks on the file: 'Digital seal. Can be checked for years.'
- Words: Can be checked for years. Avoid LTV, B-LT, B-LTA, OCSP, CRL.
- Never: A sender choice, a signer wait beyond LTV_WAIT_MS in the background.

**ds-pdfa** (Archive copies in PDF/A)

- Lives: Settings > Records and data > 'Archive format (PDF/A)' switch (admins), listed only when the operator installed the checker. Result in Checks on the file and on the signing record.
- Default: Off.
- First sight: An admin sees 'Make completed files PDF/A, an archive format some archives require.'
- Words: Archive format (PDF/A). Avoid veraPDF on sender screens except the checked line.
- Never: A per-document choice, calling a file PDF/A unless the check passed.

**ds-eseal** (An organisation's own electronic seal on its documents)

- Lives: Settings > Stamps and seals > 'Organisation seal' (admins upload the certificate and choose who may use it). Editor step 2 > More fields > Organisation seal, only for allowed members.
- Default: Off: no certificate, nothing in the editor.
- First sight: An allowed sender finds 'Organisation seal' in More fields.
- Words: Organisation seal; admin line 'eSeal: a certificate in your organisation's name.' Avoid PKCS#12 except on the upload control.
- Never: A place in the six common fields, a signer action.

**ds-sec-policy** (Password, idle time and session rules for a team)

- Lives: Settings > Security > 'Sign-in rules' (password length, sign out when idle, one session at a time). The leaked-password check runs at sign-up and password change with a plain error. Signing page: 'Still there? Continue' after 30 idle minutes.
- Default: Length 8, idle sign-out off, one session off, leaked-password check on.
- First sight: Someone choosing a leaked password reads 'This password has appeared in a data leak. Choose another one.'
- Words: Sign-in rules, Sign out after [ ] minutes of no use, One session at a time. Avoid session timeout, HIBP, compromised credentials.
- Never: Forced expiry, character-mix rules, extra sign-up fields, a lost answer on the signing page.

**ds-page-tools** (Remove, turn and move pages before sending)

- Lives: Editor step 1, the document row: 'Pages' opens thumbnails with Remove, Turn and moving by drag or arrow keys, with Undo.
- Default: Available, closed.
- First sight: 'Pages' on the document row after upload.
- Words: Pages, Remove, Turn, Move. Avoid rotate, delete page.
- Never: Thumbnails open by default, a fourth editor step.

**ds-paper** (Sign on paper and send back a scan)

- Lives: Signing page Other actions: 'Print, sign by hand and send a photo'. Editor person More > How they sign: paper allowed or required. Settings > Sending default. Envelope page main button 'Look at the scan' when one arrives.
- Default: Allowed for signers and approvers, offered only inside Other actions.
- First sight: A signer who cannot sign on screen finds it in Other actions.
- Words: Sign on paper, Look at the scan, Accept as signed by <name>, Ask again.
- Never: A choice on the consent screen's main area, an extra tap for people who sign on screen.

**ds-id-small** (Safer access codes, numbers the signer gives, and the in-person host's ID statement)

- Lives: Editor person More > Check who signs > Access code: 'Code set', 'Set a new code', 'Make one for me'. Settings > Sending > Access code rules and the in-person ID question. In-person host answers one question before handing over.
- Default: Codes stored safely without anyone noticing; minimum length 4; host question 'Which ID did you see?'.
- First sight: A sender sees 'Code set' where the code used to be shown.
- Words: Access code, Make one for me, Which ID did you see?
- Never: Showing a stored code, a new step for people who sign by link.

**ds-sso-oidc** (Single sign-on for an organisation, with its email domains claimed)

- Lives: Settings > Security > 'Single sign-on' (one card for OpenID Connect and SAML, the provider type chosen inside) and 'Your email domains'. Login page: email first, then 'Continue with <Org> sign-in'. Same card as gov-G08 and ds-sso-saml-scim.
- Default: Off; the login page is unchanged.
- First sight: A member types their work email on the login page and sees 'Continue with Acme sign-in'.
- Words: Single sign-on, Your email domains, Continue with <Org> sign-in. Admin line: 'OpenID Connect or SAML 2.0: the standard your sign-in service uses.'
- Never: A separate SSO login page, jargon on the login page, a button when nothing is set up.

**ds-timing** (Send later, pause, and wait between steps)

- Lives: Editor step 3 More options: Send later. Person More: Wait before this person. Envelope page: Pause and Resume in More; when scheduled the status says 'Sends at 9:00 on 3 December' and the main button is Send now.
- Default: Send now, no waits.
- First sight: The Send button reads 'Send at 9:00 on 3 December' once a time is chosen.
- Words: Send later, Pause, Resume, Wait 2 days before this person. Avoid scheduled, delayed routing.
- Never: A date picker on the main review screen, a second send button.

**ds-fields-checks** (Field checks: formats, limits, number ranges and tick-box groups)

- Lives: Editor field panel > More options > Format and limits (letters only, postcode, my own pattern with my own error, min and max, currency, character limit, hide what they type). Checkbox group rules in the group's panel.
- Default: No format.
- First sight: A sender opens More options on a text field and sees 'Format: None'.
- Words: Format, My own pattern, Hide what they type (shows dots, it is not encryption). Avoid regex, mask, validation.
- Never: Controls in the main field panel, patterns shown to signers, errors without the fix ('Type 5 digits, like 12345').

**ds-a11y** (Accessibility for public bodies: check, fix, publish a statement, read scanned pages)

- Lives: No new controls. Statement at /accessibility (footer). Text for scanned pages made automatically when the operator set OCR. Shared with gov-G04.
- Default: On everywhere.
- First sight: A screen reader user signs without help; a buyer reads the statement in the footer.
- Words: Accessibility.
- Never: A separate accessible mode, anything that needs a mouse, colour alone for a state.

**ds-preview** (See what a recipient will see before sending)

- Lives: Editor step 3: 'See what they see' next to each person in 'Who gets it'; opens a new tab with a 'Preview, nothing is sent' band.
- Default: Available.
- First sight: The link next to each person on the review step.
- Words: See what they see. Avoid preview mode, recipient view.
- Never: A required preview, a dialog inside the editor.

**ds-switches** (Switches for senders and admins)

- Lives: Settings > Sending: pass it on, questions and comments, ways to make a signature, words across unfinished copies (account defaults). Editor step 3 More options per document. Settings > Stamps and seals: members may place stamps. Form limits on each form.
- Default: Each switch keeps today's behaviour; words across copies off.
- First sight: An admin sees the switches as plain sentences in Settings > Sending.
- Words: People may pass it to someone else, Allow questions and comments, Ways to make a signature, Words across unfinished copies. Avoid watermark, adoption.
- Never: Switches on the signing page, a hidden option without a line telling the signer why it is missing when they look for it.

**ds-supplements** (Extra documents to open or acknowledge)

- Lives: Editor step 1, document More: 'To read, not sign' with None, Must open, Must tick 'I have been given'. Signing page: 'Also for you: Privacy notice' above the document.
- Default: Off: every document is to sign.
- First sight: A signer sees 'Also for you: Privacy notice (open)'.
- Words: To read, not sign; Also for you. Avoid supplemental.
- Never: An extra required tap unless the sender chose must open or must tick.

**ds-visibility** (Each person sees only their documents)

- Lives: Editor step 3 More options: 'Each person sees only the documents with their fields', with ticks per person; shown only with 2 or more documents. Account default in Settings > Sending.
- Default: Off: everyone sees every document.
- First sight: A sender with two documents finds the switch in More options.
- Words: Each person sees only their documents. Avoid visibility, private.
- Never: The option on one-document sends, any notice on signer screens.

**ds-witness-two** (Up to two witnesses for one signer)

- Lives: The existing witness role in a person's More; the witness block offers 'Add a second witness'.
- Default: One witness, as today.
- First sight: 'Add a second witness' under the first witness block.
- Words: Witness, Add a second witness.
- Never: More than two, anything for signers with no witness.

**ds-id-login** (Confirm who signs with a login they already have)

- Lives: Settings > Connections > Identity checks for signers (admins add providers; operator providers appear by themselves). Editor person More > Check who signs, listing only what is set up. Signing page: one 'Prove who you are with <scheme>' screen after consent. Shared with gov-G09, gov-G24, gov-G25.
- Default: Off, absent everywhere until a provider exists.
- First sight: A signer sees 'Prove who you are with BankID' and a single button.
- Words: Prove who you are with <scheme>, Keep the identifier. Admin: 'OpenID Connect provider: the standard your ID service uses.' Avoid IAL, AAL, eIDAS on signer screens.
- Never: Unconfigured provider names, a check the sender did not choose, keeping ID numbers unless the sender ticked it.

**ds-phone-app** (An installable app for phones, and cleaner camera scans)

- Lives: Home on phones: one dismissible line 'Add GrowSigning to your home screen'. Sharing a file into the app opens the editor step 1. Scan cleanup inside the photo-to-document step with 'Undo cleanup'.
- Default: On; the line shows once and is gone when dismissed.
- First sight: The one line on Home on a phone.
- Words: Add to your home screen, Undo cleanup. Avoid PWA, install app.
- Never: An install popup, anything on signing pages, caching any page with a token, a desktop banner.

**ds-reading-view** (A phone reading view that reflows the document)

- Lives: Signing page toolbar More > View: Page or Easy reading (replaces the Text view switch; one way). Folding sections only inside Easy reading.
- Default: Page view.
- First sight: A signer on a phone opens More and sees 'Easy reading'.
- Words: Easy reading, Page. Avoid reflow, responsive signing, smart sections.
- Never: A new switch on the toolbar's first row, folding the start of the document.

**ds-lang-first** (Languages 4: the first languages)

- Lives: No new UI: the languages appear in the existing menus; 'Report a wrong word' inside Help on the signing page.
- Default: Only languages that passed review are offered.
- First sight: A signer finds their language in the header menu.
- Words: Report a wrong word.
- Never: Machine-translated legal text, a draft language without the 'checked by a person' fallback sentence.

**ds-qtsp** (Advanced and qualified signatures through a trust service provider)

- Lives: Settings > Connections > 'Signing with a certificate' (providers the operator set up). Editor person More > How they sign. Signing page: at Sign, 'Sign with your <provider> certificate' replaces the signature dialog. Result in Checks on the file. Shared with gov-G16.
- Default: Off, hidden.
- First sight: A signer sees 'Sign with your Namirial certificate' and goes to the provider and back.
- Words: Sign with your <provider> certificate. Admin: 'Qualified signature (QES) through <provider>, a trust service on the EU list.'
- Never: QES or AES letters on signer screens, a 'qualified' badge unless the check said so, options that are not set up.

**ds-cloud-pick** (Pick files from Google Drive, Dropbox, OneDrive and Box)

- Lives: Editor step 1, under the drop zone: up to 4 small 'From Google Drive' style buttons, only for sources the operator set up and the admin allowed (Settings > Connections > File sources).
- Default: Hidden.
- First sight: 'From Google Drive' under 'Choose a file'.
- Words: From Google Drive, From Dropbox; 'We only get the file you pick.'
- Never: A sign-in prompt before picking, stored tokens, buttons for sources not set up.

**ds-write-doc** (Write a simple document in the app)

- Lives: Editor step 1 More options: 'Write a document here', which replaces the drop zone with a plain text page with headings, lists and bold, and 'Add a place to sign' buttons that insert the tags.
- Default: Closed.
- First sight: 'Write a document here' in step 1 More options.
- Words: Write a document, Add a place to sign. Avoid tags, {{signature}} as the only way.
- Never: A full word-processor toolbar, a fourth editor step.

**ds-colleagues** (Working for a colleague: shared access, moving envelopes, sending on someone's behalf)

- Lives: Settings > Away and sharing: share my documents with a colleague, given and received. Envelope page More: Move to a colleague. Editor step 3 More options: Send for <name>, only when someone shared sending with you. Documents filter 'Shared with me'. Settings > Team: move a member's documents.
- Default: Nothing shared.
- First sight: A member opens Settings > Away and sharing and sees 'Share my documents with a colleague'.
- Words: Share with a colleague, Move to a colleague, Send for Ben Okoro; recipients read 'Ben Okoro (sent by Ana Silva)'. Avoid on behalf of, transfer ownership.
- Never: A sender picker on step 1, a sidebar entry.

**ds-delegate** (Someone who signs for you while you are away)

- Lives: Settings > Away and sharing > 'Someone signs for me while I am away', listed only when an admin allowed it in Settings > Team.
- Default: Off for the account.
- First sight: A person going on leave adds a name and dates.
- Words: While I am away; signer screens say 'Signing for Ana Silva'.
- Never: Anything for senders or signers when off, a saved signature offered to the delegate.

**ds-fields-kinds** (More kinds of field, and how filled-in text looks)

- Lives: Editor step 2 > More fields: Drawing, Approve and Decline buttons, date formula, saved fields; first or last name inside the Name field's options. Field panel More options: Look (font, size, colour, bold), Same answer as. Saved fields listed in Settings > Sending.
- Default: The six common fields are unchanged.
- First sight: New kinds appear in More fields.
- Words: More fields, Look, Same answer as, Saved fields. Avoid data label, formula field.
- Never: Growth of the common fields row, look options in the main panel.

**ds-id-docs** (Photo ID and liveness checks through a provider)

- Lives: Settings > Connections > Identity checks (provider). Editor person More > Check who signs > Photo ID check. Signing page: a plain screen first, then the provider.
- Default: Off.
- First sight: A signer reads what will be asked, who the provider is, how long pictures are kept, and 'Do not want to do this? Ask the sender for another way.'
- Words: Photo ID check, Photo ID and selfie. Avoid IDV, liveness, biometric except in the plain explanation.
- Never: A provider step without the plain screen and the way out.

**ds-webeid** (Signing with a national ID card (Web eID))

- Lives: Editor person More > How they sign: 'With an ID card', only when set up. Signing page: 'Sign with your ID card', with what to install when it is missing. Shared with gov-G23.
- Default: Off, hidden.
- First sight: A signer sees 'Sign with your ID card' instead of the signature dialog.
- Words: Sign with your ID card. Avoid Web eID, PKCS, PIN pad jargon on the main screen.
- Never: A card option the sender did not choose, a dead end without the other ways the sender allowed.

**ds-sso-saml-scim** (SAML sign-in and automatic user management (SCIM))

- Lives: Settings > Security: the same Single sign-on card (SAML chosen inside) and a 'Members from your directory' card; Team shows 'Members are managed by your directory' and hides Invite.
- Default: Off.
- First sight: An admin chooses 'SAML 2.0' inside the Single sign-on card.
- Words: Single sign-on, Members from your directory. Admin line: 'SCIM: your directory adds and removes members here.'
- Never: A second SSO card, SCIM words outside Settings > Security.

**ds-db-encrypt** (Encrypt more of the database)

- Lives: No app screens. /security and /security/processing list what is encrypted; the operator page warns when no key is set.
- Default: A key by default for new installs.
- First sight: An operator sees a warning on /app/operator when running without a key.
- Words: Encrypted stored data.
- Never: Any screen for senders or signers.

**ds-lang-sender** (Languages 5: the sender's editor, envelopes and emails)

- Lives: Settings > Profile > 'Language of your screens', listed only when a sender language ships.
- Default: The browser's language among shipped ones, else English.
- First sight: A sender sees the editor in their language.
- Words: Language of your screens.
- Never: A language question at sign-up.

**ds-lang-sender-rest** (Languages 6: the rest of the sender's app and the public pages)

- Lives: No new controls; the rest of the sender's app and public pages follow the same language. Operator screens stay English.
- Default: As ds-lang-sender.
- First sight: Settings and public pages in the person's language.
- Words: As ds-lang-sender.
- Never: Mixed languages on one screen apart from the sender's own words.

**ds-routing-if** (Send to different people depending on the answers)

- Lives: Editor person More > 'Only when...' (the same builder as a field's Only show when).
- Default: Off: everyone is asked.
- First sight: 'Only when Amount is more than 1000' under a person's name.
- Words: Only when...; History: 'Not asked: Ben, because Amount was 800.' Avoid conditional routing.
- Never: A flowchart editor, a new step, showing a skipped person as signed.

**ds-recipient-types** (People who change the envelope, name the next person, or update addresses)

- Lives: Editor person More > Role: 'Can change the document', 'Chooses the next person', 'Can update addresses', with one line under the chosen role.
- Default: Needs to sign.
- First sight: The new roles at the end of the role list.
- Words: Can change the document, Chooses the next person, Can update addresses. Avoid editor, agent, intermediary.
- Never: Roles on the main row, descriptions for every option at once.

**ds-web-forms** (Phone-first forms that fill in a document (web forms))

- Lives: Sidebar More > Forms (one list with links anyone can sign): New form from a template, public link and QR code. The person fills the form on a phone, then signs on the normal signing page.
- Default: No forms.
- First sight: Forms lists 'Fill-in form' next to 'Anyone with this link can sign'.
- Words: Form, Fill-in form. Avoid web form, PowerForm.
- Never: A separate sidebar entry, form set-up inside the send flow.

**ds-pay-collect** (Take a payment while signing)

- Lives: Settings > Connections > Take payments (when the operator set up the provider). Editor step 3 More options > 'Ask for a payment' (one control: take it here, or link to your own payment page, which keeps the pay link). Signing page: a Pay screen only for documents that ask for one.
- Default: Off.
- First sight: A sender finds 'Ask for a payment' in step 3 More options.
- Words: Ask for a payment, Pay. Avoid checkout, collect.
- Never: Two separate payment controls, card fields on documents that did not ask.

**ds-dev-api** (For developers: anchor tags in the API, signing inside your site, and the sender's screen in your app)

- Lives: Settings > Developers: Signing inside your site (origins), Sender screen in your app. Anchor tags through the API only.
- Default: Off.
- First sight: A developer adds an origin under Developers.
- Words: Signing inside your site. Avoid iframe, frame-ancestors on screen.
- Never: Anything outside Developers, embed settings for members.

**ds-offline-inperson** (Signing in person where there is no signal)

- Lives: The in-person signing flow on the host's installed app: a line 'Saved on this device. It is sent when you are back online.'
- Default: Automatic for in-person signers when the app is installed; no switch.
- First sight: The host sees that line when the signal drops.
- Words: Saved on this device. Avoid offline mode, sync.
- Never: Offline for people signing by link, a choice before the host starts.

**ds-perm-profiles** (Permission profiles and groups of users)

- Lives: Settings > Team > More options: 'What each role can do' and 'Groups of members'. Custom roles appear in the existing role select on invite.
- Default: Owner, Admin and Member exactly as today.
- First sight: An admin opens More options on Team.
- Words: What each role can do, Groups of members. Avoid permission profile, capability.
- Never: A second picker on invite, changes to existing accounts.

**ds-part11** (Signing by people with an account: sign in to sign, a second check at Finish, reasons, names under signatures)

- Lives: Settings > Sending > 'Strict signing' (account default, admin line 'Used for 21 CFR Part 11'). Editor step 3 More options: People must sign in to sign. Signing page: sign-in screen, a reason at each signature, a password check at Finish.
- Default: Off.
- First sight: An admin finds 'Strict signing' in Settings > Sending.
- Words: Strict signing, Reason for signing, Sign in to sign. Avoid Part 11 on signer screens.
- Never: On by default, extra steps for documents that did not ask.

**ds-ai-assist** (AI help when sending and signing: suggested fields, a plain summary, a drafted message)

- Lives: Settings > Account > AI card: 'Let the AI read document text'. Editor step 2: one 'Place fields for me' button (tags first, AI suggestions when allowed). Step 3: 'Draft a message' and in More options 'Plain summary for signers'. Signing page toolbar More: Summary, only when the sender switched it on.
- Default: AI reading document text off; Draft a message uses only names and people.
- First sight: A sender sees 'Draft a message' next to the message box.
- Words: Draft a message, Place fields for me, Summary (written by AI, check it). Avoid AI assistant, LLM.
- Never: Suggestions applied without the sender, a summary presented as the document, AI words in the signed record.

**ds-ai-repo** (Find dates and duties in signed agreements, with reminders)

- Lives: Sidebar More > Key dates, only when AI may read documents; envelope page Details: 'Ends on 3 March 2027 (found by AI, check it)'.
- Default: Off.
- First sight: Key dates lists completed documents with their end and renewal dates and 'Remind me'.
- Words: Key dates, Remind me, found by AI, check it. Avoid repository, extraction, obligations.
- Never: A Home widget, reminders switched on without the person.

**ds-tpl-combine** (Combine templates, and find the right template for an upload)

- Lives: Templates > Use dialog: 'Add another template'. Editor step 1: one line after upload 'This looks like your template Volunteer agreement. Use it?'.
- Default: Matching on as a single dismissible line; combining only when asked.
- First sight: The one line after upload.
- Words: Add another template, Use it? Avoid composite, matching.
- Never: Applying a template by itself, a picker before upload.

**ds-collab-fields** (Fields everyone on the envelope can fill in)

- Lives: Editor field panel: Assigned to gains 'Anyone on the document'. Signing page shows who last changed it.
- Default: One person per field.
- First sight: 'Anyone on the document' at the end of Assigned to.
- Words: Anyone on the document can fill it in. Avoid collaborative.
- Never: A new field kind in the common row.

**ds-notary** (Notarisation: a partner for remote notarisation, and a notary in the room)

- Lives: Settings > Connections > Notary (partner set up by the operator). Editor person More > Role: Notary. A notary flow only for documents that chose it.
- Default: Hidden until set up.
- First sight: A sender finds 'Notary' in the role list.
- Words: Notary, Notarise.
- Never: Notary words in normal sends.

**ds-regions** (Choose where an account's data lives)

- Lives: Settings > Records and data > 'Where your data is kept' (read-only line). A region select at sign-up only when the operator offers 2 or more regions.
- Default: One region; no question.
- First sight: The read-only line in Records and data.
- Words: Where your data is kept. Avoid data residency.
- Never: A region question with one region.

**ds-cmk** (Keys the customer holds)

- Lives: Settings > Security > 'Your own encryption key' (owner only). Same card as gov-G22.
- Default: Off: the server's key.
- First sight: The owner sees 'Use your own encryption key' with the key services listed.
- Words: Your own encryption key. Admin line: 'KMS or HSM: the service that holds your key.' Avoid CMK, KEK, wrap.
- Never: Anything for senders; a revoked-key screen that is not plain ('The documents of Acme cannot be opened right now because their key is not available.').

**gov-G01** (Honesty guard and tenant switches: no false certification claims, trees and AI kept out of the legal record)

- Lives: Settings > Account: 'Trees on screens and emails', 'Impact lines on the certificate', and the AI helper switch. Public /security/certifications built from the registry, linked from /security and the footer.
- Default: Trees on, AI helper on; impact lines on the certificate per owner decision 8; every certification 'not held'.
- First sight: A buyer reads 'We do not hold an ISO/IEC 27001 certificate.' on /security/certifications.
- Words: Certifications; one sentence per entry from claimText.
- Never: Badges, claims not in the registry, tree or AI words in the signed record.

**gov-G02** (Sovereign single container: any cloud, on premises or air-gapped, no call home, outbound allowlist, backups)

- Lives: Operator only: README 'Running it yourself', the container and chart, /api/health, /app/operator.
- Default: Outside services off in sovereign mode; email recorded as 'Not emailed' without a relay.
- First sight: An operator reads the README section.
- Words: Run it yourself.
- Never: An in-app setup wizard, any sender or signer screen.

**gov-G03** (Procurement pack: SBOM, security whitepaper, control self-mapping, sub-processors, DPA template, exit plan, disclosure policy)

- Lives: Public /procurement and /security/subprocessors, linked from /security and the footer's Trust group.
- Default: Published; sub-processors list only what is switched on.
- First sight: A buyer downloads the documents from /procurement.
- Words: Procurement documents, Sub-processors.
- Never: Anything in the app.

**gov-G04** (Accessibility conformance: WCAG 2.2 AA and EN 301 549, tested, fixed, with an honest conformance report and accessibility statement)

- Lives: No new controls; /accessibility statement and conformance report in the footer. Same work as ds-a11y.
- Default: On everywhere.
- First sight: A buyer reads 'Self-assessed on <date>... Not audited by a third party.'
- Words: Accessibility statement.
- Never: An accessible mode, claims beyond the self-assessment.

**gov-G05** (PAdES seal of the operator (B-B and B-T) with a key in a file or an HSM, and RFC 3161 timestamps)

- Lives: Same as ds-seal: no sender or signer control; Checks on the file; status line in Settings > Records and data; operator settings for the key or HSM.
- Default: Off without settings.
- First sight: The seal panel in a PDF reader.
- Words: Digital seal, trusted time stamp; admin 'PAdES' with its one line.
- Never: A second seal setting next to ds-seal, 'qualified' unless held and in the certificate.

**gov-G06** (Long-term validity: PAdES B-LT and B-LTA, re-timestamping on a schedule, PDF/A-3 with the audit trail embedded)

- Lives: Same as ds-seal-ltv and ds-pdfa: Checks on the file; the PDF/A switch in Settings > Records and data; operator settings for re-time-stamping.
- Default: Off without settings; re-time-stamping every 180 days when on.
- First sight: 'Can be checked for years. Archive format PDF/A-3.'
- Words: Can be checked for years, Archive format (PDF/A).
- Never: A sender choice, a wait for signers.

**gov-G07** (Validate signed PDFs and keep signatures already in uploaded files)

- Lives: Public /verify 'Check a signed document' (one page for both questions). Editor step 1: one line under a file that already has signatures. Envelope page Checks on the file.
- Default: On.
- First sight: Someone drops a PDF on /verify and reads 'Signature intact' or 'Changed after signing'.
- Words: Check a signed document, Signature intact, Changed after signing, Could not check. Avoid DSS, ETSI, indication on screen (the report is a download).
- Never: A second verify page, a technical report on screen.

**gov-G08** (Single sign-on for staff: any OpenID Connect provider and SAML 2.0, per tenant, enforced, with role mapping)

- Lives: Same Single sign-on card as ds-sso-oidc in Settings > Security, with role mapping in its More options; how you signed in under Settings > Sign-in and security.
- Default: Off; IdP-started sign-in refused.
- First sight: 'Continue with <Org> sign-in' on the login page.
- Words: Single sign-on, How you signed in.
- Never: A second SSO screen, a login page with more buttons when nothing is set up.

**gov-G09** (Signer identity through national eID (OIDC and SAML, eIDAS nodes) with assurance levels recorded per signer)

- Lives: Same as ds-id-login: Check who signs in the person's More; one 'Prove who you are with <scheme>' screen; operator-configured providers.
- Default: Off, hidden.
- First sight: 'Prove who you are with GOV.UK One Login'.
- Words: Prove who you are with <scheme>; the level only on the signing record ('level substantial, as declared by the operator').
- Never: Levels or NIST terms on signer screens, an ID number shown unless the sender chose it.

**gov-G10** (Jurisdiction rules engine: the minimum signature level per country and document type, enforced and recorded)

- Lives: Settings > Sending > 'Signature level rules' (admins, default country). Editor step 3: one prefilled line 'For: Kenya, employment contract. Change', only when rules are on.
- Default: Off unless an admin set a default country or the deployment is government; nothing blocked except what cannot be done electronically.
- First sight: A sender sees the prefilled line and sends without touching it.
- Words: For: <country>, <document type>; blocks say what to do ('This needs a qualified signature. Set up signing with a certificate under Settings, Connections.'). Keep 'not reviewed by a lawyer'.
- Never: A required question when off, legal advice, hiding the not-reviewed line.

**gov-G11** (Records: retention schedules, legal hold, disposition with a record of destruction, archive export)

- Lives: Same as ds-retention in Settings > Records and data: schedules, Holds (by search, folder, person or dates), Deletion record; the records officer role in Team.
- Default: Off; a hold blocks every deletion path.
- First sight: An admin places a hold with a reason and a matter reference.
- Words: Delete after, Hold (never delete), Deletion record, Records officer.
- Never: A second records screen, anything in the send flow.

**gov-G12** (Security event log and export to a SIEM (syslog, HTTPS JSON lines, pull API))

- Lives: Same as ds-sec-log: Settings > Security > Security record > Send to your security system; pulling it in Settings > Developers.
- Default: Recording on; delivery off; email addresses left out unless the account turns them on.
- First sight: An admin enters a syslog or HTTPS destination.
- Words: Send to your security system (SIEM: Splunk, Elastic, Sentinel).
- Never: A second security log, anything for members.

**gov-G13** (Multi-agency tenancy: a government above its agencies, delegated admin, inherited policies)

- Lives: Settings > Organisation, only for organisation admins: agencies, policies passed down, delegated admin. Settings set above show 'Set by Ministry of X' where they appear.
- Default: Absent for normal accounts.
- First sight: An organisation admin sees the list of agencies.
- Words: Organisation, Agencies, Set by <name>. Avoid tenant, org.
- Never: Organisation words for normal accounts, settings that change without saying where from.

**gov-G14** (Government billing mode, a public price list per deployment, the tree commitment, and a total-cost calculator)

- Lives: Settings > Plan becomes one line in deployment billing mode; public /pricing/government in the footer.
- Default: Signatures mode (the consumer plan).
- First sight: An agency admin reads 'This service is provided under <holder>'s agreement <ref>, valid until <date>.'
- Words: Government prices.
- Never: Signature counts, expiry or top-ups in deployment mode.

**gov-G15** (Many languages: a message catalogue and the signer side in English and French first)

- Lives: Same as ds-lang-core and ds-lang-signing: the per-person language in the person's More and the header menu on the signing page; LANGUAGES_ENABLED for the operator.
- Default: English only.
- First sight: A French signer sees the page in French.
- Words: Language names in their own language.
- Never: A second language system, a language step.

**gov-G16** (Signers sign with their own certificate: remote signing through the Cloud Signature Consortium API (QTSP), giving AdES or QES)

- Lives: Same as ds-qtsp: How they sign in the person's More; 'Sign with your <provider> certificate' on the signing page; services set up by the operator.
- Default: Off, hidden.
- First sight: A signer goes to the provider and comes back signed.
- Words: Sign with your <provider> certificate; the level only on the signing record.
- Never: QES on signer screens unless validated, a second certificate-signing setting.

**gov-G17** (Signing inside the government's own portal, white label, portal-asserted identity, and verified sender domains)

- Lives: Settings > Account: 'Your name on emails and pages' and 'Sending domain' with a DNS check. Settings > Developers: Signing inside your portal. A verified badge on the signing page only for verified domains.
- Default: Off; the signing record always names the operator.
- First sight: A citizen signs inside the agency's own portal under the agency's name.
- Words: Your name instead of ours, Sending domain, Verified. Avoid white label.
- Never: Hiding the operator on the signing record, a badge for unverified domains.

**gov-G18** (Assisted signing at a counter: an official helps a citizen sign, with the identity check and accommodations recorded)

- Lives: Sidebar More > Counter, only for people with the counter permission; the citizen's screen opens by a short code or QR code.
- Default: Absent.
- First sight: An official sees today's in-person queue.
- Words: Counter, Start, Pair a screen; every screen says the software cannot check an ID document.
- Never: A Counter entry for others, citizen field values on the official's screen unless allowed.

**gov-G19** (Full export with a published schema, round-trip import, and import from DocuSign)

- Lives: Settings > Records and data: 'Export everything' (full, with the schema) and 'Bring in documents' (from an export or from DocuSign).
- Default: Available to owners and admins; large exports by email link.
- First sight: An admin presses Export everything and gets an email when it is ready.
- Words: Export everything, Bring in documents.
- Never: Import on Home or in the editor.

**gov-G20** (AI helper in government mode: self-hosted open-weight model inside the boundary, switchable per tenant, nothing kept)

- Lives: Operator settings for the model; the Account AI helper switch; inside the Help panel one small line 'Answers come from <model> on <host>'.
- Default: Hosted models never used in sovereign or government mode; tenant switch on.
- First sight: The model line at the foot of the Help panel.
- Words: Help; Answers come from <model> on <host>.
- Never: A help button when the switch is off, a hosted model in sovereign mode.

**gov-G21** (FIPS crypto mode and HSM keys through PKCS#11)

- Lives: Operator only; one line on /security.
- Default: Off.
- First sight: An operator sets FIPS_MODE.
- Words: (operator docs only)
- Never: Any app screen.

**gov-G22** (Customer-held keys: a per-tenant key hierarchy in the customer's KMS or HSM, and database field encryption)

- Lives: Same card as ds-cmk: Settings > Security > Your own encryption key.
- Default: Off: derived from the server key as today.
- First sight: The owner connects their key service.
- Words: Your own encryption key.
- Never: A second key screen, anything for senders.

**gov-G23** (Smart cards: PIV and CAC sign-in through the browser, and signing with a national eID or PIV card through Web eID)

- Lives: Login page: 'Sign in with a smart card' only when set up; Settings > Security > Sign-in rules: smart card required. Signing with a card is the ds-webeid option.
- Default: Off, hidden.
- First sight: A staff member taps 'Sign in with a smart card'.
- Words: Sign in with a smart card, Sign with your ID card. Avoid PIV, CAC on the login page.
- Never: A card button when not set up.

**gov-G24** (EUDI Wallet relying party pilot: identity through OpenID4VP with PID, behind a flag)

- Lives: Same as ds-id-login: 'EU Digital Identity Wallet' appears in Check who signs only with the pilot switch on.
- Default: Off.
- First sight: A signer sees 'Prove who you are with your EU Digital Identity Wallet'.
- Words: EU Digital Identity Wallet. Avoid OpenID4VP, PID.
- Never: A wallet option without the pilot flag.

**gov-G25** (National signing connectors: a connector framework and the first connector for the owner's first country)

- Lives: Same as ds-id-login and ds-qtsp: a national connector appears as one more provider once the operator set it up; operators see 'not tried against <scheme>' on /app/operator.
- Default: Hidden.
- First sight: A signer sees 'Sign with Smart-ID'.
- Words: The scheme's own name.
- Never: Unconfigured connectors, test status shown to signers.

**gov-G26** (Scale proof and high availability on SQLite, object storage for files, and the Postgres question answered with numbers)

- Lives: Operator only: settings and the README write-up.
- Default: Files on disk.
- First sight: An operator reads the measurements.
- Words: (operator docs only)
- Never: Any app screen.

**expiry** (Signatures expire like Claude usage (plan resets monthly, top-ups 12 months))

- Lives: Settings > Plan top card: '6 of 9 left. They reset on 3 December at 14:00.', top-ups each with its date, the rule behind 'How signatures work'. The usage line under the account name. Editor step 3: one line only when this send would run out.
- Default: The rule applies to the consumer plan; signatures that end soonest are used first.
- First sight: The Plan card and the usage line.
- Words: left, reset on, top-up signatures last 12 months. Avoid credits, lots, ledger.
- Never: Countdown banners, a warning on every page, expiry words to signers.

**impact** (Signers told 10 mangroves are planted; first-send and first-sign animation)

- Lives: Signing page: one line near the top of the consent screen and one next to Finish (paid signatures, signers only). Done screen and the envelope page after the first send: the celebration plays in place. /impact and Trees planted.
- Default: On (the Account switch from gov-G01 turns it off).
- First sight: A signer reads '10 mangroves will be planted when you finish. Rosa pays, not you.'
- Words: 10 mangroves, Trees planted, 10 more mangroves. Avoid figures under 1 tree.
- Never: A modal to close, a delay, tree words to approvers, viewers or copies, or when the switch is off.

**chat** (AI helper that answers at once, with a person one click away)

- Lives: One Help entry per screen (sidebar bottom in the app, header on the signing page, top bar on public pages) opening a panel with the question box first; 'Talk to a person' under every answer.
- Default: Model answers when a key is set, built-in answers otherwise; both answer 'I cannot sign today' with Finish later and Ask for more time buttons.
- First sight: The question box with three suggested questions for that screen.
- Words: Help, Talk to a person; one line 'Answers are written by AI and can be wrong. Do not type passwords or card numbers.'
- Never: A floating bubble over buttons, disclaimers longer than one line above the box, asking again for a name or email the page knows.

**stamp** (Upload a stamp design that looks like a real rubber stamp)

- Lives: Settings > Stamps and seals (account stamps). Editor step 2 > More fields > Stamp. Signing page: the stamp dialog for a stamp field.
- Default: Available; members may place stamps.
- First sight: An admin uploads a photo of a stamp and sees the before and after.
- Words: Stamp, Add a stamp, Ink colour. Avoid impression, blend.
- Never: A stamp in the six common fields, a stamp step for a signer without a stamp field.
---

## 7. Quick wins on what exists today

From the baseline problems, worth doing before the new features land. Each one lowers a ceiling in section 3.

1. Confirm the email address without leaving the tab: a 6-digit code in the email that can be typed in the same
   tab, and the sign-up tab notices the confirmation and drops the yellow banner by itself. Email of 50 words or
   fewer, with no browser or password advice.
2. One start button. Remove "Send for signature", "Send your first envelope" and "Sign a document yourself" from
   Home; keep the sidebar's "Send a document" (with "Add me" in the editor for signing yourself). Home shows
   "Recently completed" with Download on each row.
3. Sidebar from 14 entries to 9: rename Envelopes to Documents and Inbox to To sign; Bulk send, PowerForms,
   Click-to-agree, Reports and Our impact go into a closed "More" group; "Ask for help" and "Help" become one Help.
   Show nothing while the Paper saved card loads instead of "...".
4. Editor step 1 starts with one empty person row (Name, Email), the email box wide enough for a full address, and
   the role select, "I will send the link myself" and the other per-person options inside the person's More.
5. Move "Remind every", "Expires after", the date format and the message to step 3; reminders asked once, with one
   control, in step 3 More options; the time-zone note becomes one line.
6. Title-case the document name from the file name ("planting-partnership.pdf" becomes "Planting partnership") so
   the subject, title bar, lists and downloaded file read well.
7. Step 2: six common fields plus "More fields"; field panel shows Assigned to, Required and Label, with everything
   else in More options; keyboard help behind Help; "Find fields for me" without the tag jargon on screen.
8. Envelope page: one main button by state; the person's six buttons into one More (except for people whose link
   the sender shares); comments, History and emails folded; no IP addresses or hashes on the page; the "Sent" toast
   at the bottom, never over buttons; the sidebar counter refreshes after sending.
9. Completed documents: one Download (signed PDF with its signing record); the evidence pack becomes "Full record
   for disputes" in More; the header keeps at most two buttons so the title stays on one line.
10. Signing page: Next jumps to the field and opens it; the "Sign here" bubble never covers a label; zoom, view,
    download and comments move into the toolbar's More so the document starts in the top fifth of a phone screen.
11. Consent screen: 120 words or fewer before the tick, the sender named once, Other actions already offering Finish
    later, at most 6 options with no descriptions, and the deadline in the signer's own time.
12. Rename "Adopt your signature" and "Adopt and sign" to "Your signature" and "Sign"; skip "Check before you
    finish" when nothing needs attention.
13. Help: the question box first with one line of caution; the built-in answers cover "I cannot sign today" with
    Finish later and Ask for more time buttons; "Talk to a person" carries the name and email the page knows.
14. Invitation email: 80 words or fewer above the button; the security code, report link and fallback link in a
    short footer; dates in the person's own time.
15. Impact: no figure under 1 tree anywhere; the signer's line is "10 mangroves will be planted when you finish"
    only for paid signatures.
16. Landing page: 4 top links, at most 3 phone screenfuls and 800 words, the comparison and rules moved to /pricing
    and /help, live counters hidden until they show at least 1 tree.
17. Templates: Use on each row and the other five actions in the row's More; the intro without permissions text;
    the Use dialog without the reminder paragraph; after sending, the back link says Templates and a "Sent" banner
    shows as after a normal send.
18. Settings: split Profile into Profile and Sign-in and security; "Saved" next to the button that saved; the Plan
    rules behind "How signatures work"; the kept and deleted lists behind "What is kept"; the sending defaults move
    from Account to a Sending section.
