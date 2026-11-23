# GrokBot: daily Adobe Acrobat check for GrowSigning

Run this every day, in the morning, and also whenever I ask. Do it on this computer, with the desktop app
"Adobe Acrobat Reader" (the free app, NOT the Adobe website in a browser).

## The secret
Read the secret named GROWSIGNING_ACROBAT_TOKEN from your secret store. Never print it, never put it in a
file name, a URL, a log, a screenshot, a chat message or a report. Send it only in the HTTP header
"Authorization: Bearer <token>" to https://growsigning.com and nowhere else.

## Steps (do them for each service below, one after the other)
Services: first ts.ssl.com, then timestamp.digicert.com.

1. Download a fresh test file:
   GET https://growsigning.com/api/ops/acrobat-check/sample?tsa=<service>
   with the header Authorization: Bearer <token>.
   - 200: save the body as a .pdf in a temporary folder. Keep the value of the response header X-Check-Id
     (it looks like acr_...). Also note X-Tsa-Host and X-Tsa-Trusted.
   - 503: the time-stamp service is down. GrowSigning has already emailed Jimi. Note it in your report
     and go to the next service.
   - 404 with no "code" in the body: the token or the server setting is wrong. Stop and tell Jimi.
   - 429: wait one hour and try once more, then stop and tell Jimi.
   - Anything else: stop and tell Jimi the status code and the body.

2. Open that file in the Adobe Acrobat Reader desktop app (right-click, Open With, Adobe Acrobat Reader).
   Wait until the page is shown and the bar under the toolbar has appeared (up to 30 seconds). Do not sign
   in to Adobe and do not start any trial. Close any pop-up about trials or sign-in without accepting it.

3. Read the bar under the toolbar:
   - banner_text: its exact words (for example "Signed and all signatures are valid."). If there is no
     bar, use "".
   - banner_colour: "blue", "yellow", "red", "none" (no bar) or "other".

4. Click "Signature Panel" (right end of that bar, or the pen icon in the right-hand toolbar). Expand the
   first signature (the arrow next to "Rev. 1: Signed by ..."). Copy every line you can read in the panel,
   top to bottom, exactly as written, one line per entry (for example "Signature is valid:",
   "Source of Trust obtained from Adobe Approved Trust List (AATL).", "Document has not been modified since
   this signature was applied", "Signature is a document timestamp signature.", "Signature is not LTV
   enabled and will expire after ...").

5. Take one screenshot of the Acrobat window showing the bar and the open Signature Panel. Save it as PNG.
   If it is larger than 1.5 MB, scale it down until it is under 1.5 MB. Make sure nothing else on the
   screen is in it (no other windows, no notifications, no secrets).

6. Note the Acrobat Reader version (Help, About Adobe Acrobat Reader, or Acrobat Reader, About on a Mac)
   and the operating system with its version (for example "macOS 15.2").

7. Send the result:
   POST https://growsigning.com/api/ops/acrobat-check/result
   Headers: Authorization: Bearer <token>, Content-Type: application/json
   Body (JSON):
   {
     "check_id": "<X-Check-Id from step 1>",
     "banner_text": "<step 3>",
     "banner_colour": "<step 3>",
     "panel_lines": ["<step 4, one string per line>"],
     "acrobat_version": "<step 6>",
     "os": "<step 6>",
     "screenshot_png_base64": "<the PNG from step 5, base64>",
     "notes": "<anything odd you saw, or leave out>"
   }
   - 200: the answer says "verdict": "pass" or "fail". GrowSigning decides, not you. On "fail" it has
     already emailed Jimi.
   - 400: the answer names the "field" that was wrong. Fix that field and send again with the same
     check_id (it stays open).
   - 409 already_reported: you already sent this one. Do not send again.
   - 404 with "code": "unknown_check": the check_id was wrong. Start again from step 1 for this service.
   - 404 with no code, or 429: stop and tell Jimi.

8. Close the file in Acrobat and delete the downloaded PDF and the screenshot from the temporary folder.

## Report to me
One short message: for each service, the verdict, the banner text, and anything odd. Do not send the
token or the screenshot to me. If both are "pass", one line is enough: "Acrobat check: SSL.com pass,
DigiCert pass."

## Never
- Never change any Acrobat setting (especially trust settings, Preferences, Signatures).
- Never sign, edit, save or share the PDF.
- Never call any other GrowSigning address, and never send the token anywhere but growsigning.com.
