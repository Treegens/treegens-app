# Site Check: pause before you plant

Site Check asks planters to check a spot **before** they plant mangroves
there. It gives one of four plain-language verdicts. It also runs a satellite
check of how often the tide covers the spot.

It is based on the CBEMR workshop pack:

- IUCN Mangrove Specialist Group, *Pause before you Plant* (2020).
- Ellison et al., *Manual for Mangrove Monitoring in the Pacific Islands
  Region* (SPREP, 2012).
- Jean Yong's comparative mangrove species ID chart.

The core lessons from those documents:

- Most mass mangrove planting fails because of **where** it is done:
  - low tidal mudflats and seagrass meadows that never held mangroves
  - sites where the cause of loss was never fixed
- Mangroves grow between mean tide and high tide, on sheltered, muddy shores.
  Each species sits at its own height in that band.
- Restoring tidal flow is often enough. Where wild seedlings already arrive,
  planting may not be needed at all.
- Planting one or two easy species creates weak stands.

The IUCN piece names the failure mode directly: "poorly designed incentives
combined with a lack of basic ecological knowledge". Treegens pays per tree,
so Site Check is the counterweight.

## The planter's flow

1. **Mark the site.**
   - Walk the boundary with GPS, or
   - take a circle of 10 to 100 m around where you stand.
2. **Answer about ten questions**, mostly by tapping chips:
   - what was here before
   - what covers the ground now
   - how often the tide reaches the spot
   - high-tide depth compared with the nearest natural mangroves
   - whether anything blocks tidal flow
   - what destroyed the mangroves, and whether it still happens
   - whether wild seedlings are arriving
   - wave exposure and erosion
   - ground type
   - distance to the nearest natural mangroves

   Two optional measurements come from the manual: the canopy impact score
   (0 to 5) and the height of the tide stain on nearby trunks.

   The answers are saved on the phone, so the questions can be filled in
   offline.
3. **Take photos:**
   - a slow 360 at low tide (required)
   - the ground (required)
   - the tide line on a trunk with a stick for scale (optional)
   - the same spot at high tide (optional)
4. **See the verdict.** It appears straight away from the field answers.
   It is updated when the satellite check finishes, usually within a few
   minutes.
5. **Submit for review.** Verifiers vote on whether the photos and answers
   are honest and match the place.

When filming a planting, the planter picks the checked site. For mangroves
they can also pick the species they planted.

## Verdicts

| Verdict | Shown as | Typical reasons |
|---|---|---|
| `plant` | Plant here | Former mangrove, tide reaches it, nothing blocking, no natural regrowth |
| `fix_first` | Fix first | Tidal flow blocked, including a pond that stays flooded behind its walls; the cause of loss is still active (cut mangroves always ask whether cutting continues); tide reach, history on open ground, wave exposure or wild seedlings unknown; exposed shore; salt crust; no natural mangroves nearby to compare with |
| `let_regrow` | Protect it and let it regrow | Healthy forest already here, or wild seedlings arriving |
| `not_suitable` | Not a mangrove site | Seagrass; always underwater; tide never reaches it; floods much deeper than nearby natural mangroves; rock or rubble; open ground that never held mangroves; exposed and eroding |

Precedence:

1. Healthy forest always means `let_regrow`, because protecting it beats
   planting into it.
2. Any blocker means `not_suitable`.
3. Natural regrowth means `let_regrow`.
4. Anything to fix or check means `fix_first`.
5. Otherwise, `plant`.

Each verdict lists the reasons behind it, marked as coming from the field
answers or from the satellite.

For `plant` and `fix_first`, the verdict also recommends:

- a zone: seaward, middle or landward
- species for that zone, filtered by the country's region (East Africa,
  Indo-West Pacific, Pacific islands, Atlantic and East Pacific)
- for `plant` only, when the zone has at least three suitable species, a
  nudge to plant a mix of at least three

The rules live in one pure module, so the phone and the server compute the
same verdict:

- `treegens-backend-main/src/siteCheck/siteVerdict.ts`
- the species list in `mangroveSpecies.ts` next to it
- an identical copy in `treegens-web-main/src/modules/siteCheck/`

A backend test fails if the two copies drift apart.

## Satellite hydrology check

The question: **how often is this spot under water, compared with where
nearby mangroves stop growing?**

