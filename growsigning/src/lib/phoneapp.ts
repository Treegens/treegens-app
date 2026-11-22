// GrowSigning on a phone's home screen: the words, the numbers and the rules that the manifest, the service worker,
// the share route, Home and /help share. No imports and no side effects, so pages, the server and the tests can all
// use it (research/docusign-gaps.json, batch "phone-app"; research/ux-notes.json, key "ds-phone-app").

/** Where Android sends a file shared into GrowSigning from another app (src/app/share-target/route.ts). */
export const SHARE_ACTION = '/share-target';
/** The name of the form part the shared files come in. The same name as an upload's, so one reader takes both. */
export const SHARE_FIELD = 'file';
/** What can be shared in: what an upload takes without a converter. */
export const SHARE_ACCEPT = ['application/pdf', 'image/png', 'image/jpeg', '.pdf', '.png', '.jpg', '.jpeg'];
/** How many files one share may carry. Pictures shared together become one document, so this counts PDFs. */
export const MAX_SHARED_DOCUMENTS = 10;

/** What a share posted from another website is told. */
export const SHARE_FROM_ELSEWHERE = 'This file was sent from another website, so it was not added. To add a file, share it from your phone or upload it in GrowSigning.';

/**
 * What the share page does with the Origin header before the API checks it. A share from the phone's own menu may say
 * "Origin: null" with Sec-Fetch-Site "none": that is no other website, so the header is dropped. Any other
 * "Origin: null" (a sandboxed frame or data: page of another site, or a browser that does not say which site) is
 * refused, since nothing shows it came from the phone.
 */
export function shareOrigin(origin: string | null, fetchSite: string | null): 'keep' | 'drop' | 'refuse' {
  if (origin !== 'null') return 'keep';
  return (fetchSite || '').toLowerCase() === 'none' ? 'drop' : 'refuse';
}

/** The manifest's share target. Android only: an iPhone has no way for a website to receive a shared file. */
export const shareTarget = () => ({
  action: SHARE_ACTION,
  method: 'POST' as const,
  enctype: 'multipart/form-data' as const,
  params: { title: 'title', text: 'text', files: [{ name: SHARE_FIELD, accept: SHARE_ACCEPT }] },
});

// ---- The one line on Home ----------------------------------------------------------------------------------------

// The line on Home on a phone (src/components/InstallHint.tsx) is "home.add_to_home_screen" in src/locales/en.json.
/** How many visits from a phone show the line, unless it is dismissed first. */
export const INSTALL_VISITS = 3;
/** What it is, said everywhere it is offered. */
export const NOT_IN_STORES = 'This is the website saved as an app. It is not in the app stores.';
/** The id of the answer on /help that the line opens. */
export const INSTALL_HELP_ID = 'home-screen';

/** The steps, by phone. Safari is the only browser on an iPhone that can add a website to the home screen. */
export const IPHONE_STEPS = ['Open GrowSigning in Safari and press the Share button (the square with an arrow, at the bottom or the top).', 'Choose Add to Home Screen, then Add.'];
export const ANDROID_STEPS = ['Open GrowSigning in Chrome and press the menu (three dots, top right).', 'Choose Add to home screen (on some phones it is called Install), then follow the steps on the screen.'];

/** What the home-screen app does not do. README and /help say the same. */
export const CANNOT = [
  'It is not in the App Store or Google Play.',
  'It does not read the chip of an ID card or passport.',
  'It sends no notifications. Emails still tell you when something needs you.',
  'Signing needs an internet connection, in the app as in the browser.',
  'Sharing a file into GrowSigning from another app works on Android only. On an iPhone, open GrowSigning and upload the file.',
];

/** What it does, in one paragraph for /help. */
export const WHAT_IT_DOES = 'It opens GrowSigning from an icon, full screen, without the browser around it. On an iPhone the saved app keeps its own sign-in, apart from Safari, so you sign in once more inside it. On Android you stay signed in as you are in the browser, and you can share a PDF or photos from another app straight into a new document. When there is no connection it shows a page that says so, instead of an error.';

// ---- Cleaner scans -----------------------------------------------------------------------------------------------

// The line under a document made from photos that were cleaned, and its "Undo cleanup" button
// (src/components/editor/CleanedLine.tsx), are "editor.cleaned" and "editor.undo_*" in src/locales/en.json.
/** The Help answer on cleanup (src/app/help/homescreen.tsx), apart from the home-screen one so it can be found. */
export const CLEANUP_HELP_ID = 'photo-cleanup';
export const CLEANUP_HELP = 'When you add photos of a paper page, your browser looks for the page in each photo, straightens it and makes the writing darker, before anything is sent. If it looks wrong, choose Undo cleanup under the file. The photo is kept with the document, before cleanup, and is in its evidence pack. A large photo is made smaller first, like every large photo you add, so it may not be the camera\'s own file.';
/** The line in the evidence pack's README. */
export const CLEANED_EVIDENCE = 'scan-photos/          for each document whose pages were cleaned from a photo before sending (edges found, straightened, contrast raised, in the sender\'s browser): the photo the sender\'s browser sent as the one it cleaned the page from, before cleanup. When a photo was large, GrowSigning\'s page made it smaller first, so it may not be the camera\'s own file. GrowSigning keeps the photo it was given and does not check that the page was made from it. The cleaned page in the PDF is what people saw and signed; the photos were not signed. scan-photos/index.csv names the document, the page and the SHA-256 of each photo.';
