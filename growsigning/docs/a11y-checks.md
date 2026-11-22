# Accessibility checks: how the screens were checked, and how to repeat it

Written on 21 November 2026, from the code as it was that day.

## What this is not

- It is not an audit. The authors of the software checked their own screens. Nobody outside the project has.
- It does not say that GrowSigning meets any accessibility standard. It says what was tried, on what, and what
  happened.
- It is not a test with VoiceOver on an iPhone or with NVDA on Windows. Neither could be run where these checks were
  made. What a screen reader is told was read from the accessibility tree of a Chromium browser instead (see step 3).

The statement at /accessibility (its words are in `src/lib/a11y.ts`) and the draft report `docs/acr.md` rest on
these checks. When you run them again, change `LAST_CHECK` in `src/lib/a11y.ts` and the date at the top of both
documents in the same change.

## Before you start

Start a development server on an empty database, with the mailbox the tests read:

```
NEXT_DIST_DIR=.next-a11y DATA_DIR=$(mktemp -d) DEV_OUTBOX=1 APP_URL=http://localhost:3851 npx next dev -p 3851
```

The scripts below need Playwright with Chromium (`npx playwright install chromium`) and `axe-core`, which is a
development dependency of this project. Each script makes its own account, sends its own documents and signs them.

`npm test` runs all three for you when `A11Y_URL` is set to the address of such a server
(`A11Y_URL=http://localhost:3851 npm test`, file `tests/ds-a11y.test.ts`). Without it, or without a browser, the
browser tests are skipped and say so.

## 1. axe-core on every state

```
node tests/a11y/axe-states.cjs http://localhost:3851
```

It runs axe-core (rules for WCAG 2.0, 2.1 and 2.2 at levels A and AA, and axe's best practices) on each of these, at
320 and at 1280 pixels wide:

- the signing page: the access code screen, the consent screen, the document, the signature box, the stamp box, the
  check before finishing, the done screen, and the screen after declining;
- the editor: the start, a draft with a file and a person, the fields step and the review step;
- the page of a document that is out.

It also checks that no page scrolls sideways at 320 pixels, which is what a 1280 pixel screen shows at 400 percent
zoom. It writes axe-results.json and a screenshot of each state to the output folder, and ends with exit code 3 when
anything is serious or critical.

What it found on 21 November 2026, and what was done:

| Where | Finding (impact) | Done |
| --- | --- | --- |
| Page of a document that is out | "Email not delivered" badge: amber text on light amber, contrast 3.25 to 1 (serious) | Darker text, 5.8 to 1 (`src/app/globals.css`, `.badge.expired`). |
| Editor, fields step | The document's name above its pages: grey on beige, 4.4 to 1 (serious) | Written in the normal text colour (`src/components/editor/StepFields.tsx`). |
| Editor, every step | No main landmark and no level-one heading (moderate) | The editor is a `main` with a heading for screen readers that names the step (`src/components/Editor.tsx`). |
| Signing page, every state | Nothing serious or critical | |
| Editor and signing page | Some content outside a landmark region (moderate) | Not changed. Named under "What does not work yet" on /accessibility. |

After the changes: no serious or critical finding in any of the 26 states, and no sideways scrolling at 320 pixels.

## 2. Signing with the keyboard alone

```
node tests/a11y/keyboard-sign.cjs http://localhost:3851 320
node tests/a11y/keyboard-sign.cjs http://localhost:3851 390
node tests/a11y/keyboard-sign.cjs http://localhost:3851 1280
```

The script uses only Tab, Shift+Tab, Enter, Space and typing. It ticks the consent box, presses Continue, presses
Next, adopts a typed signature in the box that Next opened, presses Next again, types into the text field that has
the focus, ticks an optional box, and presses Finish. It then asks the server whether the document was signed. At
each step it logs what has the focus, what a screen reader is told, whether a focus ring shows, and the size of the
target. The log is kbd-<width>.log in the output folder (tests/out/a11y unless A11Y_OUT says otherwise).

To do the same by hand: open a signing link, put the mouse away, and use Tab to reach the consent tick, Space to
tick it, Enter on Continue, then Enter on Next for each field.

What was found on 21 November 2026, at all three widths:

- Every step was reached and the document was signed. The server recorded it as completed.
- Next moves the focus to the field: it opens the signature box with the focus inside it, and on a phone it opens
  the box for typing with the text field focused. On a large screen it focuses the text field on the page.
- After the signature box closes, the focus comes back to Next.
- A focus ring was visible on every control that took the focus.
- The done screen puts the focus on its heading, so a screen reader reads "All done" first.

## 3. What a screen reader is told

The keyboard script logs, for each control, its accessible name as the browser computes it, `aria-required`, and the
name of the group around it. What it logged on 21 November 2026:

- The signature field: "Signature, required. Sign here" (the words come from `fieldName` and `FLAG` in the signing
  page), inside the group "Page 1".
- A text field on a phone, where it opens a box to type in: "Plot number, required. Empty. Opens a box to type in",
  inside the group "Page 1". On a large screen it is a text box named "Plot number" with `aria-required` true.
- An optional tick box: "Send me news, optional", inside the group "Page 1".
- The signature box: a dialog named "Your signature", with tabs Type, Draw and Upload.

Each page's fields sit in a group named "Page 1", "Page 2" and so on (`pageFields` in the signing page), so a screen
reader names the page when the focus moves into it. Groups are announced by VoiceOver and NVDA when the focus enters
them; that was not tried on either, only read from the accessibility tree.

## 4. Zoom to 400 percent

400 percent zoom on a screen 1280 pixels wide leaves 320 pixels of width. Steps 1 and 2 run at 320 pixels, and step 1
checks that nothing scrolls sideways. To try it by hand: open the signing page in a desktop browser, press Ctrl and +
(or Cmd and + on a Mac) until it reads 400 percent, and sign.

## 5. Target sizes

Success criterion 2.5.8 asks for targets of at least 24 by 24 pixels. On the signing page:

- Buttons are at least 44 pixels tall (`src/app/styles/sign.css`).
- On a phone, every field takes a tap 44 pixels across, even when the field drawn on the page is smaller.
- On a large screen, a tick box or round button drawn smaller than 24 pixels still takes a click 24 pixels across.
  Text, signature and stamp fields take the size the sender drew; on a large screen they are rarely smaller, and are
  spaced apart on the page.

The keyboard script logs the size of each target it reaches, including the larger click area of a small tick box.

## 6. The editor without dragging

Success criterion 2.5.7 asks that anything done by dragging can also be done without it.

```
node tests/a11y/keyboard-editor.cjs http://localhost:3851
```

It opens the fields step, reaches the Signature field type with Tab, presses Enter (the field lands on the page that
is in view), and presses Shift and the right arrow five times. On 21 November 2026 the field moved 5 percent of the
page width to the right, as saved by the server. The size of a selected field can be typed in its settings, and the
editor's Keyboard help lists the keys.

## Not checked

- VoiceOver on an iPhone and NVDA on Windows (see the top of this document).
- The emails, the operator screens, Settings and the public pages other than /accessibility.
- The signed PDF. It is not a tagged PDF.
- Right-to-left languages with a screen reader.