### Method

Sentinel-2 passes every coastline about every 5 days, always at about 10:30
local solar time. Because the main lunar tide drifts against that fixed
time, the passes catch many different tide stages. Over 2 years that is 100
to 300 usable images per site.

The sampling is not truly random, though. The solar part of the tide is
locked to the overpass time, so at some places the biggest spring highs or
lows may never be imaged (tidal aliasing). Comparing each site with its own
local fringe, imaged on the same dates, cancels much of this bias.

For every 10 m pixel around the site:

1. Keep clear observations: Sentinel-2 scene classes vegetation, bare soil,
   water, unclassified or dark area (clouds and shadows are dropped).
2. Call a pixel wet when NDWI > 0. NDWI = (green - NIR) / (green + NIR).
3. Wet fraction = wet observations / clear observations. A pixel needs at
   least 15 clear observations to count.

Mangrove canopy hides the water under it, so mangrove pixels themselves read
as dry. The useful reference is the **fringe**: non-mangrove pixels that sit
within two pixel steps of mapped mangroves (ESA WorldCover 2021, class 95)
and do get wet. A step is up, down, left or right; diagonal neighbours are
not counted, which matches how the calibration was measured. The wet fraction
there marks the lowest elevation the local mangroves tolerate.

Only images where at least half the site is clear are used. The site and its
fringe are always measured on the same images.

The site's median wet fraction is then classified:

| Class | Rule (checked in order) | Feeds the verdict as |
|---|---|---|
| `insufficient_data` | under half the site has 15+ clear observations | info only |
| `existing_mangrove` | half or more of the site is mapped mangrove | protect, or "check" if the planter says it was cleared |
| `permanently_wet` | median 0.9 or more | blocker (a "check" if confidence is low) |
| `too_low` | above the fringe's 90th percentile + 0.05 | blocker (a "check" if confidence is low) |
| `borderline_low` | above the fringe's 75th percentile | check; recommends the seaward zone |
| `in_range` | 0.02 or more | good |
| `rarely_wet` | under 0.02 | a "check" if the planter says the tide comes daily; otherwise info, landward zone |

Confidence is:

- **high** with a local fringe of 200+ pixels, a median of 40+ observations
  and 80%+ of the site observed
- **medium** with a median of 20+ observations (the default reference is
  capped at medium)
- **low** otherwise

When there are fewer than 50 fringe pixels in the search area, a default
reference from the Kenyan calibration below is used.

### Calibration (2 years of imagery, 2024 to 2025)

Wet fraction of the fringe next to mapped mangroves, measured by the backend
engine with a 2 to 2.5 km search area:

| Site | Type | p25 | p50 | p75 | p90 |
|---|---|---|---|---|---|
| Gazi Bay, Kenya | lagoon bay | 0.25 | 0.40 | 0.52 | 0.66 |
| Mida Creek, Kenya | tidal creek | 0.16 | 0.27 | 0.40 | 0.60 |
| Kipini, Tana delta, Kenya | river mouth | 0.22 | 0.44 | 0.59 | 0.64 |
| **Default reference** (mean) | | 0.21 | 0.37 | 0.50 | 0.63 |

A separate Python prototype gave the same per-pixel wet fractions at Gazi
Bay. Its fringe numbers were slightly lower (p50 0.30 to 0.38) because it
used every image, not only those clear over the site.

At all three sites:

- mangrove canopy and dry land read about 0
- open water and flats had a median of 0.84 to 0.93

Live checks at Gazi Bay with a 30 m site:

| Point (lat, lon) | Land cover | Result |
|---|---|---|
| -4.4347, 39.5140 | open water | `permanently_wet` (0.98) |
| -4.4300, 39.5300 | intertidal flat | `borderline_low` (0.35) |
| -4.4249, 39.5114 | mangrove forest | `existing_mangrove` |
| -4.4150, 39.4950 | dry land, 1.4 km inland | `rarely_wet` |

Three different coastlines put the mangrove edge in a similar band, which is
why a rule relative to each site's own neighbours should travel well. The
local reference still varies (at Gazi Bay its p50 ranged from 0.27 to 0.44
depending on where the 1.5 km window sits), so the thresholds are a starting
point for expert tuning, not final values.

### Choosing the satellite tile

