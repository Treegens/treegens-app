# GrowSigning Accessibility Conformance Report (draft): Self-assessed, not audited

Written on 21 November 2026, from the code as it was that day.

## What this is not

- **Self-assessed, not audited.** The authors of GrowSigning wrote this report about their own screens. Nobody
  outside the project has checked it, and nothing in it is a statement that GrowSigning meets a standard.
- It is a draft. It follows the layout of the VPAT 2.5 INT template (Information Technology Industry Council), which
  covers WCAG 2.2, the Revised Section 508 standards and EN 301 549 in one report, but it has not been through the
  review that a published report would get.
- It is about the software as it was on the date above. A server you use may run another version.

## Product information

- **Name and version:** GrowSigning, as built from its source on the date above.
- **Description:** a web application for sending documents for electronic signature and for signing them.
- **What was evaluated:** the signing page in all its states, the editor for preparing a document, the page of a
  document that is out, and the public accessibility statement. Not evaluated: the emails, Settings, the operator
  screens, the other public pages, and the signed PDF beyond what is said under clause 10 below.
- **Contact:** the help form at /help, topic "Accessibility: something is hard to read or use", on the server you
  use. Whether a person reads it depends on how that server is set up; /accessibility says which.

## Evaluation methods used

- axe-core 4.10 in Chromium, run on 26 states of the screens at 320 and 1280 pixels wide, with the rules for WCAG
  2.0, 2.1 and 2.2 at levels A and AA (`tests/a11y/axe-states.cjs`).
- Signing a document with the keyboard alone at 320, 390 and 1280 pixels (`tests/a11y/keyboard-sign.cjs`).
- Placing and moving a field in the editor without a mouse (`tests/a11y/keyboard-editor.cjs`).
- What a screen reader is told, read from the browser's accessibility tree. **No test with VoiceOver, NVDA, JAWS or
  TalkBack was made.**
- Reading the code of the screens named above.

The steps and what they found are in `docs/a11y-checks.md`.

## Applicable standards and guidelines

| Standard | Included in this report |
| --- | --- |
| Web Content Accessibility Guidelines 2.2 | Level A (yes), Level AA (yes), Level AAA (no) |
| Revised Section 508 standards, as published by the US Access Board in 2017 | Yes |
| EN 301 549 V3.2.1 (2021-03) | Yes |

## Terms

- **Supports:** the functionality meets the criterion without known defects in what was evaluated.
- **Partially Supports:** some functionality does not meet the criterion, or it was not checked everywhere.
- **Does Not Support:** the majority of the functionality does not meet the criterion.
- **Not Applicable:** the criterion does not apply to the product.
- **Not Evaluated:** the criterion was not checked.

## WCAG 2.2 report

The same tables answer the Revised Section 508 criteria for web content (502 and E205.4, which point at WCAG 2.0 A
and AA) and EN 301 549 clause 9 (web, which points at WCAG 2.1 A and AA). Criteria new in 2.1 or 2.2 are marked.

### Table 1: Level A

