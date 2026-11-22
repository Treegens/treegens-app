// "See what each person sees": the sender opens the signing page as one of the people on a draft, an envelope that
// is out, or a template, in a new tab, and nothing there is recorded or sent (src/server/preview.ts). The rules and
// words that the signing page and the server share. No environment in here, so a page may import it.

import { t, SOURCE_LOCALE } from './i18n.ts';

/** A preview link lasts this long from the moment it was made. Switching person in its band does not extend it. */
export const PREVIEW_MINUTES = 15;

/** Every preview token starts with this, so the signing page knows to talk to /preview/... instead of /sign/... */
export const PREVIEW_PREFIX = 'pv.';

export const isPreviewToken = (t: unknown): t is string => typeof t === 'string' && t.startsWith(PREVIEW_PREFIX);

/** What a button on the preview says when it is pressed, and what the server answers to anything that would change something. */
export const PREVIEW_NOTHING = t(SOURCE_LOCALE, 'preview.nothing');
