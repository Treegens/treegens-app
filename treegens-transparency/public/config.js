// Runtime configuration for the Treegens Open Ledger.
// Edit this file on the deployed site (no rebuild needed) to point the page
// at another API or RPC. Everything here is public by design.
window.TREEGENS_LEDGER_CONFIG = {
  // The Treegens API that serves GET /api/transparency/*. The page probes
  // apiBaseUrl first, then each apiCandidates entry, and uses the first one
  // that answers; the choice is remembered for the browser session.
  apiBaseUrl: 'https://treegens-backend-1eyq.onrender.com', // live backend (Treegens/treegens-backend)
  apiCandidates: [
    'https://treegens-api.onrender.com', // Base-mainnet stack in Treegens/treegens-app (render.yaml)
  ],
  // Public Base mainnet JSON-RPC used for the live supply/balance cross-check.
  rpcUrl: 'https://mainnet.base.org',
  // Block explorer every amount links to.
  explorerBaseUrl: 'https://basescan.org',
  // How often the page refreshes (ms).
  refreshMs: 45000,
  // Demo fixtures (npm run demo-bundle). Empty = never. With demoFallback
  // true they show only while no API answers, with a visible banner.
  demoDataUrl: '',
  demoFallback: false,
}