| Criterion | Conformance level | Remarks |
| --- | --- | --- |
| 1.1.1 Non-text Content | Partially Supports | Each page of a document is drawn as a picture named "Page 1 of 3, shown as a picture", and the text view ("Read the document as text") gives its words and every field as a form. A page that is a scan has no text unless the server reads text from scanned pages (OCR_CMD or OCRMYPDF_URL); without that, the text view says the page has no text and offers to ask the sender for a readable copy. |
| 1.2.1 Audio-only and Video-only (Prerecorded) | Not Evaluated | The home page can show a short video; it was not evaluated. The signing page and the editor have no audio or video. |
| 1.2.2 Captions (Prerecorded) | Not Evaluated | As 1.2.1. |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | Not Evaluated | As 1.2.1. |
| 1.3.1 Info and Relationships | Partially Supports | Headings, labels, fields grouped by page, radio buttons grouped by name. Some screens have content outside a landmark region (axe, moderate). |
| 1.3.2 Meaningful Sequence | Partially Supports | Fields follow the order of the page in the text view. On the page view, the fields sit on top of a picture and are read in the order the sender placed them. |
| 1.3.3 Sensory Characteristics | Supports | Instructions name controls ("Choose Next"), not shapes or places. |
| 1.4.1 Use of Color | Partially Supports | Done fields show their content and required ones say "required". Not checked screen by screen. |
| 1.4.2 Audio Control | Not Evaluated | As 1.2.1. The video does not play sound by itself (it starts muted). |
| 2.1.1 Keyboard | Supports | A whole document was signed with the keyboard alone. Drawing a signature needs a pointer; typing it is offered beside it. In the editor a field type chosen with Enter lands on the page and the arrow keys move it. |
| 2.1.2 No Keyboard Trap | Supports | Dialogs close with Escape or their Cancel button, and the focus returns. |
| 2.1.4 Character Key Shortcuts (2.1) | Supports | The editor's keys (arrows, Delete, Ctrl or Cmd with D, Z, Y) are not single printable characters, and act only on a selected field outside text boxes. |
| 2.2.1 Timing Adjustable | Supports | The sender's deadline is shown on the signing page, and a signer can ask for more time. An idle limit, when an account sets one, never loses answers: the link is checked again and the work stays. |
| 2.2.2 Pause, Stop, Hide | Partially Supports | Nothing moves on the signing page or in the editor. The home page video has controls and was not evaluated further. |
| 2.3.1 Three Flashes or Below Threshold | Supports | No flashing content in what was evaluated. |
| 2.4.1 Bypass Blocks | Supports | The signing page starts with a "Skip to content" link and a button to read the document as text before its pictures. Public pages have a main landmark. |
| 2.4.2 Page Titled | Supports | Each screen has a title; the signing page's names the document. |
| 2.4.3 Focus Order | Supports | Checked while signing with the keyboard. |
| 2.4.4 Link Purpose (In Context) | Supports | No axe finding on link names. |
| 2.5.1 Pointer Gestures (2.1) | Supports | Zoom has buttons; nothing needs a pinch or a path except drawing a signature, which has the typed alternative. |
| 2.5.2 Pointer Cancellation (2.1) | Supports | Controls are ordinary buttons that act when released. |
| 2.5.3 Label in Name (2.1) | Partially Supports | The names checked contain the visible words ("Sign" in "Signature, required. Sign here"). Not checked for every control. |
| 2.5.4 Motion Actuation (2.1) | Supports | Nothing is done by moving the device. |
| 3.1.1 Language of Page | Supports | The page's language is set, and follows the signer's language on the signing page. |
| 3.2.1 On Focus | Supports | A date field shows its picker when it gets the focus; nothing else changes. |
| 3.2.2 On Input | Supports | Typing or ticking does not move to another screen. |
| 3.2.6 Consistent Help (2.2) | Supports | Help is in the same place on every state of the signing page (its top bar) and in the editor's top bar. |
| 3.3.1 Error Identification | Supports | A field with a problem is marked invalid and the problem is said in words. |
| 3.3.2 Labels or Instructions | Supports | Every field has a name; the signing page says what to do next. |
| 3.3.7 Redundant Entry (2.2) | Supports | The signer's name is filled in; a signature made once is used again for the next signature field. |
| 4.1.1 Parsing | Supports | Removed in version 2.2 of the guidelines; listed because the other two standards still include it. React renders well-formed markup. |
| 4.1.2 Name, Role, Value | Supports | No axe finding in the 26 states after the fixes listed in `docs/a11y-checks.md`. |

### Table 2: Level AA

