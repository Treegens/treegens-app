// Signing on a phone: which browsers show the document, what needs a connection, and how far the page zooms.
// Plain words and numbers with no imports, so the signing page, /help, the landing page and the tests share them.

// ---- Which browsers ----------------------------------------------------------------------------------
// The floor is the app itself: Next.js builds for Safari 16.4 and Chrome, Edge and Firefox 111. The PDF viewer is
// its legacy build (scripts/copy-assets.mjs), which runs on the same browsers. The modern build needed iOS 17.4.

/** The browsers the signing page is built for, in one paragraph. */
export const SIGNING_BROWSERS = 'On an iPhone or iPad: iOS 16.4 or newer, in any browser (every browser on an iPhone uses the same engine as Safari, the one inside a mail app too). On Android and on computers: Chrome, Edge or Firefox version 111 or newer, or Samsung Internet kept up to date. On a Mac: Safari 16.4 or newer. These are all from 2023 or later.';
/** The same in a few words, for the landing page. */
export const SIGNING_BROWSERS_SHORT = 'Any browser from 2023 or later works (on an iPhone, iOS 16.4 or newer). The help page lists them.';
/** What a signer needs from the connection. There is no offline signing: the server takes the time and the address. */
export const SIGNING_ONLINE = 'Signing needs an internet connection to open the document and again to finish.';
/** What happens when the signal drops in between. The signing page does this (src/components/sign/offline.ts). */
export const SIGNING_WEAK_SIGNAL = 'If the signal drops while you fill it in, your answers stay on the page and in that browser tab, and are saved when the connection is back. If it drops as you finish, the page asks whether it went through and says what it finds. When it cannot tell yet, it says so, keeps what you typed and tries again by itself once you are back online, as long as the page stays open. Trying again never signs twice. Nothing counts as signed until the page says you are done.';
/** The page sizes the signing page offers, as parts of the width of the screen. */
export const ZOOMS = [1, 1.5, 2];
/** What /help says about reading small print on a phone. */
export const SIGNING_ZOOM = 'Choose More, then 150% or 200%. The pages are drawn again at that size, so the words stay sharp, and you slide them sideways with a finger while the buttons at the top and bottom stay where they are. Pinching to zoom works too. Easy reading shows the words in one column at the size of your phone, with your fields in place, but pictures and layout are only in the page view, which is what your signature goes on.';
/** What was really tried, so the list above is not read as more than it is. */
export const SIGNING_TESTED = 'We test the signing page in Chrome, at phone and computer sizes, by touch and with a keyboard. We have not tested it on every phone, and not yet on a real iPhone.';
/** An iPhone that cannot be updated far enough. */
export const OLD_IPHONES = 'An iPhone 6s, 7 or first iPhone SE stops at iOS 15, which is too old.';
/** What to do when a browser cannot show the document. The signing page and /help say the same three things. */
export const CANNOT_SHOW_WAYS = ['Open the same link in another browser, or on another phone or computer, and sign there.', 'Download the PDF to read it now. You cannot sign the download itself.', 'Ask the sender to send it another way.'];
