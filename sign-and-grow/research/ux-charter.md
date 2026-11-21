# GrowSigning UX charter

The owner asked: "build out all the features but make sure it's always user friendly and as simple and easy as
possible to use". This charter says where every feature goes, what it may and may not add, and how we check that
the core flows never get harder. It includes every correction and merge of the independent check (research/ux.json,
key "ux:check"); nothing in that check overrides this text any more.

Every engineer follows it. If a brief and this charter disagree on where something appears or what it is called,
the charter wins. Behaviour, rules and the record still come from the brief. If you think the charter is wrong, say
so in your report. Do not work around it.

Three files go together:

- this charter: the rules for every screen;
- research/ux-notes.json: one note per feature key (lives, default, first_sight, words, never, merged_into, gate);
- tests/ux/flows.cjs with tests/ux/ceilings.json: the check. Section 5 says how to run it.

---

## 1. Principles

Each principle has a test. "Script" means tests/ux/flows.cjs checks it by itself and names it in its "Rules"
output. A change that fails one is not finished.

**P1. The core flows never get longer.** The measured flows (section 3) never get more actions, screens, choices,
words or notices than their ceiling. They never get a new step, screen or choice unless the person or their admin
switched the thing on.
*Test (script):* every number at or under tests/ux/ceilings.json, in each of the three profiles.

**P2. Zero setup, good defaults.** A new account on a new server can sign up, send, sign and download with nothing
configured. Every setting has a default that works and is never asked for at first use. When unsure, the default is
what the product does today.
*Test (script):* the default profile runs on an empty DATA_DIR with only DEV_OUTBOX and APP_URL set.

**P3. Hidden until set up.** A feature that needs setting up does not appear until it is: no greyed-out button, no
"not configured", no upsell. Only /app/operator and the README list what is not set up. Every element that belongs
to a gated feature carries `data-feature="<key>"`; the gate of each key is in ux-notes.json:

| gate | with zero setup |
|---|---|
| operator | appears nowhere |
| admin | appears only inside /app/settings |
| docs | has no app screen: README, /app/operator and the public trust pages only |
| always | there |

*Test (script):* with zero setup, no `data-feature` element breaks its gate, and every key used is a key of
ux-notes.json.

**P4. One More per screen, one More per item, closed.** Three kinds of expander, each with its attribute:

- `data-more="screen"`: the screen's "More options". At most 1 per screen.
- `data-more="item"`: the "More" of one item (a person, a file, a field, a card, a row). The item carries
  `data-item` (Settings cards carry `data-item="card"`). At most 1 per item.
- `data-fold`: a folded content section (History, Checks on the file). Allowed.

All three are closed every time the screen opens. The one exception is the sidebar's More group,
`data-more="nav"`: it opens by itself on a page inside it and remembers being open for that person. No feature adds
an expander without one of these attributes, an extra tab, or a second panel to a core screen. Caps on the lines
inside an opened More: an item's More 6 with zero setup and 8 with everything set up; the envelope page's More 9;
step 3's More options 7; the role list 8; the signing page's Other actions 6.
*Test (script):* counts by attribute on every screen; the inventory opens every More and counts its lines.

**P5. One main button per screen.** The page body has at most one filled button (class `btn primary`): the thing
most people do next. A dialog counts on its own. The sidebar's start button and the phone bar's Send are not
counted. Switches and selects save as soon as they change, with "Saved" next to them; a card of text boxes gets a
secondary Save.
*Test (script):* filled buttons outside `aside` and `nav`, per screen and per dialog.

**P6. Plain words.** Every screen uses the words of section 4. A technical name appears only in an admin's Settings
or on the operator page, next to a plain name and a one-line explanation; never on a signer's screen and never on
the sender's daily path (the sidebar, Home, Documents, editor steps 1 to 3, the envelope page, Templates and emails
to senders). Sentences on signer screens are 20 words or fewer. Buttons start with a verb.
*Test (script):* the TECHNICAL and AVOID lists of section 4 on signer and public pages; sentence length on signer
screens.

**P7. A signer sees only what that signer needs.** The sender, the document, what to do, and the way out (Other
actions, Help). Never prices, plans, who pays, IP addresses, hashes, internal ids, other people's private notes,
sender-side settings, or explanations of features the sender did not use. A check appears only when the sender
chose it: at most one check screen and one trip to a provider per signer.
*Test (script):* the consent screen has 120 words or fewer before the tick, with every option on, and fits one
phone screenful; Other actions has at most 6 entries.

**P8. Admin and government features live in Settings.** Security, records, single sign-on, keys, organisations,
seals, rules, exports and connections live in Settings or on the operator page. Never in the sidebar's top part, on
Home, on the editor's default view, or as a main button on the envelope page. A government deployment
(DEPLOYMENT_PROFILE=government) changes defaults, not the layout.
*Test (script):* Home and the editor's three steps offer the same controls in the default and government profiles.

**P9. No popups the person did not open.** No tours, coach marks, "what's new", install prompts, timed "Still
there?" dialogs or anything that must be closed before going on. A hint is one line, in place, dismissible. A
celebration plays inside its screen and never blocks the next step.
*Test:* by eye in the flow screenshots: no dialog on a step where the script did not press something.