| Criterion | Conformance level | Remarks |
| --- | --- | --- |
| 1.2.4 Captions (Live) | Not Applicable | No live media. |
| 1.2.5 Audio Description (Prerecorded) | Not Evaluated | As 1.2.1. |
| 1.3.4 Orientation (2.1) | Supports | The signing page and its dialogs work in portrait and landscape. |
| 1.3.5 Identify Input Purpose (2.1) | Partially Supports | Sign-up and login fields carry autocomplete (name, email, passwords). Fields a sender adds to a document do not. |
| 1.4.3 Contrast (Minimum) | Supports | No contrast finding in the 26 states after two fixes. The pages of a document look as the sender's file does. |
| 1.4.4 Resize Text | Supports | Checked with browser zoom up to 400 percent. |
| 1.4.5 Images of Text | Partially Supports | The pages of a document are drawn as pictures because that is what is signed; the text view has the same words as text. |
| 1.4.10 Reflow (2.1) | Supports | No sideways scrolling at 320 pixels in the 26 states. |
| 1.4.11 Non-text Contrast (2.1) | Not Evaluated | |
| 1.4.12 Text Spacing (2.1) | Not Evaluated | |
| 1.4.13 Content on Hover or Focus (2.1) | Partially Supports | Hints use the browser's own tooltips; not checked further. |
| 2.4.5 Multiple Ways | Supports | The menu and the footer on the public pages; the sidebar and the document list in the app. |
| 2.4.6 Headings and Labels | Supports | |
| 2.4.7 Focus Visible | Supports | A focus ring showed on every control reached by the keyboard. |
| 2.4.11 Focus Not Obscured (Minimum) (2.2) | Partially Supports | Next scrolls the field into view above the bar at the bottom of a phone screen. Not checked for every control. |
| 2.5.7 Dragging Movements (2.2) | Supports | Fields can be placed and moved in the editor with the keyboard, and sized by typing. |
| 2.5.8 Target Size (Minimum) (2.2) | Partially Supports | Buttons are at least 44 pixels tall; on a phone every field takes a 44 pixel tap; on a large screen small tick boxes take 24 pixels. Text fields drawn smaller than 24 pixels by a sender on a large screen rely on the spacing exception, which was not measured on every document. |
| 3.1.2 Language of Parts | Partially Supports | The page language follows the signer's language. The words of a document in another language are not marked. |
| 3.2.3 Consistent Navigation | Supports | |
| 3.2.4 Consistent Identification | Supports | |
| 3.3.3 Error Suggestion | Supports | Messages say what is wrong and what to type instead. |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Partially Supports | Answers are checked before Finish and anything that needs a look is shown first, but signing cannot be undone once Finish is chosen and nothing needs a look. A signer can decline instead. |
| 3.3.8 Accessible Authentication (Minimum) (2.2) | Partially Supports | No password or code box sets its own paste handling, and the password boxes tell password managers what they are. Pasting was not tried on every box. |
| 4.1.3 Status Messages (2.1) | Supports | Messages appear in a polite live region; loading states use a status role. |

### Table 3: Level AAA

Not evaluated.

## Revised Section 508 report

### Chapter 3: Functional Performance Criteria

| Criterion | Conformance level | Remarks |
| --- | --- | --- |
| 302.1 Without Vision | Partially Supports | Signing works with the keyboard and every field is named. Scanned pages, the untagged signed PDF and no test with a real screen reader. |
| 302.2 With Limited Vision | Supports | Zoom to 400 percent without sideways scrolling; the text view at any size. |
| 302.3 Without Perception of Color | Partially Supports | As 1.4.1 above. |
| 302.4 Without Hearing | Supports | Nothing needs sound. |
| 302.5 With Limited Hearing | Supports | Nothing needs sound. |
| 302.6 Without Speech | Supports | Nothing needs speech. |
| 302.7 With Limited Manipulation | Supports | Keyboard alone works; a signature can be typed. |
| 302.8 With Limited Reach and Strength | Supports | |
| 302.9 With Limited Language, Cognitive, and Learning Abilities | Partially Supports | The words are written plainly, one main button per screen. Not tested with people. |

### Chapter 4: Hardware

Not Applicable: GrowSigning is software that runs in a web browser.

### Chapter 5: Software

Not Applicable: web content is answered in the tables above (E205.4). GrowSigning is not a platform, an authoring tool
for web content, or software installed on a device.

### Chapter 6: Support Documentation and Services

