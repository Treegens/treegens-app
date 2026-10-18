# Patches for sibling repositories

## `treegens-backend-open-ledger.patch` → `Treegens/treegens-backend`

Two commits for the **live** backend (the one behind
`treegens-backend-1eyq.onrender.com`), authored on top of
`35c5136 test(server-mint): …` (main as of 2026-10-18):

1. `feat(ledger)`: the public open-ledger API (`GET /api/transparency/*`), its
   on-chain indexer and the `DonationFlow` data model.
2. `feat(treasury)`: the donation pipeline (Mercury → Stripe financial account
   → USDC on Base → canonical $MGRO → locked), its admin console at
   `/api/admin/treasury/*`, env docs and `docs/TREASURY_PIPELINE.md`.

Both passed `tsc`, lint and the repo's full suite (2623 tests, 0 failures) in
the authoring sandbox.

Apply:

```bash
cd treegens-backend
git checkout -b claude/open-ledger-api origin/main
git am ../treegens-app/ops/patches/treegens-backend-open-ledger.patch
npm test && git push -u origin claude/open-ledger-api
```

Once merged, Render deploys the endpoints and the ledger indexer starts on
its own (`DISABLE_LEDGER_INDEXER=true` turns it off). The ledger site at
https://treegens-ledger.netlify.app already probes that origin first and
switches from demo fixtures to live data automatically.

The donation pipeline starts idle: it does nothing until the Mercury, Stripe
and treasury-wallet variables exist, stays a dry run until
`TREASURY_PIPELINE_MODE=live`, and `DISABLE_TREASURY_PIPELINE=true` switches
it off entirely. The runbook is `docs/TREASURY_PIPELINE.md` in that repo (the
same file lives at `treegens-backend-main/docs/TREASURY_PIPELINE.md` here).