Sentinel-2 tiles overlap, and their names do not always match the grid
square a point falls in. Near latitude-band and zone edges the "obvious"
tile may not exist. The engine therefore tries a few candidate tiles around
the site and keeps the ones that exist. It then picks the one whose image
covers the whole search area. For example, the Rufiji delta in Tanzania
falls in square 37LEM, but its images live under 37MEM. If no tile covers
the site, the run fails and is retried, instead of reporting "no data".

### Data sources

All are open data, with no keys and no accounts:

- Sentinel-2 L2A Cloud-Optimised GeoTIFFs from the AWS open data bucket
  `sentinel-cogs` (Element 84).
- ESA WorldCover 2021 v200 from `esa-worldcover` on S3.

The backend reads small windows straight from the files (HTTP range
requests via geotiff.js), so no STAC API or Earth Engine licence is needed.

### Where it runs

The check runs inside the Node API, off the request path:

1. A Site is created or its boundary changes.
2. The check is queued in-process, one site at a time. Each wallet can have
   only a few checks waiting, and the in-memory queue has a cap. Anything
   over the limits waits in the database for the sweeper.
3. A sweeper every 5 minutes retries failures, up to
   `SITE_HYDROLOGY_MAX_ATTEMPTS`, and recovers stuck jobs.

Image tiles are decoded in a worker thread, so the API stays responsive.
Measured at Gazi Bay, the longest event-loop stall fell from 330 ms to under
100 ms. With the defaults (4 parallel reads, 1 decoder worker), a run takes
about a minute, and peak memory for the whole process is about 200 MB. If no imagery can be fetched at all, the run is
stored as failed and retried, instead of being saved as "no data".

It needs no Redis, no Python service and no new Render service. The Python
ML service was considered, but its VPS has been unreachable and the Render
API is not configured to call it.

### Known limits

- 10 m pixels cannot see a single blocked culvert or a small dip. The field
  questions and photos cover that.
- Water under an existing canopy is invisible. This matters little, since
  you should not plant into healthy forest anyway.
- Very cloudy coasts can end up as `insufficient_data`. Adding Sentinel-1
  radar would fix most of this (future work).
- Images are not yet tagged with the tide height at capture time. Adding a
  global tide model (FES or TPXO) would turn the wet fraction into a rough
  elevation (future work).
- WorldCover is from 2021, so forest cleared since then still shows as
  mangrove. When the planter reports the mangroves were cut or are degraded,
  the verdict notes the conflict and leaves it to the verifiers' photo check.
  It does not block the site.

## Linking plantings and enforcement

A planting can carry a `siteId`, on the land video or on the plant video if
none was set yet. The submission keeps a snapshot:

- the site's status and verdict
- whether the videos were filmed inside the site. The farther of the before
  and planting videos counts, and a `SITE_GPS_TOLERANCE_M` margin is allowed.
- the distance from the site

After a land upload, the app warns the planter straight away if the before
video was filmed outside the linked site. At that point it can still be
filmed again.

A site passes the planting gate when all of these hold:

- it is approved
- the planting is inside it
- its verdict is `plant`, or `fix_first` only because of satellite doubts

The second case exists because satellite doubts are things verifier approval
settles: for example, the 2021 map still showing forest, or a borderline wet
fraction that the high-tide photo answers.

For mangrove plantings, `SITE_CHECK_ENFORCEMENT` decides what happens:

| Mode | Effect |
|---|---|
| `off` (default) | Record only. Nothing changes for planters. |
| `warn` | No auto-approval unless the planting passes the gate. Held plantings go to verifiers, with `aiVerification.decision` set to `pending_verifier` and the reason in `siteGateFlag`. |
| `enforce` | The upload is refused with HTTP 400, before the video is stored, unless the planting passes the gate. A before video filmed outside a linked site is refused at land upload. The message says why. |

Suggested rollout:

1. **Deploy the backend before the web app.** The old upload validator
   rejects the new `siteId` and `species` fields.
2. Run `off` for a season to collect data and let the workshop experts tune
   the thresholds.
3. Move to `warn`.
4. Move to `enforce` once enough sites are approved.

## Verifier review

Verifiers see a queue of submitted sites (not their own, not ones they have
voted on). For each site they see:

- the photos
- the answers
- the satellite summary
- the verdict