| Criterion | Conformance level | Remarks |
| --- | --- | --- |
| 602.2 Accessibility and Compatibility Features | Supports | /accessibility says what works and what does not. |
| 602.3 Electronic Support Documentation | Partially Supports | The help page was not part of the checks. |
| 602.4 Alternate Formats for Non-Electronic Support Documentation | Not Applicable | There is no printed documentation. |
| 603.2 Information on Accessibility and Compatibility Features | Partially Supports | A help request can be made about accessibility; whether a person answers depends on the server's settings. |
| 603.3 Accommodation of Communication Needs | Partially Supports | Help is written, by form or email. There is no phone or relay service. |

## EN 301 549 report

### Chapter 4: Functional Performance Statements

| Clause | Conformance level | Remarks |
| --- | --- | --- |
| 4.2.1 Usage without vision | Partially Supports | As 302.1. |
| 4.2.2 Usage with limited vision | Supports | As 302.2. |
| 4.2.3 Usage without perception of colour | Partially Supports | As 302.3. |
| 4.2.4 Usage without hearing | Supports | |
| 4.2.5 Usage with limited hearing | Supports | |
| 4.2.6 Usage with no or limited vocal capability | Supports | |
| 4.2.7 Usage with limited manipulation or strength | Supports | As 302.7. |
| 4.2.8 Usage with limited reach | Supports | |
| 4.2.9 Minimize photosensitive seizure triggers | Supports | Nothing flashes. |
| 4.2.10 Usage with limited cognition, language or learning | Partially Supports | As 302.9. |
| 4.2.11 Privacy | Supports | The product asks nothing about a disability, and the accessible ways of signing show nothing more than the usual ones. |

### Chapter 5: Generic Requirements

| Clause | Conformance level | Remarks |
| --- | --- | --- |
| 5.1 Closed functionality | Not Applicable | It runs in an ordinary browser. |
| 5.2 Activation of accessibility features | Not Applicable | There is no separate accessible mode; the same screens serve everyone. |
| 5.3 Biometrics | Not Applicable | Nothing uses biometrics. |
| 5.4 Preservation of accessibility information during conversion | Partially Supports | The signed PDF keeps the text of the uploaded document but adds no tags. Office files turned into PDF were not checked. |
| 5.5 to 5.9 Operable parts, locking, key repeat, double-strike, simultaneous actions | Not Applicable | No hardware. Nothing needs two keys or two fingers at once. |

### Chapters 6, 7 and 8: Two-way voice, video, hardware

Not Applicable: no voice calls or hardware. Chapter 7 (video): Not Evaluated, as 1.2.1 above.

### Chapter 9: Web

See the WCAG 2.2 report above. EN 301 549 V3.2.1 points at WCAG 2.1; every WCAG 2.1 criterion at A and AA is in
those tables.

### Chapter 10: Non-web documents

The documents are the PDFs that people upload and the signed PDF that GrowSigning makes.

| Clause | Conformance level | Remarks |
| --- | --- | --- |
| 10.1.1.1 Non-text content | Partially Supports | The signed PDF keeps the text of the document. A scanned page has text only when the server reads text from scanned pages; that text is used on the signing page and for search, and is not written into the PDF. |
| 10.1.3.1 Info and relationships | Does Not Support | The signed PDF is not tagged: no headings or structure are marked in it. |
| 10.1.3.2 Meaningful sequence | Partially Supports | The words are in the order the uploaded file gives them. |
| Other clauses of chapter 10 | Not Evaluated | |

### Chapter 11: Software

Not Applicable: as chapter 5 of the previous report.

### Chapter 12: Documentation and Support Services

| Clause | Conformance level | Remarks |
| --- | --- | --- |
| 12.1.1 Accessibility and compatibility features | Supports | /accessibility. |
| 12.1.2 Accessible documentation | Partially Supports | The help page was not part of the checks. |
| 12.2.2 Information on accessibility and compatibility features | Partially Supports | As 603.2. |
| 12.2.3 Effective communication | Partially Supports | As 603.3. |
| 12.2.4 Accessible documentation | Partially Supports | As 12.1.2. |

## Legal disclaimer

This report was written by the authors of GrowSigning about their own software. It is a self-assessment, it has
not been audited, and it is not a statement of conformance with any standard or law.
