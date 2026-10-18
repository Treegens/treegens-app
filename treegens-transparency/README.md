# Treegens Open Ledger (`treegens-transparency/`)

The public transparency layer for Treegens: **every dollar in, every tree out,
verifiable on Base in one click.**

It shows, live:

- **Money in** — purchases of verified plantings on world.treegens.app (card
  and direct-$MGRO rails), $MGRO burned by holders, and the treasury Safe that
  receives donations through treegensfoundation.org.
- **Money out** — the $TGN payouts (95% planter / 5% verifiers) read from the
  payout receipts, and the $MGRO rewards minted through the VerifierMinter,
  each linked to the planting it pays for by the proposal's on-chain
  `evidenceURI`.
- **Proof back** — the before/after planting videos, AI seedling counts,
  verifier votes and the growth-update videos that unlock each reward tranche.
- A **world map** of every verified planting, a **per-planting chain of
  custody** (videos → verifiers → funding → mints → growth updates, every
  transaction with a Basescan link), and the **contract directory** with live
  supply/balances read straight from Base.

Static site: Vite + React 19 + TypeScript + Tailwind v4. No wallet, no auth,
no secrets. ~120 KB gzipped.

## Data sources

| What | Where it comes from |
|---|---|
| Totals, flows, plantings, map, contracts | `GET /api/transparency/*` on the Treegens backend (`treegens-backend-main/src/routes/transparency.ts`) |
| On-chain amounts (mints, burns, payouts) | `OnchainEvent` rows written by `transparencyIndexerService` from Base logs/receipts |
| Live $MGRO supply, vault stake, treasury balance | Read directly from Base JSON-RPC in the browser (`src/lib/chain.ts`) **and** by the API (`/onchain`) — the page cross-checks the two |
| Videos | Public GCS URLs already served as NFT metadata by world.treegens.app |

Every amount on the page is a sum over rows that each carry a transaction
hash. Nothing is typed in by hand.

## Run locally

```bash
cd treegens-transparency
npm install
npm run mock-api          # fixtures on http://127.0.0.1:5055 (synthetic clips, random tx hashes)
# in another shell: point public/config.js apiBaseUrl at http://127.0.0.1:5055, then
npm run dev               # http://127.0.0.1:5180
```

`npm run build` type-checks and writes `dist/`.

## Configuration

Runtime config lives in **`public/config.js`** and is read before the bundle
loads, so a deployed site can be re-pointed without a rebuild:

```js
window.TREEGENS_LEDGER_CONFIG = {
  apiBaseUrl: 'https://treegens-backend-1eyq.onrender.com', // live API (what treegens.app uses)
  apiCandidates: ['https://treegens-api.onrender.com'],      // tried next, in order
  rpcUrl: 'https://mainnet.base.org',                        // public Base RPC for the live cross-check
  explorerBaseUrl: 'https://basescan.org',
  refreshMs: 45000,
  demoDataUrl: '',      // '/demo/data.json' after `npm run demo-bundle`
  demoFallback: false,  // true = demo only while no API answers (banner shown)
}
```

The page probes `apiBaseUrl` and then each candidate for
`/api/transparency/contracts` and uses the first that answers, so the same
build works before and after a backend gains the endpoints. Build-time
fallbacks: `VITE_API_BASE_URL`, `VITE_API_CANDIDATES`, `VITE_RPC_URL`,
`VITE_EXPLORER_BASE_URL`, `VITE_DEMO_DATA_URL`, `VITE_DEMO_FALLBACK`.

## Backend requirements

The API side exists in two places:

1. **`Treegens/treegens-backend`** (the live API on Render,
   `treegens-backend-1eyq.onrender.com`) — branch `claude/open-ledger-api`,
   adapted to that repo's models (verifier-corrected tree counts, OTC buyers,
   AutoMinter V7, retirement contracts). Merge it and Render deploys the
   endpoints; the indexer starts by itself (`DISABLE_LEDGER_INDEXER=true`
   turns it off).
2. **`treegens-backend-main`** in this repo (the Base-mainnet stack):

- Routes: `src/routes/transparency.ts` (public, cached, rate-limited, CORS `*`).
- Read model: `src/services/transparencyService.ts`.
- Indexer: `src/services/transparencyIndexerService.ts`, enabled with
  `ENABLE_LEDGER_INDEXER=true` (already set for `treegens-api` in `render.yaml`).
  It scans $MGRO `Transfer` logs (mints/burns) and VerifierMinter
  `MintProposed`/`MintExecuted` logs from `LEDGER_INDEXER_START_BLOCK`, and reads
  the receipts of completed `TgnDistribution` payouts for the $TGN legs.
- Models: `OnchainEvent`, `OnchainIndexerState`, `OnchainTxIngest`.

If the live backend is a different deployment (`Treegens/treegens-backend`),
copy those files across; they depend only on the shared Mongoose models.

## Deploy (Netlify)

`netlify.toml` is included (base `treegens-transparency`, publish `dist`, SPA
redirect). It is deployed as **its own Netlify project** (`treegens-ledger`)
with the custom domain **transparency.treegens.app** (Jimi, 2026-10-18).
treegens.app's DNS is managed outside Netlify, so the hostname needs one
record at the DNS provider:

```
CNAME  transparency.treegens.app  →  treegens-ledger.netlify.app
```

Netlify provisions the certificate once the record resolves. Per the repo's
`CLAUDE.md`, never attach `treegens.app`, `www.treegens.app`,
`world.treegens.app`, `greenlegacy.app` or `ashaaraamagariisaa.com` to it.

## Brand

The page uses the Treegens identity shared by treegens.org and treegens.app:
the circular mark and wordmark (`public/brand/`, ink version on paper, lime
version at night), Inter, warm grey `#f7f8f3` paper, the lime `#d3e165 →
#989c46` gradient on primary actions, tree greens `#6b8c3b / #435f24 / #303e1a`
and brown ink `#634c2c / #4d341e / #1e0f08`. Series colours are separate from
the brand colours on purpose (see Design notes) and were re-validated against
the brand surfaces.

## Design notes

- Series colours were chosen with the dataviz six-checks validator (CVD and
  normal-vision separation, contrast, lightness band) for both the dark
  (`#0c1a12`) and light (`#f7f8f3`) surfaces. Identity never rides on colour
  alone: every ribbon, badge and legend carries an icon and a label.
- Ribbon width in the flow river is the **number of transactions** on that
  flow, so widths are comparable across tokens; amounts are labelled in their
  own unit.
- `prefers-reduced-motion` stops the particles; the diagram stays readable.
- Below 720 px the river becomes a tappable list of the same flows.
