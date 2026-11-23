// The name in a share link: growsigning.com/<name>, for example growsigning.com/garden-agreement. This file is plain
// rules and words, no database and no React, so the server, the sender's screen and the tests read the same ones.
//
// A name is small letters, digits and hyphens, SHARE_NAME_MIN to SHARE_NAME_MAX characters, starts with a letter or
// a digit and never has two hyphens in a row. It sits at the top level of the site, next to /login and /pricing, so
// three kinds of name are never given out:
//   1. RESERVED: every folder and file this site has or may get at its top level. tests/share-links.test.ts reads
//      src/app and public and fails when one of them is missing here, so a new page cannot be forgotten.
//   2. Names that read as ours: the product's own name in any spelling, "official" and "verified" anywhere, and a
//      name made only of words a company uses about itself ("billing-support", "account-security").
//   3. Names that read as a well-known brand's notice. That check needs the fake-notice filter, which is the
//      server's (src/server/sharelinks.ts runs it).

export const SHARE_NAME_MIN = 3;
export const SHARE_NAME_MAX = 60;

/** Top-level names the site uses or may use. A share link can never have one of these. */
export const RESERVED: ReadonlySet<string> = new Set((
  // What exists under src/app and public today.
  'accessibility agree api app apple-icon.png archive-confirm billing change-email check counter dev developers embed f favicon.ico features forgot '
  + 'globals.css help icon.svg impact in-person layout.tsx login manifest.ts manifest.webmanifest not-found.tsx opengraph-image.alt.txt opengraph-image.png '
  + 'opengraph-image page.tsx paid pricing procurement reset security share-target sign signin signup styles tco two-step-reset verify verify-email '
  + 'brand clickwrap.js fonts offline.html pdfjs sw.js videos _next '
  // What a site like this one may get, and what browsers, crawlers and mail programs ask for by themselves.
  + 'robots.txt sitemap.xml sitemap humans.txt ads.txt security.txt .well-known well-known apple-touch-icon.png apple-touch-icon browserconfig.xml '
  + 'crossdomain.xml index index.html home www www1 www2 mail email smtp imap pop ftp ns ns1 ns2 mx cdn static assets asset public private img images image '
  + 'media files file uploads upload download downloads css js javascript json xml rss atom feed feeds font icons icon logo favicon '
  + 'admin administrator root system sysadmin operator operators staff team teams internal intranet console dashboard panel portal manage manager management '
  + 'account accounts user users profile profiles me my you your settings setting preferences config configuration setup install '
  + 'log-in logout log-out sign-in sign-out signout sign-up register registration join invite invites invitation invitations auth oauth sso saml scim '
  + 'password passwords two-step twostep 2fa mfa otp code codes token tokens key keys session sessions cookie cookies '
  + 'support helpdesk help-desk help-center help-centre faq faqs contact contact-us about about-us company careers jobs press news blog blogs docs doc '
  + 'documentation guide guides tutorial tutorials learn academy community forum forums status health healthz ping uptime changelog roadmap '
  + 'legal terms terms-of-service tos privacy privacy-policy policy policies cookie-policy gdpr dpa imprint impressum compliance trust abuse report reports '
  + 'pay payment payments invoice invoices checkout order orders cart shop store plans plan price prices subscribe subscription subscriptions '
  + 'upgrade trial free credits refund refunds donate '
  + 'signing signer signers signature signatures signed esign e-sign esignature document documents envelope envelopes template templates form forms '
  + 'powerform powerforms bulk inbox outbox send sent draft drafts contacts agreements agreement-terms certificate certificates audit records archive '
  + 'api-docs openapi openapi.json swagger graphql webhook webhooks callback callbacks integrations integration developer partners partner affiliate '
  + 'affiliates referral referrals refer r s u e d t p q go to link links share shared sharing qr new edit delete remove create search explore '
  + 'trees tree mangrove mangroves planting impact-report demo example examples sample samples test tests testing null undefined true false nan '
  + 'en es fr de pt it nl ja ko zh ar hi ru th km mobile ios android download-app '
  // Pages a site like this one gets sooner or later, and names that mail programs, phones and scanners ask for.
  + 'unsubscribe welcome start get-started getting-started onboarding enterprise customers customer product products solutions solution business sales '
  + 'contact-sales apps offline thanks thank-you done success error errors complete completed open view review reviews compare alternatives vs '
  + 'case-studies webinar webinars newsletter notifications notification events event stories story resources resource tools tool use-cases usecases '
  + 'why how-it-works tour overview book-a-demo book-demo get-demo quote quotes offer offers deals deal promo coupon gift gifts friend friends '
  + 'apple-app-site-association assetlinks.json wp-admin wp-login wp-login.php wp-content xmlrpc.php cgi-bin phpmyadmin postmaster webmaster hostmaster '
  + 'mailer-daemon noreply no-reply donotreply do-not-reply owner ceo founder founders moderator moderators mod sales-team hr it legal-team abuse-team '
  + 'trust-and-safety sign-here signhere verify-email confirm confirm-email activate activation unlock recover recovery restore').split(' '));