**P10. Errors say what to do.** What happened, then what to do, with the fix as a button when there is one. Never
a code alone, never "Something went wrong" alone, never blame.
*Test:* your own test file reads every refusal string you add: two sentences, the second starts with a verb.

**P11. Phone first.** Designed at 390x844, checked at 320x568 and 1440x900. Targets at least 44 px, no sideways
scroll, the main button reachable without scrolling back up, toasts at the bottom and never over a button.
*Test:* screenshots at the three sizes for every screen you changed.

**P12. One way to do each thing.** Each job has one place, one name and one setting. Features that share a job
share it (ux-notes.json, merged_into; the merges are listed once in section 2.9). These labels may appear at most
once per screen outside items: Download, Help, Delete, Remind, Send, Questions and comments, Language. A control
repeated on each item names its item ("Download Planting partnership").
*Test (script):* the ONCE list per screen.

**P13. Honest words.** Never claim a certification, a legal effect or a level that is not true and checked. The
claim words are certified, qualified, compliant, accredited, ISO, SOC 2, HIPAA and eIDAS. A sentence that uses one
about us (it names GrowSigning, we, our or this service, or it is a bare label of 4 words or fewer on a page that
does not explain the law) must say it is not held, or be the sentence of a registry entry marked held (gov-G01).
Explaining what a law asks for is fine. Honest and short go together: one line, not a paragraph.
*Test (script):* the CLAIMS list on signer, public and trust pages.

**P14. Order.** No batch changes a core screen until that screen's quick win (section 6) has merged and its new,
lower numbers are in ceilings.json. A batch that changes a core screen runs the check before and after and puts
both tables in its report.

---

## 2. Information architecture

The note for each feature key is in ux-notes.json; keys in brackets show where a feature lands.

### 2.1 App navigation

Desktop sidebar, in this order:

1. **Send a document**: the only start button in the app.
2. **Home**: what waits for you, what waits for others, recently completed with Download on each row. On a phone,
   one dismissible line "Add GrowSigning to your home screen" on the first 3 visits [ds-phone-app].
3. **Documents**: tabs All, Drafts, Waiting, Completed, Stopped (cancelled, declined, expired). Search; filters in
   one row, the rest in More options. Empty and you are an admin: one link "Bring in documents from DocuSign or an
   export" [gov-G19].
4. **To sign**.
5. **Templates**: Use on each row, everything else in the row's More. "Start from a ready-made one"
   [ds-templates-lib].
6. **Contacts**: people and lists. A list is used as "any one of them signs" in the editor and "each gets their
   own copy" in Send to many.
7. **More** (`data-more="nav"`): Send to many; Forms; Website terms (admins); Reports; Key dates (only when its
   switch is on) [ds-ai-repo]; Trees planted; Counter (only with the counter permission) [gov-G18].
8. **Settings**
9. **Help**: one entry. It stays when the AI helper is off; then it gives the built-in answers and "Talk to a
   person" [chat, gov-G20].

Then the account switcher, Sign out, "Operator" for operators, "Dev outbox" in development. The usage line
(signatures left) sits under the account name. Phone bottom bar: Home, Documents, **Send**, To sign, Menu.

### 2.2 Settings

A list of sections; each section is one page of cards. A section with nothing for this person is not listed. One
line of explanation under a control; longer rules behind "How this works". With zero setup an owner sees at most
10 sections and a member at most 4, and a section shows at most 4 cards; rarer cards sit behind the section's one
More options.

| Section | Who | Cards |
|---|---|---|
| Profile | everyone | Name, job title, company, email, language of your screens (only when one ships) [ds-lang-sender], your signature and initials |
| Security | everyone | First card "Your sign-in": password, two-step login, ways to sign in, where you are signed in and how. Then admin cards: Sign-in rules [ds-sec-policy, gov-G23]; Single sign-on and Your email domains [ds-sso-oidc, ds-sso-saml-scim, gov-G08]; identity providers you add for signers [ds-id-login]; Members from your directory; Security record [ds-sec-log, gov-G12]; Your own encryption key, owner only [ds-cmk, gov-G22] |
| Notifications | everyone | The email switches; monthly report for admins [ds-reports] |
| Away and sharing | accounts with 2 or more members | Share my documents with a colleague [ds-colleagues]; someone signs for me while I am away, when an admin allowed it [ds-delegate] |
| Account | admins | The one account name, logo, colour; "Hide the GrowSigning name on emails and pages" and Sending domain [gov-G17]; language for the people you send to (only with 2 languages) [ds-lang-core]; Trees on screens and emails, Trees on the signing record [gov-G01, impact]; AI card: helper on or off, let the AI read document text (with one line on what it is used for), Key dates [gov-G20, ds-ai-assist, ds-ai-repo] |
| Sending | admins | Three open cards. "New documents": reminders, deadline, date format. "When people sign": pass it on, questions and comments, ways to make a signature, paper [ds-paper], each person sees only their files, mark pages until everyone has signed [ds-switches, ds-visibility]. "Details and saved fields" [ds-custom-fields, ds-fields-kinds]. More options: access code rules, the in-person ID question [ds-id-small], your consent text [ds-consent-own], strict signing [ds-part11], signature level rules [gov-G10] |
| Team | admins | Members, invite, role; More options: what each role can do, groups of members [ds-perm-profiles]; move a member's documents [ds-colleagues] |
| Stamps and seals | admins | Account stamps (pictures) [stamp]; Organisation seal (a certificate, not a picture) [ds-eseal] |
| Plan | admins | What is left and when it resets, top-ups, Top up, history; rules behind "How signatures work" [expiry]. One line in deployment billing mode [gov-G14] |
| Records and data | admins | Keep and delete, Holds, Deletion record [ds-retention, gov-G11]; copies of every email [ds-mail-records]; archive format [ds-pdfa]; seal status line [ds-seal]; where your data is kept [ds-regions]; Export everything, Bring in documents [gov-G19]; close your account |
| Connections | admins, only when the operator set up at least one service | File sources [ds-cloud-pick]; WhatsApp [ds-channels]; identity checks for signers; signing with a certificate or an ID card [ds-qtsp, ds-webeid]; notary; take payments |
| Developers | admins | API keys, webhooks, one card "Signing inside your site" [ds-dev-api, gov-G17], the sender screen in your app, pulling the security record |
| Organisation | organisation admins | Agencies, policies passed down [gov-G13]. A setting set above says "Set by Ministry of X" wherever it appears |