They vote yes or no, with a checklist of reject reasons. A vote is
recorded atomically, so one verifier can only ever count once. Pending sites
are re-checked whenever the verifier pool changes, the same way pending
submissions are.

The majority rule is the same as for submissions: a strict majority of all
verifiers, with the `MINIMUM_ACTIVE_VERIFIERS` floor. Site votes carry
**no** minority penalties, because the penalty system is keyed to
submissions.

## API

All endpoints need a JWT.

| Method | Path | Who |
|---|---|---|
| POST | `/api/sites` | planter |
| GET | `/api/sites/mine` | planter |
| GET | `/api/sites/moderation` | verifier |
| GET | `/api/sites/:siteId` | owner or verifier |
| PATCH | `/api/sites/:siteId` | owner, draft only |
| POST | `/api/sites/:siteId/photos` | owner, draft only (multipart `photo` + `kind`) |
| POST | `/api/sites/:siteId/submit` | owner |
| POST | `/api/sites/:siteId/hydrology/recheck` | owner or verifier |
| POST | `/api/sites/:siteId/vote` | verifier |
| DELETE | `/api/sites/:siteId` | owner, draft only |

Swagger at `/docs` has the full shapes.

## Configuration (backend)

| Variable | Default | Meaning |
|---|---|---|
| `SITE_HYDROLOGY_ENABLED` | `true` | Run the satellite check |
| `ENABLE_SITE_HYDROLOGY_SWEEPER` | on (set `false` to disable) | Retry sweeper in the API process |
| `SITE_HYDROLOGY_YEARS` | `2` | Years of imagery, 1 to 5 |
| `SITE_HYDROLOGY_REFERENCE_RADIUS_M` | `1500` | Search radius for nearby mangroves |
| `SITE_HYDROLOGY_MAX_CLOUD_PCT` | `80` | Tile cloud filter |
| `SITE_HYDROLOGY_SCENE_CONCURRENCY` | `4` | Parallel image reads (8 is about 40% faster but peaks near 270 MB) |
| `SITE_HYDROLOGY_DECODER_WORKERS` | `1` | Worker threads that decode image tiles off the API event loop (0 = main thread) |
| `SITE_HYDROLOGY_TIMEOUT_MS` | `300000` | Time budget per site |
| `SITE_HYDROLOGY_MAX_ATTEMPTS` | `3` | Retries before giving up |
| `SITE_HYDROLOGY_S2_BUCKET_URL` | AWS `sentinel-cogs` | Sentinel-2 source |
| `SITE_HYDROLOGY_WORLDCOVER_URL` | AWS `esa-worldcover` | Land cover source |
| `SITE_CHECK_ENFORCEMENT` | `off` | `off`, `warn` or `enforce` |
| `SITE_HYDROLOGY_MAX_PER_WALLET` | `2` | Checks one wallet can have in the in-memory queue; the rest wait for the sweeper |
| `SITE_HYDROLOGY_MAX_QUEUE` | `50` | Cap on the in-memory queue |
| `SITE_MAX_DRAFTS_PER_WALLET` | `20` | Unfinished sites one wallet can hold |
| `SITE_MAX_AREA_M2` | `500000` | Largest site (50 ha); no point may be more than 1.5 km from the centre |
| `SITE_GPS_TOLERANCE_M` | `50` | Allowed distance outside the site |

Try the satellite check on any point:

```bash
cd treegens-backend-main
npm run site:hydrology-smoke -- -4.4347 39.5140 30 2   # lat lon radiusM years
```

## Needs sign-off from a mangrove specialist

- The warning thresholds: how much wetter than the fringe counts as too low,
  and the 0.02 "rarely wet" floor.
- The species zones and regions in `mangroveSpecies.ts`, and the Swahili
  names, which need confirming.
- Question wording, especially for planters reading in a second language.

The workshop pack gives the method, not universal numbers, and zonation
varies by place.

## Ideas for later

- Tag each image with the tide height at capture, using a global tide
  model.
- Add Sentinel-1 radar for cloudy coasts.
- Add a seagrass layer (Allen Coral Atlas) and an aquaculture pond layer.
- Use health-check survival per site to learn which answers predict
  success, then tighten the rules.
- Pay a small, capped reward for an honest Site Check, including red and
  blue results.
- Add a monitoring reward for protecting `let_regrow` sites.