/**
 * Words a company uses about itself, and the words of an alarming notice ("your account is suspended", "pay now",
 * "urgent action required"). A name made only of these reads as a page or a notice of ours, not as a document.
 */
const OUR_WORDS = new Set(('official verified support help helpdesk desk service services customer care center centre billing bill payment payments pay '
  + 'account accounts security secure verification verify alert alerts notice notification notifications department team admin online login signin '
  + 'password reset update updates confirmation confirm info mail email refund refunds invoice invoices order orders the of and for by from at my your '
  + 'suspended suspension suspend expired expires expiring expiry urgent overdue due action required immediately immediate now here page pages site portal '
  + 'document documents doc docs file files message messages is are was has been will be you we our us it hr legal abuse trust safety compliance fraud '
  + 'sign signing in on out log access restore restored locked lock unlock unusual activity identity id warning important final last attention review '
  + 'pending failed failure declined problem issue limited restricted blocked disabled closed closing deactivated validate validation authenticate '
  // Names that are also plain words or surnames: only refused when the whole name is made of words from this list.
  + 'bank banking tax taxes gov government america chase apple visa amazon meta delivery parcel package shipping statement wire transfer').split(' '));
/** Words that claim a standing nobody can check. Refused anywhere in a name. */
const CLAIMS = ['official', 'verified', 'certified'];
/**
 * Other signing services, and the banks, shops, mail services and tax offices whose name fake notices borrow most. A
 * share link sits on this site's own address, so none of them is ever part of one, as a word or run together.
 */
const BRANDS = ('docusign adobesign adobe acrobat dropboxsign dropbox hellosign pandadoc signnow signwell docuseal echosign rightsignature '
  + 'paypal netflix microsoft office365 outlook hotmail google gmail icloud facebook instagram whatsapp linkedin coinbase binance '
  + 'bankofamerica wellsfargo citibank barclays santander natwest lloydsbank mastercard americanexpress westernunion moneygram fedex').split(' ');
/** The short ones, which only count as a whole word ("irs-tax-refund"), never inside another ("first"). */
const BRAND_WORDS = new Set('irs hmrc hsbc dhl ups usps amex fargo citi xero'.split(' '));

/**
 * How the eye reads a name: hyphens dropped, and every character that passes for another read as that other one. A
 * digit for a letter (0 o, 1 i, 3 e, 5 s, 9 g, 4 a), a small L for an i, q for g, and two v for a w.
 */
const squash = (name: string) => name.replace(/-/g, '').replace(/0/g, 'o').replace(/[1!|l]/g, 'i').replace(/3/g, 'e').replace(/5/g, 's').replace(/9/g, 'g').replace(/4/g, 'a')
  .replace(/q/g, 'g').replace(/vv/g, 'w');
const OURS = ['growsigning', 'growsignin', 'growsign', 'treegens', 'treegen'].map(squash);
// One letter swapped, dropped or added still reads as the name at a glance ("grovsigning", "treegems").
const NEAR = ['growsigning', 'treegens'].map(squash);
function within1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
function looksLikeOurs(eye: string): boolean {
  if (OURS.some((o) => eye.includes(o))) return true;
  for (const o of NEAR) for (const len of [o.length - 1, o.length, o.length + 1]) for (let i = 0; i + len <= eye.length; i++) if (within1(eye.slice(i, i + len), o)) return true;
  return false;
}