### 2.3 The editor

Three steps, never four. Top bar: Save and close, the three step names, Help, Next or Send (the main button).

**Step 1. Files and people**
- Drop zone "Choose a file or drop it here". Under it, up to 4 "From Google Drive" style buttons when set up.
- Each file row: its name (title-cased from the file name), Pages [ds-page-tools], and More: Replace, Remove, Move
  up or down, To read, not sign [ds-supplements]. At most one note line under a file row; when more than one
  applies (converted, has signatures, looks like a template) the most urgent shows and the rest fold into
  "1 more note".
- People: one empty row is already there, Name and Email only. Then "Add another person" and "Add me". A person's
  More lists each group as one line with its current value ("How they get it: Email") that opens a small picker. A
  group with only one possible value is not listed. In this order:
  1. Role: Needs to sign, Needs to approve, Gets a copy, Must open it, Is a witness; after a divider: Can change
     the document, Chooses who comes next, Notary (only when set up).
  2. Language (only with 2 or more languages).
  3. How they get it: Email, Text, WhatsApp, I will send the link myself.
  4. Check who signs, one choice per person: None, Access code, Code by email or text, Sign in to sign, and when
     set up: Prove who you are with <scheme>, Photo ID check.
  5. How they sign: On screen, In person with me, and when set up or switched on: with a certificate or an ID
     card, on paper. Picking a scheme here sets Check who signs to "Done by <scheme> when they sign".
  6. Only when... (only once the document has a field it can test); Wait before this person (only with signing
     order on).
  7. Private note.

  With zero setup that is Role, How they get it, Check who signs and Private note.
- More options: Set signing order, Add a group, Write a document here [ds-write-doc].

**Step 2. Fields**
- "Fields for" person picker; six common fields: Signature, Initials, Date signed, Name, Text, Checkbox.
- "More fields" (`data-fold`): every other kind.
- "Place fields for me": one button.
- Field panel: Assigned to, Required, Label. More options: everything else (format and limits, only show when,
  calculate from, text style, same answer as, size, copy, delete).

**Step 3. Review and send**
- One link "See what each person sees" [ds-preview], then Who gets it, in order. A set condition is one line under
  its person.
- Email subject and message; "Draft a message" only when a model is configured and the AI helper is on.
- Details, only when an admin defined them. "Signing rules: Kenya, employment contract. Change", only when an
  admin switched the rules on [gov-G10].
- At most one notice line; more checks fold into "2 more things to check" (`data-fold`).
- More options holds only what changes from one send to the next: Send later, Reminders, Deadline, Each person
  sees only their files (2 or more files), Ask for a payment (when set up), Plain summary for signers (when
  allowed), Send for <name> (when shared). Date format, pass it on, questions and comments, ways to make a
  signature and marking pages are account defaults and template settings, never asked per send.
- One Send button. With Send later its label is "Send at 9:00 on 3 December". When the only person is the sender
  it reads "Sign now" and opens the signing page in the same tab, with no invitation email.

### 2.4 The rest of the sender's app

- Templates: the same editor; "Who can use this" in the row's More; the Use dialog has "Add another template".
- Forms: one list and one kind of form. On a phone every form opens one question at a time, with no choice.
- Send to many: template, list (from Contacts), check, send.
- Reports: members see their own sending, admins all of it; both start at the last 30 days.
- Counter: the queue view of the one in-person flow, for officials [gov-G18].

### 2.5 The envelope page (on screen: the document page)

- Title, one status sentence ("Waiting for Ana Silva to sign. Sent 2 minutes ago."), a hold or delete date when
  there is one.
- One main button by state: Draft: Continue. Scheduled: Send now. Waiting: Remind Ana Silva. Scan waiting: Look at
  the scan. Completed: Download. Expired: Reopen. Declined: Copy and fix.
- People: one status line each. A person's More: Change person, and "Share the link yourself" (Copy link, QR code,
  WhatsApp, Text), which is shown open for people set to "I will send the link myself". A per-person Remind
  appears only when 2 or more people are waiting at the same time.
