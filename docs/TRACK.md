# treegens.app/track: tree tracking with no crypto

`/track` is the planting app's filming screen with the crypto taken out. A planter
films the land ("before") clip and the plant ("after") clip of each tree exactly as they
would for a planting, and every tree shows up on a public dashboard at
`/track/dashboard` with both videos to watch and download.

What is the same as a planting:

- The same screen (`PlantingCapture`): in-page camera, GPS fixed at the start and end of
  filming plus the walked path, the record-only rule, the GPS readiness gate, recovery
  after a kill or reload, and camera-app trip recovery.
- The same durable upload: each clip is saved on the phone the moment it lands, queued
  in IndexedDB, and sent in resumable chunks by the page or the service worker. It
  survives no signal, a locked screen, an app update and a closed app.
- The same counting rule: for mangroves the AI count from the plant clip (same counter
  and sweep as the GWR clips), and for any other tree the planter's own count.

What is gone: sign-in, wallets, verifiers, MGRO, OTC, the vesting note and the wallet
browser notice. The planter types their name once (kept on the phone). Nothing in
`/track` reads or writes submissions, users, rewards or MGRO.

## Where the code is

Two repos, each one commit on branch `claude/track-no-crypto` (local to the session that
built it; push access to those repos was not granted). The same commits are saved as
patches in [`docs/track-patches/`](track-patches/):

- `treegens-backend-main.patch` applies to `Treegens/treegens-backend` `main` at `4723351`.
- `treegens-web-lang-en.patch` applies to `Treegens/treegens-web` `lang-en` at `e3ef54f`.

Apply with `git am docs/track-patches/<file>.patch` on a branch made from that commit.

### Backend: `Treegens/treegens-backend` (live API on Render)

| File | What |
|---|---|
| `src/models/TrackClip.ts` | One row per clip (`kind: land/plant`). The land clip's `_id` is the tree id. |
| `src/services/trackService.ts` | Stores a clip, links plant to land (same phone only), dashboard list, totals, CSV, URL list, delete. |
| `src/routes/track.ts` | `/api/track/*`: upload sessions (same protocol as plantings), `GET /trees`, `/trees/:id`, `/totals`, `/trees.csv`, `/urls.txt`, `/config`, admin `DELETE /trees/:id`. |
| `src/services/uploadSessionService.ts` | A session created on the track route gets `channel: 'track'` and is stored by `trackService`, never as a Submission. Never guesses a land by filming time. |
| `src/routes/uploadSessions.ts` | Routes built by `buildUploadSessionRouter(auth)`, so `/api/track/uploads` reuses them behind a phone-id check. |
| `src/services/gwrAiCountService.ts` | The AI sweeps take a target collection. GWR behaves exactly as before; track counts mangrove plant clips only. |
| `src/models/GwrVideo.ts`, `src/config/gcs.ts`, `src/server.ts` | Shared AI fields, bucket label, mounting and the second sweep. |
| `src/routes/track.routes.test.ts` | 13 end-to-end tests through the real session protocol. |

A phone identifies itself with a random UUID in the `x-track-device` header. It is not
a secret and is never returned by the API. It only scopes upload sessions, so a phone's
plant clip finds that phone's land clip and no other.

Env: nothing new is required. It uses the existing `GCS_BUCKET` (objects under `track/`)
and the existing AI counting settings. Optional: `TRACK_ADMIN_KEY`. When set, it allows
deleting a tree with `x-track-admin-key`. When unset, deleting is off.

### Web: `Treegens/treegens-web`, branch `lang-en` (serves treegens.app)

| File | What |
|---|---|
| `src/components/capture/PlantingCapture.tsx` | The planting screen moved here unchanged, with a `track` prop. |
| `src/app/submissions/create/page.tsx` | Renders `<PlantingCapture />`. The planting flow is unchanged. |
| `src/app/track/page.tsx`, `layout.tsx` | `<PlantingCapture track />`. Phone-only, public, noindex. |
| `src/app/track/dashboard/page.tsx` | The dashboard: totals, planters, filters by planter and day, before/after players, downloads, CSV, URL list. Refreshes every 30 s. |
| `src/services/trackIdentity.ts`, `trackApi.ts` | Phone id and planter name; dashboard reads. |
| `src/services/uploadManager.ts`, `uploadQueueStore.ts`, `chunkedUpload.ts`, `public/sw.js` | A clip can carry `track: { device, planterName }`. It is then sent to `/api/track/uploads` with the phone id and never with the sign-in token, by the page and by the service worker. |
| `src/utils/clipDrafts.ts`, `treeLinks.ts` | Track has its own draft slots and its own "open tree", so a planting's clip can never be sent as a tracked tree, or the other way round. |
| `appConfig.ts`, `AuthGuard`, `MobileGate`, `verifierDesktop.ts`, `seo.ts`, `HomeButton`, `SupportChat` | Routes, public access, phone-only `/track`, full-width dashboard, noindex, no home button or support chat. |

## Shipping it

Not deployed. In order:

1. **Backend first.** Merge `claude/track-no-crypto` into `Treegens/treegens-backend` and
   let Render deploy `treegens-backend-1eyq`. Check `GET /api/track/config` answers
   `{ aiCountEnabled, adminEnabled }`. The web app must not ship before this: until the
   route exists, tracked clips wait on the phone and do not upload.
2. **Web.** Merge into `lang-en` of `Treegens/treegens-web` and release with the
   protected `bash release.sh` (draft, look at it, then type `yes`). No domain change is
   involved: `/track` is a new path on the existing `treegens-english` site.

## Tests run

- Backend: full suite, 2666/2666, plus the 13 new track route tests.
- Web: upload manager 186/186 (3 new), chunked upload 32/32 (3 new), service worker
  upload queue 33/33 (1 new) and queue write 8/8, drafts restore, signed-in hydration (page list), verifier desktop, clip
  keeper, recovered pick, in-page recording. `test-clip-drafts` has one failure that is
  already there on `lang-en` without these changes.
- Production build (`next build --webpack`) and a browser smoke test of `/track` on a
  phone, `/track` on a desktop (refused, as for plantings), and the dashboard on desktop
  and phone.