/**
 * A name made from a document's name: accents taken off, small letters, everything else turned into single hyphens,
 * cut to SHARE_NAME_MAX at a word. "Garden Agreement (v2).pdf" gives "garden-agreement-v2-pdf". A name with no Latin
 * letter or digit at all gives '' and the caller falls back to "document".
 */
export function shareNameFrom(text: unknown): string {
  let s = String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[øØ]/g, 'o').replace(/[łŁ]/g, 'l').replace(/[đĐ]/g, 'd')
    .toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > SHARE_NAME_MAX) {
    const cut = s.slice(0, SHARE_NAME_MAX + 1);
    const at = cut.lastIndexOf('-');
    s = (at >= SHARE_NAME_MAX / 2 ? cut.slice(0, at) : s.slice(0, SHARE_NAME_MAX)).replace(/-+$/g, '');
  }
  return s;
}

/** What someone typed as a name, tidied the way shareNameFrom tidies a document's name. */
export const tidyShareName = (typed: unknown) => shareNameFrom(String(typed ?? '').trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/^\/+/, ''));

/** Whether this text is written the way a share name is written. Nothing else is ever looked up. */
export const isShareName = (s: unknown): s is string =>
  typeof s === 'string' && s.length >= SHARE_NAME_MIN && s.length <= SHARE_NAME_MAX && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);

/** Why a name cannot be a share link, in words for the sender, or null when its form and its words are fine. */
export function shareNameProblem(name: string): string | null {
  if (typeof name !== 'string' || !name) return 'Type a name for the link: letters, digits and hyphens.';
  if (name.length < SHARE_NAME_MIN) return `A link name has at least ${SHARE_NAME_MIN} letters or digits.`;
  if (name.length > SHARE_NAME_MAX) return `A link name has at most ${SHARE_NAME_MAX} characters. This one has ${name.length}.`;
  if (!isShareName(name)) return 'A link name is made of small letters, digits and single hyphens, and starts and ends with a letter or a digit.';
  if (RESERVED.has(name)) return `"${name}" is the address of a page of this site, so it cannot be a share link. Add a word to it, for example "${name}-agreement".`;
  // A name that is all digits reads as a code or an id, not as a document.
  if (/^[0-9-]+$/.test(name)) return 'A link name needs at least one letter, so that it reads as the name of a document.';
  const eye = squash(name);
  if (looksLikeOurs(eye)) return 'A link name cannot hold the name of this service or of Treegens, or a name that looks like one of them: the link would read as a page of ours.';
  const words = name.split('-');
  const flat = name.replace(/-/g, '');
  const brand = BRANDS.find((b) => flat.includes(b) || eye.includes(squash(b))) || words.find((w) => BRAND_WORDS.has(w));
  if (brand) return `A link name cannot hold "${brand}": the link would read as a page of theirs. Name it after your own document.`;
  const claim = words.find((w) => CLAIMS.includes(w));
  if (claim) return `A link name cannot hold the word "${claim}": nobody opening it could check that.`;
  if (words.every((w) => OUR_WORDS.has(w) || /^\d+$/.test(w))) return `"${name}" reads as a page of this service, not as a document. Add a word that says what the document is, for example "${name}-agreement".`;
  return null;
}

/** The first of name, name-2, name-3, ... that `free` accepts, each cut to fit. */
export function nextFreeName(name: string, free: (candidate: string) => boolean): string | null {
  if (free(name)) return name;
  for (let n = 2; n < 500; n++) {
    const tail = `-${n}`;
    const candidate = `${name.slice(0, SHARE_NAME_MAX - tail.length).replace(/-+$/g, '')}${tail}`;
    if (free(candidate)) return candidate;
  }
  return null;
}

/** The link as it is written out for a person: without "https://", which nobody types. */
export const shareLinkShown = (url: string) => String(url || '').replace(/^https?:\/\//i, '');

/** Why a share link does not take anyone to a document right now, as the page says it. */
export type ShareState = 'open' | 'off' | 'renamed' | 'completed' | 'voided' | 'declined' | 'expired' | 'paused' | 'unavailable';