- The page's More, 9 lines at most: Open the PDF (when the document is not completed), Full record for disputes,
  Edit, Give more time, Pause or Resume, Copy, Save as template, Move to a colleague, Cancel the request, and one
  Delete. When a deletion schedule is on, Delete's dialog gives the scheduled date and offers "Keep it" instead,
  and Keep it and Hold (admins) are listed; never otherwise.
- Folded sections: Questions and comments (with a count), History (email lines show their delivery state; there is
  no separate "Emails sent"), Details, Checks on the file.
- No IP addresses, hashes or time-zone reports on the page; they are in the full record.

### 2.6 The signing page

Screens, in order; each one only when it applies:

1. Access code or one-time code.
2. Consent: who sent it (named once), the document name, one sentence on what this is, one tick, Continue. The
   account's own text is shown inline only while the screen stays at or under 120 words, otherwise behind "Read
   <Org>'s terms". No tree line here. Other actions is already here.
3. Prove who you are: one screen that names the sender and the document in one line, then the provider.
4. The document. Above it, when they apply: "Also for you: Privacy notice" and "Summary (written by AI, check
   it)". Toolbar: Next or Finish (main) and one More (page view or easy reading, zoom, download). Next jumps to
   the field and opens it. One tree line next to Finish, for paid signatures: "10 mangroves will be planted when
   you finish."
5. Your signature: Type (prefilled), Draw, Upload; button "Sign". A certificate or ID card step replaces this
   dialog. Strict signing asks the reason here.
6. Finish: straight to Done unless something needs attention. Strict signing asks the password once, here.
7. Pay, only for documents that ask for a payment: after the last signature, before Done.
8. Done: what happens next, Download, the celebration in place.

Header: "From <sender>" (with "Signing for Ana Silva" when that applies, and "From acme.org (address checked)" as
words for a verified sending domain), the document name, the language menu with 2 or more languages, Help.

Other actions, in this fixed order, only those that apply, no descriptions: 1 Finish later, 2 Ask for more time,
3 Pass to someone else (or Hand back to <group>), 4 Questions and comments, 5 Sign on paper instead (only when the
account allows paper; inside it "Print it and send a photo" and "Ask <sender> to send it by post (stops signing
electronically)"), 6 Decline, always last. A witness gets: I was not there, Questions and comments, Help. "Stop
reminder emails" is in the reminder email's footer and the Finish later message. There is no "Change my
signature": tapping a placed signature does it.

Idle: nothing, unless the account set "Sign out after [ ] minutes". Then the first action after the limit checks
the link again in place, keeps every answer and shows one line: "You were away for a while, so we checked the link
again."

Help on signer and public pages shows only "Answers are written by AI and can be wrong. Do not type passwords or
card numbers." when a model answers. A model or host name appears only in the app's Help and on /security. Why an
option is missing ("Rosa turned that off for this document. Use Questions and comments to ask her.") and who pays
are built-in Help answers, never lines on the page.

### 2.7 Public pages

- Top bar: Pricing, Help, Sign in, Start free.
- Landing: at most 3 phone screenfuls and 800 words; live counters only from 1 tree.
- Footer groups: For signers (Check an email, Check a signed document, Find my documents); Trust (Security,
  Certifications, Sub-processors and Procurement, Accessibility, Report a weakness); Product (Pricing, Trees
  planted, Developers).
- /verify is the one page that checks a file.
- Login: email and password on one screen. When the typed address belongs to a claimed domain, the password box is
  replaced in place by "Continue with <Org> sign-in" as the person leaves the email box. Provider and smart card
  buttons only when set up.

### 2.8 Places that are not screens

Features with gate "docs" have no app UI: only the README, the /security pages and /app/operator.

### 2.9 Merges

Each of these is one thing. Both features' notes say so.

1. Sign in to sign: the account default "Strict signing" in Settings > Sending and the per-person choice in Check
   who signs. Not in step 3 [ds-part11].
2. One Delete on the envelope page [ds-retention].
3. One History; "Emails sent" is gone [bounces].
4. One kind of Form [ds-web-forms].
5. One Other actions entry "Sign on paper instead" [ds-paper, ds-consent-own].
6. One role "Chooses who comes next" [ds-recipient-types].
7. One in-person flow: "In person, with me", the Counter queue, one ID question, one line that the software cannot
   check an ID document [gov-G18, ds-id-small, ds-offline-inperson].
8. One people list in Contacts for groups and for Send to many [groups, ds-reports].
9. One Settings section Security [twostep, ds-sec-policy, ds-sso-oidc].
10. One account name, with the switch "Hide the GrowSigning name on emails and pages" [gov-G17].
11. One Developers card "Signing inside your site" [ds-dev-api, gov-G17].
12. Questions and comments on the signing page: in Other actions only [comments].
13. One Remind on the envelope page: the main button names the person [lifecycle].
14. "Open the PDF" replaces Preview and the second Download [lifecycle].
15. One provider trip when the same scheme proves who you are and signs [ds-id-login, ds-qtsp, ds-webeid, gov-G25].
16. One note line under a file [ds-convert, gov-G07, ds-tpl-combine].
17. One screen, name and setting each for: the operator's seal [ds-seal, gov-G05]; long-term checks and archive
    format [ds-seal-ltv, ds-pdfa, gov-G06]; single sign-on [ds-sso-oidc, ds-sso-saml-scim, gov-G08]; the security
    record [ds-sec-log, gov-G12]; keep and delete [ds-retention, gov-G11]; languages [ds-lang-*, gov-G15]; your
    own key [ds-cmk, gov-G22]; signer identity [ds-id-login, ds-id-docs, gov-G09, gov-G24, gov-G25]; certificate
    signing [ds-qtsp, gov-G16]; accessibility [ds-a11y, gov-G04]; running it yourself [ds-self-host, gov-G02].

