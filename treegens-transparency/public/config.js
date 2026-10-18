// Runtime configuration for the Treegens Open Ledger.
// Edit this file on the deployed site (no rebuild needed) to point the page
// at another API or RPC. Everything here is public by design.
window.TREEGENS_LEDGER_CONFIG = {
  // Treegens backend that serves GET /api/transparency/* (treegens-backend-main).
  apiBaseUrl: 'https://treegens-api.onrender.com',
  // Public Base mainnet JSON-RPC used for the live supply/balance cross-check.
  rpcUrl: 'https://mainnet.base.org',
  // Block explorer every amount links to.
  explorerBaseUrl: 'https://basescan.org',
  // How often the page refreshes (ms).
  refreshMs: 45000,
}
