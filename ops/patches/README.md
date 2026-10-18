# Patches for sibling repositories

## `treegens-backend-open-ledger.patch` → `Treegens/treegens-backend`

The public open-ledger API (`GET /api/transparency/*`), its on-chain indexer and
the `DonationFlow` data model, adapted to the **live** backend (the one behind
`treegens-backend-1eyq.onrender.com`). Authored on top of
`35c5136 test(server-mint): …` (main as of 2026-10-18). It passed `tsc`, lint and
the repo's full test suite (2594 tests; the one unrelated failure,
`childPeakMemory` "a real child reports a positive peak on Linux", is a sandbox
limitation).

Apply:

```bash
cd treegens-backend
git checkout -b claude/open-ledger-api origin/main
git am ../treegens-app/ops/patches/treegens-backend-open-ledger.patch
npm test && git push -u origin claude/open-ledger-api
```

Once merged, Render deploys the endpoints and the indexer starts on its own
(`DISABLE_LEDGER_INDEXER=true` turns it off). The ledger site at
https://treegens-ledger.netlify.app already probes that origin first and
switches from demo fixtures to live data automatically.