---

## 3. Budget for the core flows

The ceilings are in tests/ux/ceilings.json, one set per profile, and the script breaks the run when a number is
over. Nothing there is ever raised. A batch that lowers a number writes the new one in the same change
(UX_RECORD=1 does it).

| Flow | What it is | Target: actions, screens, most choices on one screen, words |
|---|---|---|
| a-send-first | sign up and send a first document | 14, 8, 25, 1800 |
| b-sign-phone, b-sign-desktop | open the email, agree, sign, finish | 6, 5, 10, 450 |
| c-template-send | send from a template | 5, 4, 20, 450 |
| d-find-download | find a completed document and download it | 3, 2, 25, 450 |
| e-settings-name | change your name | 3, 2, 15, 250 |
| f-signer-help | a signer who cannot sign today looks for help | 4, 3, 8, 500 |
| g-sign-in | landing, Sign in, Home | today's numbers are the ceiling |
| h-sign-myself | sign your own document, from Home to Done | today's numbers are the ceiling |

Profiles:

- **default**: zero setup.
- **everything**: every operator service faked, and details, a deletion schedule and a second member on the
  account (2 languages and the AI switch join when they exist). The core flows use none of it, so here a flow may
  have no more screens than its zero-setup ceiling and at most 1 more action. The first run after the simplify
  batches is recorded as this profile's own ceiling.
- **government**: zero setup with DEPLOYMENT_PROFILE=government. Same ceilings rule, and P8.

A feature the person switched on for this send may add to the flow, measured in the feature's own test: a check
the sender chose adds at most 1 screen and 60 words; anything else adds at most 1 action and no screen.

Always-visible additions cost choices on a-send-first even with zero setup. Each may merge only after the quick
win for its screen has lowered the ceiling:

| Addition | Cost |
|---|---|
| "Pages" on each file row [ds-page-tools] | 1 choice per file |
| "Add me" in step 1 | 1 choice |
| "See what each person sees" in step 3 [ds-preview] | 1 choice |

Timings are not ceilings because the machine is shared; a rise of more than 20 percent in klm_s needs a reason in
the report.

---

## 4. Words

Use the plain name on screens. The technical name may follow once in an admin's Settings, with its one-line
explanation.

