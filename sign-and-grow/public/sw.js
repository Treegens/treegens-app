// GrowSigning's service worker, for the app saved to a phone's home screen. It keeps only what every visitor gets
// alike: the built scripts and styles, the fonts, the brand icons, and one page that says there is no connection.
// It never keeps a page, a document or an answer of the API, nothing under /sign, /api, /f or /agree, and no address
// that carries a query or a token. Those go to the network as if there were no service worker at all.
// It is registered by the app's own pages only, for /app (src/components/ShellWorker.tsx), so a signing page is
// never under it. tests/ds-phone-app.test.ts runs the handlers below with a pretend browser.
//
// VERSION ends with the start of the SHA-256 of offline.html: change the page and the test asks for a new VERSION.
// A new VERSION drops every cache of an older one when it takes over.
const VERSION = 'growsigning-shell-2-71b893f6';
const OFFLINE = '/offline.html';
const PRECACHE = [OFFLINE, '/brand/icon-192.png'];
// The built files have their content's hash in their name, so a kept copy is always right. Kept up to this many.
const MOST = 300;

const NEVER = /^\/(sign|api|f|agree|embed|check|verify|login|signup|invite|reset|auth|share-target)(\/|$)/;
const KEEP = /^\/(_next\/static\/|fonts\/|brand\/|pdfjs\/)/;
// The page for signing in person without signal (src/app/in-person/page.tsx) is the one page that is kept: it is the
// same for every visitor and holds nothing of anyone. What it shows comes from the device's own encrypted store
// (src/components/sign/offlineInPerson.ts), never from this cache. Kept under its bare address only.
const IN_PERSON = '/in-person';

/** Whether this request's answer may be kept. Only the same site's static files, asked for with GET and nothing more. */
function mayKeep(request, origin) {
  if (request.method !== 'GET') return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  // A query can carry a token or a person's data, and the static files never need one.
  if (url.search || url.hash) return false;
  if (/token|code|key|secret/i.test(url.pathname)) return false;
  if (NEVER.test(url.pathname)) return false;
  return url.pathname === OFFLINE || KEEP.test(url.pathname);
}

/** Whether an answer is fit to keep: complete, from our own site, and not marked as never to be stored. */
function fitToKeep(response) {
  if (!response || !response.ok || response.status !== 200 || response.type !== 'basic') return false;
  const cc = (response.headers && response.headers.get('cache-control')) || '';
  return !/no-store|private/i.test(cc);
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MOST; i++) await cache.delete(keys[i]);
}

async function fromCacheOrNetwork(request) {
  const cache = await caches.open(VERSION);
  const kept = await cache.match(request);
  if (kept) return kept;
  const fresh = await fetch(request);
  if (fitToKeep(fresh)) {
    await cache.put(request, fresh.clone());
    await trim(cache);
  }
  return fresh;
}

/** A page of the app: always from the network, never kept. With no connection, the page that says so. */
async function page(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const cache = await caches.open(VERSION);
    const offline = await cache.match(OFFLINE);
    if (offline) return offline;
    throw err;
  }
}

/** The in-person page: from the network when there is one (and kept), else the kept copy, else the offline page. */
async function inPersonPage(request) {
  const cache = await caches.open(VERSION);
  try {
    const fresh = await fetch(request);
    if (fitToKeep(fresh)) await cache.put(IN_PERSON, fresh.clone());
    return fresh;
  } catch (err) {
    const kept = (await cache.match(IN_PERSON)) || (await cache.match(OFFLINE));
    if (kept) return kept;
    throw err;
  }
}

function onFetch(event) {
  const request = event.request;
  const origin = self.location.origin;
  if (request.mode === 'navigate' && request.method === 'GET') {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return;
    }
    if (url.origin === origin && url.pathname === IN_PERSON && !url.search) return event.respondWith(inPersonPage(request));
    // Only the app's own pages get the offline page; anything else is left to the browser.
    if (url.origin === origin && /^\/app(\/|$)/.test(url.pathname)) event.respondWith(page(request));
    return;
  }
  if (mayKeep(request, origin)) event.respondWith(fromCacheOrNetwork(request));
  // Everything else: no respondWith, so the browser does what it does without a service worker.
}

function onInstall(event) {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
}

function onActivate(event) {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('growsigning-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
}

self.addEventListener('install', onInstall);
self.addEventListener('activate', onActivate);
self.addEventListener('fetch', onFetch);