| Thing | Say | Avoid on screens |
|---|---|---|
| Envelope | document; its parts are files | envelope |
| Recipient | person, the people | recipient |
| Bulk send | Send to many | bulk |
| PowerForm, web form | Form, "Anyone with this link can sign" | PowerForm, web form, fill-in form |
| Click-to-agree | Website terms | clickwrap |
| Adopt signature | Your signature, button "Sign" | adopt |
| Audit trail | History | audit trail (fine in the full record and API) |
| Certificate of completion | Signing record. "Signed record" means the signed PDF with its signing record pages | certificate (on screens it only ever means a signer's or an organisation's certificate) |
| Evidence pack | Full record for disputes | evidence pack |
| Void | Cancel the request | void |
| Clone | Copy | clone |
| Correct | Change person | correct |
| Nudge | Remind, "Remind Ana Silva" | nudge |
| Inbox | To sign | inbox |
| Declined, expired, cancelled | Stopped | Closed |
| Our impact | Trees planted; "Trees on the signing record" | a figure under 1 tree |
| Credits, lots | signatures left, "reset on 3 December" | credits, lots, ledger |
| Custom fields | Details | custom fields, metadata |
| Supplemental documents | To read, not sign; Must open it | supplemental, Needs to view |
| Document visibility | Each person sees only their files | visibility |
| Conditional routing | Only when... | conditional, routing |
| Delayed routing | Wait before this person | delayed routing |
| Scheduled sending | Send later | scheduled |
| Editor, agent, intermediary | Can change the document; Chooses who comes next | editor, agent, intermediary |
| In-person signing | In person, with me (under How they sign); Connect the citizen's screen | Signs in person as a role, Pair a screen |
| Composite templates | Add another template; "This looks like your template Volunteer agreement. Use it?" | composite |
| Collaborative fields | Anyone on the document can fill it in | collaborative |
| Validation, mask | Format, My own pattern | validation, regex, mask |
| Field appearance | Text style | Look |
| Date formula | Date from another date (like 30 days after signing) | date formula |
| Delegated signing | Someone signs for me while I am away; "Signing for Ana Silva" | delegate |
| Shared access | Share with a colleague, "sent by Ana Silva" | on behalf of |
| Permission profiles | What each role can do | permission profile |
| Access code | Access code (a code you tell them); shown once: "Tell <name> this code yourself. We do not show it again." | |
| OTP | Code by email, Code by text, Call me with the code | OTP |
| Identity verification | Prove who you are with <scheme>, Photo ID check, Keep their ID number on the signing record | IDV, liveness, IAL, AAL, identifier |
| QES, QTSP | Sign with your <provider> certificate | QES, AES, QTSP on signer screens |
| Web eID, PIV, CAC | Sign with your ID card, Sign in with a smart card | PIV, CAC, Web eID |
| The operator's PAdES seal | "Sealed by <operator name>" in History and Checks on the file; admin status line "Digital seal (PAdES): PDF readers show if the file changed after signing" | a bare "seal", PAdES, PKI |
| eSeal | Organisation seal (a certificate in your organisation's name, not a picture) | eSeal |
| Stamp pictures | Stamp | seal |
| RFC 3161 timestamp | Trusted time stamp | RFC 3161, TSA |
| LTV | Can be checked for years | LTV, B-LT, OCSP, CRL |
| PDF/A | Archive format (PDF/A) | |
| Signature validation | Check a signed document; Signature intact, Changed after signing, Could not check | DSS, ETSI |
| SSO | Single sign-on, "Continue with <Org> sign-in" | SAML, OIDC on login |
| SCIM | Members from your directory | SCIM |
| SIEM | Your security system | SIEM, events |
| Security event log | Security record | event log |
| Retention | Delete after, Keep it | retention, purge, Delete now |
| Legal hold | Hold (kept until the hold ends) | never delete |
| Disposition | Deletion record | disposition |
| Redaction | Remove names and answers, keep the record | redact |
| BCC archive | Copies of every email; "(link removed in this copy)" | BCC, journaling |
| Data residency | Where your data is kept | residency |
| Customer-managed keys | Your own encryption key | CMK, KEK |
| Tenant, org | account; Organisation, agencies | tenant |
| White label | Hide the GrowSigning name on emails and pages | white label |
| Verified sender domain | From acme.org (address checked) | Verified, a badge |
| Embedded signing | Signing inside your site | iframe, embed, portal as a second thing |
| 21 CFR Part 11 | Strict signing, Sign in to sign | Part 11 on signer screens |
| Watermark | Mark pages until everyone has signed (prefilled "Not signed yet") | watermark, words across unfinished copies |
| Signature level rules | Signing rules: <country>, <document type>. Change | a bare "For:" |
| Rotate | Turn | rotate |
| Locale | Language | locale |
| Sharing a link from your phone | Share the link yourself (a bare "WhatsApp" or "Text" always means we send it) | |
| Help chat | Help; Talk to a person | chatbot, LLM, model |

Dates: the reader's own time with the zone name, never UTC alone on a signer screen.

**Lists the script checks** (the same lists are at the top of tests/ux/flows.cjs; change both together):

- ONCE, at most once per screen outside items (P12): Download, Help, Delete, Remind, Send, Questions and comments,
  Language.
- CLAIMS, on signer, public and trust pages (P13): certified, qualified, compliant, accredited, ISO, SOC 2, HIPAA,
  eIDAS.
- TECHNICAL, never on signer pages, nor on public pages other than /security, /procurement, /accessibility and
  /developers (P6): PAdES, PKI, SAML, SCIM, SIEM, OIDC, OpenID, QES, AES, QTSP, PDF/A, RFC 3161, FIPS, PKCS, HSM,
  KMS, OTP, LTV, OCSP, IDV, IAL, AAL, PIV, CAC, Part 11, LLM.
- AVOID, never on signer pages and a warning on public pages (P6): envelope, recipient, adopt, audit trail, void,
  clone, nudge, PowerForm, clickwrap, bulk send.

---

## 5. The check

Run it before and after any change to a core screen.

1. Start a dev server on a throwaway database with its own build folder (KEY and PORT are yours):

   ```
   NEXT_DIST_DIR=.next-KEY DATA_DIR=$(mktemp -d) DEV_OUTBOX=1 APP_URL=http://localhost:PORT npx next dev -p PORT
   ```

   For another profile, put its settings in front: `env $(node tests/ux/flows.cjs --env everything) NEXT_DIST_DIR=...`
   (or `--env government`).

2. Run the flows into a folder of your own:

   ```
   node tests/ux/flows.cjs http://localhost:PORT tests/out/KEY/ux/
   UX_PROFILE=everything node tests/ux/flows.cjs http://localhost:PORT tests/out/KEY/ux-everything/
   UX_PROFILE=government UX_SAME_AS=tests/out/KEY/ux/ node tests/ux/flows.cjs http://localhost:PORT tests/out/KEY/ux-government/
   ```

   Exit code 1: a step of a flow failed. A failure because a button moved is a finding: fix the pattern in the
   script only when the new path is not longer. Exit code 3: every flow ran, but a ceiling or a rule is broken.
   The run prints the table, the ceilings and every rule; put them in your report.

3. Warnings named "not there yet" are rules the app cannot pass until a simplify batch has marked or shortened its
   screen; each names the batch. Once the five simplify batches have merged, the integrator runs with UX_STRICT=1
   and they count as broken. Never add to them.

4. Look at the screenshots in your folder next to tests/out/ux-baseline/ for every screen you changed (P9, P11).

5. Clean up: stop the server, delete .next-KEY, take its lines back out of tsconfig.json if next dev added them.

---

## 6. Quick wins, and their order

These lower the ceilings. By P14, the quick win for a screen merges before any feature batch touches that screen.

| Batch | Screens | Quick wins |
|---|---|---|
| simplify-start | sign-up, sidebar, Home | Confirm the address with a 6-digit code in the same tab, email of 50 words or fewer. One start button. Sidebar of 9 entries with the More group. Home shows Recently completed with Download. Document names title-cased from the file name |
| simplify-editor | the editor | Step 1 with one empty person row and everything else in the person's More. Reminders, deadline and the message move to step 3. Six common fields plus More fields. "Sign now" on step 3 when the only person is the sender, before "Sign a document yourself" leaves Home |
| simplify-envelope | envelope page, Templates | One main button by state, one More per person and per page, folded sections, no IP addresses or hashes. One Download; "Full record for disputes" in More. Toasts at the bottom. Templates: Use on each row |
| simplify-signing | signing page, invitation email | Next opens the field. Consent of 120 words or fewer. Other actions in the fixed order. "Your signature" and "Sign". Finish straight to Done. Invitation of 80 words or fewer above the button, dates in the person's own time |
| simplify-public | landing, /pricing, /help, Settings | Landing of 3 phone screenfuls and 800 words, 4 top links. No figure under 1 tree. Settings in the sections of 2.2, "Saved" next to what was saved, Plan rules behind "How signatures work" |

Each batch also adds the attributes of P4 and P3 to its screens.

---

## 7. Where every feature lives

The full note for each key is in research/ux-notes.json. This table is made from it: the gate (P3) and the key
whose place it shares (P12).

| Key | Gate | Shares the place of | Where |
|---|---|---|---|
| ds-lang-core | operator |  | Settings > Account |
| ds-convert | operator |  | Editor step 1 |
| ds-seal | operator |  | No sender or signer control |
| ds-mail-records | admin |  | Settings > Records and data > 'Copies of every email' (admins), up to 5 addresses |
| ds-templates-lib | always |  | Templates page |
| ds-sec-log | admin |  | Settings > Security > 'Security record' (admin card, below 'Your sign-in'), with Alerts... |
| ds-retention | admin |  | Settings > Records and data > 'Keep and delete' (admins) |
| ds-custom-fields | admin |  | Settings > Sending > card 'Details and saved fields' (admins define) |
| ds-channels | operator |  | Editor person More > 'How they get it' |
| ds-self-host | docs |  | No app screens |
| ds-reports | always |  | Sidebar More > Reports |
| ds-lang-signing | operator |  | Signing page header |
| ds-lang-mail | operator | ds-lang-signing | No new controls |
| ds-consent-own | admin |  | Settings > Sending > More options > 'Your consent text' (admins), per language |
| ds-seal-ltv | operator |  | No new control |
| ds-pdfa | operator |  | Settings > Records and data > 'Archive format (PDF/A)' switch (admins), listed only... |
| ds-eseal | admin |  | Settings > Stamps and seals > 'Organisation seal (a certificate in your organisation's... |
| ds-sec-policy | admin |  | Settings > Security > 'Sign-in rules' (admin card |
| ds-page-tools | always |  | Editor step 1, the file row |
| ds-paper | admin |  | Settings > Sending > card 'When people sign' |
| ds-id-small | always |  | Editor person More > Check who signs > Access code |
| ds-sso-oidc | admin |  | Settings > Security > 'Single sign-on' (one admin card for OpenID Connect and SAML, the... |
| ds-timing | always |  | Editor step 3 More options |
| ds-fields-checks | always |  | Editor field panel > More options > Format and limits (letters only, postcode, my own... |
| ds-a11y | always |  | No new controls |
| ds-preview | always |  | Editor step 3 |
| ds-switches | always |  | Settings > Sending > card 'When people sign' |
| ds-supplements | always |  | Editor step 1, the file's More |
| ds-visibility | always |  | Editor step 3 More options |
| ds-witness-two | always |  | The existing witness role in a person's More |
| ds-id-login | admin |  | Operator providers |
| ds-phone-app | always |  | Home on phones |
| ds-reading-view | always |  | Signing page toolbar More > View |
| ds-lang-first | operator |  | No new UI |
| ds-qtsp | operator |  | Settings > Connections > 'Signing with a certificate' (providers the operator set up) |
| ds-cloud-pick | operator |  | Editor step 1, under the drop zone |
| ds-write-doc | always |  | Editor step 1 More options |
| ds-colleagues | admin |  | Settings > Away and sharing (listed only on accounts with 2 or more members) |
| ds-delegate | admin |  | Settings > Away and sharing > 'Someone signs for me while I am away', listed only when... |
| ds-fields-kinds | always |  | Editor step 2 > More fields |
| ds-id-docs | operator | ds-id-login | Settings > Connections > Identity checks (provider) |
| ds-webeid | operator |  | Editor person More > How they sign |
| ds-sso-saml-scim | admin | ds-sso-oidc | Settings > Security |
| ds-db-encrypt | docs |  | No app screens |
| ds-lang-sender | operator |  | Settings > Profile > 'Language of your screens', listed only when a sender language ships |
| ds-lang-sender-rest | operator | ds-lang-sender | No new controls |
| ds-routing-if | always |  | Editor person More > 'Only when...' (the same builder as a field's Only show when),... |
| ds-recipient-types | always |  | Editor person More > Role |
| ds-web-forms | always |  | Sidebar More > Forms |
| ds-pay-collect | operator |  | Settings > Connections > Take payments (when the operator set up the provider) |
| ds-dev-api | admin |  | Settings > Developers |
| ds-offline-inperson | always | gov-G18 | Part of the one in-person flow (How they sign |
| ds-perm-profiles | admin |  | Settings > Team > More options |
| ds-part11 | always |  | One setting, merged from three |
| ds-ai-assist | operator |  | Settings > Account > AI card |
| ds-ai-repo | operator |  | Sidebar More > Key dates, only when the Key dates switch is on (its own switch on the... |
| ds-tpl-combine | always |  | Templates > Use dialog |
| ds-collab-fields | always |  | Editor field panel |
| ds-notary | operator |  | Settings > Connections > Notary (partner set up by the operator) |
| ds-regions | operator |  | Settings > Records and data > 'Where your data is kept' (read-only line) |
| ds-cmk | admin |  | Settings > Security > 'Your own encryption key' (owner only, the last card) |
| gov-G01 | always |  | Settings > Account |
| gov-G02 | docs | ds-self-host | Operator only |
| gov-G03 | docs |  | Public /procurement and /security/subprocessors, linked from /security and the footer's... |
| gov-G04 | always | ds-a11y | No new controls |
| gov-G05 | operator | ds-seal | Same as ds-seal |
| gov-G06 | operator | ds-seal-ltv | Same as ds-seal-ltv and ds-pdfa |
| gov-G07 | always |  | Public /verify 'Check a signed document' (one page for both questions) |
| gov-G08 | admin | ds-sso-oidc | The same Single sign-on card as ds-sso-oidc in Settings > Security, with role mapping... |
| gov-G09 | admin | ds-id-login | As ds-id-login |
| gov-G10 | admin |  | Settings > Sending > More options > 'Signature level rules' (admins, default country) |
| gov-G11 | admin | ds-retention | As ds-retention in Settings > Records and data |
| gov-G12 | admin | ds-sec-log | As ds-sec-log |
| gov-G13 | operator |  | Settings > Organisation, only for organisation admins |
| gov-G14 | operator |  | Settings > Plan becomes one line in deployment billing mode |
| gov-G15 | operator | ds-lang-core | Same as ds-lang-core and ds-lang-signing |
| gov-G16 | operator | ds-qtsp | Same as ds-qtsp |
| gov-G17 | admin |  | Settings > Account |
| gov-G18 | admin |  | Sidebar More > Counter, only for people with the counter permission |
| gov-G19 | always |  | Settings > Records and data |
| gov-G20 | operator | chat | Operator settings for the model |
| gov-G21 | docs |  | Operator only |
| gov-G22 | admin | ds-cmk | The same card as ds-cmk |
| gov-G23 | operator |  | Login page (one screen, as ds-sso-oidc) |
| gov-G24 | operator | ds-id-login | Same as ds-id-login |
| gov-G25 | operator | ds-id-login | As ds-id-login and ds-qtsp |
| gov-G26 | docs |  | Operator only |
| abuse | always |  | No controls |
| integrity | always |  | Signing page only |
| nonus-words | always |  | Wording on the consent screen, the signature dialog, landing and /pricing |
| nonus-text | always |  | The signing record and typed signatures |
| mobile-send | always |  | Editor on a phone |
| industry | always |  | Wording on /security, /help, Forms and Send to many |
| disputes-evidence | always |  | Envelope page's More |
| mobile-sign | always |  | Signing page on a phone |
| qr | always |  | Envelope page, a person's More > 'Share the link yourself' (with Copy link, WhatsApp... |
| groups | always |  | Contacts |
| logic | always |  | Editor field panel > More options |
| comments | always |  | Signing page |
| clickwrap | always |  | Sidebar More > Website terms (admins) |
| encrypt | docs |  | No app screens |
| twostep | always |  | Settings > Security > 'Your sign-in' (the first card, for everyone) |
| witness | always |  | Editor person More > Role |
| lifecycle | always |  | Envelope page |
| signerux | always |  | Signing page |
| support | always |  | Inside Help |
| money-today | always |  | Settings > Plan only |
| misc-today | always |  | Settings > Team |
| signin | operator |  | Login and sign-up |
| signercode | always |  | Editor person More > Check who signs |
| bounces | always |  | Envelope page |
| tplroles | always |  | Templates |
| stamp | always |  | Settings > Stamps and seals (account stamps |
| expiry | always |  | Settings > Plan top card |
| impact | always |  | Signing page |
| chat | always |  | One Help entry per screen (sidebar bottom in the app, header on the signing page, top... |
| brand-wire | always |  | The logo and name everywhere |
| simplify-start | always |  | Sign-up and email confirmation, the sidebar (section 2.1), Home |
| simplify-editor | always |  | The editor's three steps (section 2.3) |
| simplify-envelope | always |  | The envelope page and Templates (sections 2.4 and 2.5) |
| simplify-signing | always |  | The signing page, the consent screen and the invitation email (section 2.6) |
| simplify-public | always |  | Landing, /pricing, /help and Settings (sections 2.2 and 2.7) |
