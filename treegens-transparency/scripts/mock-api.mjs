/**
 * Local mock of GET /api/transparency/* with realistic fixtures, for
 * developing and screenshotting the ledger without the production API.
 *
 *   node scripts/mock-api.mjs            # http://127.0.0.1:5055
 *   PORT=5056 node scripts/mock-api.mjs
 *
 * Point public/config.js (or VITE_API_BASE_URL) at it. Nothing here is real:
 * tx hashes are random, videos are synthetic test clips rendered with the
 * backend's bundled ffmpeg when available.
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 5055
const EXPLORER = 'https://basescan.org'
const MEDIA_DIR = process.env.MOCK_MEDIA_DIR || path.join(__dirname, '..', 'scratch', 'mock-media')

// ----------------------------------------------------------------- helpers --
let seed = 1337
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const pick = arr => arr[Math.floor(rand() * arr.length)]
const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('')
const txHash = () => '0x' + hex(64)
const wallet = () => '0x' + hex(40)
const oid = () => hex(24)
const WEI = 10n ** 18n
const wei = (n, frac = 0) => (BigInt(Math.round(n * 1e6)) * WEI / 1000000n + BigInt(frac)).toString()
const daysAgo = d => new Date(Date.now() - d * 86400000)
const iso = d => (d ? new Date(d).toISOString() : null)

const CONTRACTS = {
  mgro: '0x46e564D039d0d7Ec4C88d517fD32a03d15e88568',
  tgn: '0xD75dfa972C6136f1c594Fec1945302f885E1ab29',
  tgnVault: '0x82a54F550131140Cc08Cf2b10Aa3a44fFDDa582C',
  verifierMinter: '0xE73941B1Ae8f630b6Ab2FDd73041bc92B13e397E',
  delegationRegistry: '0x9f122be6c32fdabe344e195d854a497353f3d162',
  treasurySafe: '0x64b05503c6F2233d279E6B8B8f2Da6936dEd584C',
  minters: ['0xE73941B1Ae8f630b6Ab2FDd73041bc92B13e397E', '0x9BB2C6786c69BB075B36E2B92f1a7c15D539508c', '0x670aC2e2f6fB209b4BCcc9bEb8347286D167515B'],
}
const ZERO = '0x0000000000000000000000000000000000000000'

// --------------------------------------------------------------- media ------
function ensureMedia() {
  const clips = ['planting-a', 'planting-b', 'planting-c', 'update-a', 'update-b', 'land-a']
  try {
    mkdirSync(MEDIA_DIR, { recursive: true })
    const require = createRequire(import.meta.url)
    let ffmpeg = null
    try {
      ffmpeg = require(path.join(__dirname, '..', '..', 'treegens-backend-main', 'node_modules', 'ffmpeg-static'))
    } catch {
      ffmpeg = null
    }
    if (!ffmpeg) return {}
    const srcs = ['testsrc2=s=480x854:r=24', 'mandelbrot=s=480x854:r=24', 'testsrc=s=480x854:r=24', 'smptehdbars=s=480x854:r=24', 'rgbtestsrc=s=480x854:r=24', 'yuvtestsrc=s=480x854:r=24']
    const out = {}
    clips.forEach((name, i) => {
      const file = path.join(MEDIA_DIR, `${name}.webm`)
      if (!existsSync(file) || statSync(file).size < 1000) {
        spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', srcs[i % srcs.length], '-t', '3', '-c:v', 'libvpx-vp9', '-b:v', '400k', '-pix_fmt', 'yuv420p', file])
      }
      if (existsSync(file) && statSync(file).size > 1000) out[name] = `/media/${name}.webm`
    })
    return out
  } catch {
    return {}
  }
}
const media = ensureMedia()
const MEDIA_BASE = process.env.MOCK_MEDIA_BASE || `http://127.0.0.1:${PORT}/media`
const vid = key => (media[key] ? `${MEDIA_BASE}/${path.basename(media[key])}` : null)

// ------------------------------------------------------------- fixtures -----
const SITES = [
  { loc: 'Mida Creek, Kilifi County, Kenya', lat: -3.3485, lng: 39.9772, species: 'Mangrove' },
  { loc: 'Gazi Bay, Kwale County, Kenya', lat: -4.4212, lng: 39.5083, species: 'Mangrove' },
  { loc: 'Lamu Island, Lamu County, Kenya', lat: -2.2717, lng: 40.902, species: 'Mangrove' },
  { loc: 'Pangani Estuary, Tanga, Tanzania', lat: -5.4256, lng: 38.9801, species: 'Mangrove' },
  { loc: 'Rufiji Delta, Pwani, Tanzania', lat: -7.8012, lng: 39.3007, species: 'Mangrove' },
  { loc: 'Quelimane, Zambezia, Mozambique', lat: -17.8786, lng: 36.8883, species: 'Mangrove' },
  { loc: 'Mahajanga, Boeny, Madagascar', lat: -15.7167, lng: 46.3167, species: 'Mangrove' },
  { loc: 'Demak Regency, Central Java, Indonesia', lat: -6.8898, lng: 110.6396, species: 'Mangrove' },
  { loc: 'Benoa Bay, Bali, Indonesia', lat: -8.7467, lng: 115.2094, species: 'Mangrove' },
  { loc: 'Maribojoc, Bohol, Philippines', lat: 9.7399, lng: 123.8414, species: 'Mangrove' },
  { loc: 'Sine-Saloum Delta, Fatick, Senegal', lat: 13.9833, lng: -16.5833, species: 'Mangrove' },
  { loc: 'Bishoftu, Oromia, Ethiopia', lat: 8.7523, lng: 38.9784, species: 'Acacia abyssinica' },
  { loc: 'Jimma, Oromia, Ethiopia', lat: 7.6731, lng: 36.8344, species: 'Cordia africana' },
  { loc: 'Watamu, Kilifi County, Kenya', lat: -3.3545, lng: 40.0229, species: 'Mangrove' },
  { loc: 'Vanga, Kwale County, Kenya', lat: -4.6603, lng: 39.2195, species: 'Mangrove' },
  { loc: 'Tudor Creek, Mombasa, Kenya', lat: -4.0362, lng: 39.6485, species: 'Mangrove' },
]
const PLANTERS = Array.from({ length: 7 }, () => ({ address: wallet(), name: pick(['Amina', 'Baraka', 'Chebet', 'Dawit', 'Faraji', 'Hawa', 'Juma']) }))
const VERIFIERS = Array.from({ length: 6 }, () => wallet())
const FUNDERS = Array.from({ length: 5 }, () => wallet())
const RELAYER = wallet()

const events = []
const plantings = SITES.map((site, i) => {
  const trees = pick([100, 100, 200, 200, 300, 500, 1000])
  const approvedAt = daysAgo(3 + i * 11 + rand() * 6)
  const planter = PLANTERS[i % PLANTERS.length]
  const voters = VERIFIERS.slice(0, 3 + (i % 3))
  const isMangrove = /mangrove/i.test(site.species)
  const id = oid()
  const funded = i % 5 !== 3
  const rail = i % 7 === 6 ? 'mgro' : 'card'
  const grossUsd = funded ? Math.round(trees * (rail === 'card' ? 0.3 : 0.25) * 100) / 100 : 0
  const distributedAt = funded ? new Date(Math.min(Date.now() - 3600000 * (1 + rand() * 20), approvedAt.getTime() + (1 + rand() * 6) * 86400000)) : null
  const planterTgn = funded ? grossUsd * 95 * 0.95 : 0 // mock: 1 USD ≈ 95 TGN
  const verifierTgnEach = funded ? (grossUsd * 95 * 0.05) / voters.length : 0
  const planterTx = funded ? txHash() : ''
  const verifierTxs = funded ? voters.map(() => txHash()) : []
  const allocated = trees
  const planterTotal = trees * 0.95
  const verifierPool = trees * 0.05
  const tranchePaid = i % 4 !== 1
  const trancheTx = tranchePaid ? txHash() : null
  const trancheAt = tranchePaid ? new Date(approvedAt.getTime() + (0.5 + rand() * 3) * 86400000) : null
  const updates = []
  const ageDays = (Date.now() - approvedAt.getTime()) / 86400000
  if (ageDays > 120) {
    const alive = Math.round(trees * (0.9 + rand() * 0.09))
    updates.push({ id: oid(), checkpointIndex: 2, status: 'approved', treesAlive: alive, distanceMeters: Math.round(rand() * 4 * 10) / 10, videoUrl: vid(i % 2 ? 'update-a' : 'update-b'), location: site.loc, gps: { lat: site.lat, lng: site.lng }, submittedAt: iso(daysAgo(ageDays - 115)), reviewedAt: iso(daysAgo(ageDays - 118)), votes: { yes: 3, no: 0 } })
  }
  if (ageDays > 60 && ageDays <= 120 && i % 2 === 0) {
    updates.push({ id: oid(), checkpointIndex: 2, status: 'pending_review', treesAlive: Math.round(trees * 0.95), distanceMeters: 2.1, videoUrl: null, location: site.loc, gps: { lat: site.lat, lng: site.lng }, submittedAt: iso(daysAgo(1)), reviewedAt: null, votes: { yes: 1, no: 0 } })
  }

  // on-chain style events for the flows feed
  if (funded && rail === 'card') {
    events.push({ kind: 'payout', at: distributedAt, txHash: planterTx, from: RELAYER, to: planter.address, role: 'planter', wei: wei(planterTgn), submissionId: id, grossUsd })
    voters.forEach((v, k) => events.push({ kind: 'payout', at: new Date(distributedAt.getTime() + 20000 * (k + 1)), txHash: verifierTxs[k], from: RELAYER, to: v, role: 'verifier', wei: wei(verifierTgnEach), submissionId: id, grossUsd }))
  }
  if (funded && rail === 'mgro') {
    events.push({ kind: 'retire', at: distributedAt, txHash: planterTx, from: FUNDERS[i % FUNDERS.length], to: ZERO, role: 'funder', wei: wei(trees), submissionId: id, grossUsd })
  }
  if (tranchePaid) {
    events.push({ kind: 'reward', at: trancheAt, txHash: trancheTx, from: ZERO, to: planter.address, role: 'planter', wei: wei(planterTotal / 6), submissionId: id, trancheIndex: 0, proposalId: 100 + i })
    voters.forEach((v, k) => events.push({ kind: 'reward', at: new Date(trancheAt.getTime() + 90000 * (k + 1)), txHash: txHash(), from: ZERO, to: v, role: 'verifier', wei: wei(verifierPool / voters.length), submissionId: id, proposalId: 200 + i * 10 + k }))
  }
  if (updates[0]?.status === 'approved' && tranchePaid) {
    const t2 = new Date(new Date(updates[0].reviewedAt).getTime() + 3600000)
    events.push({ kind: 'reward', at: t2, txHash: txHash(), from: ZERO, to: planter.address, role: 'planter', wei: wei((planterTotal - planterTotal / 6) / 5 * (updates[0].treesAlive / trees)), submissionId: id, trancheIndex: 1, proposalId: 300 + i })
  }

  const tranches = Array.from({ length: 6 }, (_, idx) => {
    const unlockAt = new Date(approvedAt.getTime() + idx * 15778800 * 1000)
    const paid = idx === 0 ? tranchePaid : idx === 1 && updates[0]?.status === 'approved' && tranchePaid
    return { index: idx, unlockAt: iso(unlockAt), status: paid ? 'paid' : 'pending', amountWei: paid ? wei(idx === 0 ? planterTotal / 6 : (planterTotal - planterTotal / 6) / 5) : '0', txHash: paid ? txHash() : null, explorerUrl: paid ? `${EXPLORER}/tx/${txHash()}` : undefined, proposalId: paid ? 100 + i : null, requiresHealthCheck: idx > 0 }
  })

  return {
    id,
    approvedAt: iso(approvedAt),
    submittedAt: iso(new Date(approvedAt.getTime() - 2 * 86400000)),
    trees,
    declaredTrees: trees + (isMangrove ? pick([0, 1, -2, 3]) : 0),
    species: site.species,
    isMangrove,
    location: site.loc,
    country: site.loc.split(',').pop().trim(),
    gps: { lat: site.lat, lng: site.lng },
    planter: { address: planter.address, label: 'Planter', explorerUrl: `${EXPLORER}/address/${planter.address}`, name: planter.name },
    verifiers: { count: voters.length, addresses: voters },
    ai: isMangrove ? { counted: trees, confidence: 0.91 + rand() * 0.08, decision: i % 3 === 0 ? 'auto_approved' : 'pending_verifier' } : null,
    video: { url: vid(['planting-a', 'planting-b', 'planting-c'][i % 3]), landUrl: vid('land-a'), stitched: true },
    funding: funded
      ? {
          status: 'funded', grossUsd, rail, distributedAt: iso(distributedAt), planterTx: rail === 'card' ? planterTx : null, planterTxUrl: `${EXPLORER}/tx/${planterTx}`,
          verifierPayouts: voters.map((v, k) => ({ wallet: v, tgnWei: wei(verifierTgnEach), txHash: verifierTxs[k], explorerUrl: `${EXPLORER}/tx/${verifierTxs[k]}` })),
          recordedPlanterTgnWei: wei(planterTgn), recordedVerifierTgnWei: wei(verifierTgnEach * voters.length),
          onchainPlanterTgnWei: rail === 'card' ? wei(planterTgn) : '0', onchainVerifierTgnWei: rail === 'card' ? wei(verifierTgnEach * voters.length) : '0',
          onchainVerified: true, mgroBurnedWei: rail === 'mgro' ? wei(trees) : '0',
        }
      : i % 10 === 8
        ? { status: 'reserved', rail: 'card', holdExpiresAt: iso(new Date(Date.now() + 600000)) }
        : { status: 'open' },
    rewards: {
      allocatedWei: wei(allocated), planterTotalWei: wei(planterTotal), verifierPoolWei: wei(verifierPool),
      planterPaidRecordedWei: wei(tranchePaid ? planterTotal / 6 : 0),
      onchainPlanterMintedWei: wei(tranchePaid ? planterTotal / 6 : 0), onchainVerifierMintedWei: wei(tranchePaid ? verifierPool : 0),
      onchainMintCount: tranchePaid ? 1 + voters.length : 0,
      tranchesPaid: tranches.filter(t => t.status === 'paid').length, tranchesTotal: 6,
      nextUnlockAt: tranches.find(t => t.status !== 'paid')?.unlockAt || null, nextTrancheIndex: tranches.find(t => t.status !== 'paid')?.index ?? null,
      pendingProposals: tranchePaid ? 0 : 1, verifierClaimsPaid: tranchePaid ? voters.length : 0,
    },
    updates: { approved: updates.filter(u => u.status === 'approved').length, pending: updates.filter(u => u.status === 'pending_review').length, latest: updates.find(u => u.status === 'approved') ? { checkpointIndex: 2, treesAlive: updates[0].treesAlive, at: updates[0].reviewedAt, videoUrl: updates[0].videoUrl } : null },
    _updates: updates,
    _tranches: tranches,
    _votes: voters.map(v => ({ wallet: v, vote: 'yes', at: iso(new Date(approvedAt.getTime() - 3600000 * rand() * 20)), explorerUrl: `${EXPLORER}/address/${v}` })),
    _approvedAtDate: approvedAt,
  }
})

// unlinked burns by funders (burn.treegens.app)
for (let i = 0; i < 6; i++) {
  events.push({ kind: 'retire', at: daysAgo(2 + i * 9 + rand() * 5), txHash: txHash(), from: FUNDERS[i % FUNDERS.length], to: ZERO, role: 'funder', wei: wei(pick([100, 100, 200, 500])), submissionId: null })
}

// Donations (treegensfoundation.org → Mercury → Stripe USDC → $MGRO), amounts only
const DONATIONS = [
  { cents: 25000, status: 'settled', daysAgo: 21, usdc: 24850, mgro: 49700 },
  { cents: 10000, status: 'settled', daysAgo: 14, usdc: 9940, mgro: 19600 },
  { cents: 5000, status: 'bought', daysAgo: 6, usdc: 4970, mgro: 9800 },
  { cents: 12000, status: 'onramped', daysAgo: 3, usdc: 11928, mgro: 0 },
  { cents: 2500, status: 'swept', daysAgo: 1, usdc: 0, mgro: 0 },
  { cents: 7500, status: 'detected', daysAgo: 0.2, usdc: 0, mgro: 0 },
].map(d => {
  const at = daysAgo(d.daysAgo)
  const onrampTx = d.usdc ? txHash() : null
  const swapTx = d.mgro ? txHash() : null
  const settleTx = d.status === 'settled' ? txHash() : null
  return { _id: oid(), ...d, updatedAt: iso(at), createdAt: iso(daysAgo(d.daysAgo + 1)), onrampTx, swapTx, settleTx }
})
function donationToFlow(f) {
  const usd = f.cents / 100
  const stage = f.status === 'settled' ? '$MGRO delivered to the treasury Safe' : f.status === 'bought' ? '$MGRO bought on Base' : f.status === 'onramped' ? 'converted to USDC on Base' : f.status === 'swept' ? 'on its way from the bank to Stripe' : 'received at the bank'
  const tx = f.settleTx || f.swapTx || f.onrampTx || undefined
  return { id: `donation:${f._id}`, kind: 'donation', at: f.updatedAt, title: `$${usd.toFixed(2)} donation · ${stage}`, detail: 'treegensfoundation.org → Mercury → Stripe (USDC) → $MGRO on Base', amount: { token: 'USD', value: usd }, verified: Boolean(tx), txHash: tx, explorerUrl: tx ? `${EXPLORER}/tx/${tx}` : undefined, meta: { status: f.status, usdcMicro: String(f.usdc * 10000), mgroWei: wei(f.mgro / 100), onrampTx: f.onrampTx, swapTx: f.swapTx, settleTx: f.settleTx, retired: false } }
}
function donationTotals() {
  const byStatus = {}
  for (const d of DONATIONS) { byStatus[d.status] = byStatus[d.status] || { count: 0, usd: 0 }; byStatus[d.status].count += 1; byStatus[d.status].usd += d.cents / 100 }
  return { count: DONATIONS.length, usd: DONATIONS.reduce((a, d) => a + d.cents, 0) / 100, usdcMicro: String(DONATIONS.reduce((a, d) => a + d.usdc * 10000, 0)), mgroBoughtWei: wei(DONATIONS.reduce((a, d) => a + d.mgro, 0) / 100), mgroSettledWei: wei(DONATIONS.filter(d => d.status === 'settled').reduce((a, d) => a + d.mgro, 0) / 100), byStatus, pipeline: 'live' }
}

const byId = new Map(plantings.map(p => [p.id, p]))
const snippet = id => { const p = byId.get(id); return p ? { trees: p.trees, species: p.species, location: p.location, videoUrl: p.video.url } : undefined }

function eventToFlow(e, idx) {
  const base = { at: iso(e.at), txHash: e.txHash, explorerUrl: `${EXPLORER}/tx/${e.txHash}`, verified: true, submissionId: e.submissionId || undefined, planting: e.submissionId ? snippet(e.submissionId) : undefined }
  if (e.kind === 'payout') return { ...base, id: `tgn_payout:${e.txHash}:${idx}`, kind: 'payout', title: e.role === 'planter' ? '$TGN paid to planter (95% share)' : '$TGN paid to verifier (5% pool)', amount: { token: 'TGN', wei: e.wei }, from: { address: e.from, label: 'Payout relayer' }, to: { address: e.to, label: e.role === 'planter' ? 'Planter' : 'Verifier' }, meta: { role: e.role, grossUsd: e.grossUsd } }
  if (e.kind === 'reward') return { ...base, id: `mgro_mint:${e.txHash}:${idx}`, kind: 'reward', title: e.role === 'planter' ? `$MGRO reward minted to planter · tranche ${(e.trancheIndex ?? 0) + 1}` : '$MGRO reward minted to verifier', detail: `Released by VerifierMinter proposal #${e.proposalId}`, amount: { token: 'MGRO', wei: e.wei }, from: { address: ZERO, label: 'Minted by VerifierMinter' }, to: { address: e.to, label: e.role === 'planter' ? 'Planter' : 'Verifier' }, meta: { role: e.role, trancheIndex: e.trancheIndex, proposalId: e.proposalId } }
  return { ...base, id: `mgro_burn:${e.txHash}:${idx}`, kind: 'retire', title: e.submissionId ? `$MGRO retired against ${byId.get(e.submissionId).trees} verified trees` : '$MGRO burned to retire trees', amount: { token: 'MGRO', wei: e.wei }, from: { address: e.from, label: 'Funder' }, to: { address: ZERO, label: 'Burned (0x0)' }, meta: e.grossUsd ? { grossUsd: e.grossUsd } : undefined }
}

function allFlows(submissionId) {
  const items = []
  events.forEach((e, idx) => { if (!submissionId || e.submissionId === submissionId) items.push(eventToFlow(e, idx)) })
  for (const p of plantings) {
    if (submissionId && p.id !== submissionId) continue
    if (p.funding.status === 'funded') items.push({ id: `funding:${p.id}`, kind: 'funding', at: p.funding.distributedAt, title: `${p.trees} verified trees funded for $${p.funding.grossUsd.toFixed(2)}`, detail: `Paid via ${p.funding.rail === 'mgro' ? 'direct $MGRO' : 'card'} on world.treegens.app · 95% to the planter, 5% to ${p.verifiers.count} verifiers`, amount: { token: 'USD', value: p.funding.grossUsd }, to: { address: p.planter.address, label: 'Planter' }, txHash: p.funding.planterTx || undefined, explorerUrl: p.funding.planterTxUrl, verified: false, submissionId: p.id, planting: snippet(p.id), meta: { rail: p.funding.rail, verifierCount: p.verifiers.count } })
    items.push({ id: `verified:${p.id}`, kind: 'verified', at: p.approvedAt, title: `${p.trees} ${p.isMangrove ? 'mangroves' : 'trees'} verified in ${p.location}`, detail: p.ai?.decision === 'auto_approved' ? `AI counted ${p.ai.counted} seedlings at ${Math.round(p.ai.confidence * 100)}% confidence` : `Approved by ${p.verifiers.count} staked verifiers`, from: { address: p.planter.address, label: 'Planter' }, verified: false, submissionId: p.id, planting: snippet(p.id), video: p.video.url ? { url: p.video.url, kind: 'plant' } : undefined, meta: { verifiers: p.verifiers.count, species: p.species, gps: p.gps } })
    for (const u of p._updates) if (u.status === 'approved') items.push({ id: `update:${u.id}`, kind: 'update', at: u.reviewedAt, title: `Growth update · checkpoint ${u.checkpointIndex}: ${u.treesAlive} trees alive`, detail: `Verified by 3 verifiers · filmed ${u.distanceMeters} m from the planting`, verified: false, submissionId: p.id, planting: snippet(p.id), video: u.videoUrl ? { url: u.videoUrl, kind: 'health_check' } : undefined, meta: { checkpointIndex: u.checkpointIndex, treesAlive: u.treesAlive } })
  }
  if (!submissionId) for (const f of DONATIONS) items.push(donationToFlow(f))
  items.sort((a, b) => new Date(b.at) - new Date(a.at) || (a.id < b.id ? 1 : -1))
  return items
}

const sum = arr => arr.reduce((acc, v) => acc + BigInt(v), 0n).toString()
function overview() {
  const funded = plantings.filter(p => p.funding.status === 'funded')
  const mints = events.filter(e => e.kind === 'reward')
  const burns = events.filter(e => e.kind === 'retire')
  const payouts = events.filter(e => e.kind === 'payout')
  const approvedUpdates = plantings.flatMap(p => p._updates).filter(u => u.status === 'approved')
  return {
    generatedAt: new Date().toISOString(),
    chain: { id: 8453, name: 'Base', explorer: EXPLORER },
    contracts: CONTRACTS,
    totals: {
      plantings: { approved: plantings.length, pendingReview: 3, trees: plantings.reduce((a, p) => a + p.trees, 0), mangroveTrees: plantings.filter(p => p.isMangrove).reduce((a, p) => a + p.trees, 0), planters: PLANTERS.length, verifiers: VERIFIERS.length, locations: SITES.length, countries: new Set(SITES.map(s => s.loc.split(',').pop().trim())).size, withGps: plantings.length },
      funding: { count: funded.length, activeHolds: 1, grossUsd: Math.round(funded.reduce((a, p) => a + p.funding.grossUsd, 0) * 100) / 100, byRail: { card: funded.filter(p => p.funding.rail === 'card').length, mgro: funded.filter(p => p.funding.rail === 'mgro').length }, recordedTgnToPlantersWei: sum(funded.map(p => p.funding.recordedPlanterTgnWei)), recordedTgnToVerifiersWei: sum(funded.map(p => p.funding.recordedVerifierTgnWei)), onchainTgnToPlantersWei: sum(payouts.filter(e => e.role === 'planter').map(e => e.wei)), onchainTgnToVerifiersWei: sum(payouts.filter(e => e.role === 'verifier').map(e => e.wei)), onchainPayoutCount: payouts.length, planterShareBps: 9500, verifierShareBps: 500 },
      rewards: { mintCount: mints.length, mgroMintedWei: sum(mints.map(e => e.wei)), toPlantersWei: sum(mints.filter(e => e.role === 'planter').map(e => e.wei)), toVerifiersWei: sum(mints.filter(e => e.role === 'verifier').map(e => e.wei)), unattributedWei: '0', recipients: new Set(mints.map(e => e.to)).size, allocatedWei: sum(plantings.map(p => p.rewards.allocatedWei)), allocations: plantings.length, planterPaidRecordedWei: sum(plantings.map(p => p.rewards.planterPaidRecordedWei)), tranchesPaid: plantings.reduce((a, p) => a + p.rewards.tranchesPaid, 0), tranchesTotal: plantings.length * 6, proposals: { total: mints.length + 4, executed: mints.length, pending: 4 }, mgroPerTree: '1', schedule: { tranches: 6, intervalSeconds: 15778800, durationSeconds: 94672800 } },
      retired: { burnCount: burns.length, mgroBurnedWei: sum(burns.map(e => e.wei)), funders: new Set(burns.map(e => e.from)).size, linkedToPlantings: burns.filter(e => e.submissionId).length },
      donations: donationTotals(),
      updates: { healthChecksApproved: approvedUpdates.length, healthChecksPending: plantings.flatMap(p => p._updates).filter(u => u.status === 'pending_review').length, healthChecksRejected: 0, treesAliveReported: approvedUpdates.reduce((a, u) => a + u.treesAlive, 0), videos: { plantings: plantings.filter(p => p.video.url).length, land: plantings.filter(p => p.video.landUrl).length, healthChecks: approvedUpdates.filter(u => u.videoUrl).length, total: plantings.filter(p => p.video.url).length + plantings.filter(p => p.video.landUrl).length + approvedUpdates.filter(u => u.videoUrl).length } },
    },
    ledger: { indexerEnabled: true, lastProcessedBlock: 41236510, lastSyncAt: new Date(Date.now() - 42000).toISOString(), startBlock: 38440170, eventCount: events.length },
  }
}

function summary(p) {
  const { _updates, _tranches, _votes, _approvedAtDate, ...rest } = p
  return rest
}
function detail(p) {
  return { ...summary(p), votes: p._votes, ai: p.ai ? { ...p.ai, status: 'completed', at: p.approvedAt } : null, videos: { land: p.video.landUrl, plant: p.video.url, plantRaw: p.video.url, stitched: true }, tranches: p._tranches, verifierClaims: p.verifiers.addresses.map(w => ({ wallet: w, status: p.rewards.verifierClaimsPaid ? 'paid' : 'pending', txHash: p.rewards.verifierClaimsPaid ? txHash() : null, proposalId: p.rewards.verifierClaimsPaid ? 200 : null })), healthChecks: p._updates, timeline: allFlows(p.id).slice().reverse(), landFilmedAt: iso(new Date(p._approvedAtDate.getTime() - 3 * 86400000)), plantFilmedAt: iso(new Date(p._approvedAtDate.getTime() - 2 * 86400000)) }
}

const contracts = {
  chain: { id: 8453, name: 'Base', explorer: EXPLORER },
  items: [
    { key: 'mgro', address: CONTRACTS.mgro, label: '$MGRO', role: 'Reward token. Minted 1 per verified tree (95% planter, 5% verifiers) and burned by funders to retire trees.', kind: 'token', explorerUrl: `${EXPLORER}/token/${CONTRACTS.mgro}` },
    { key: 'tgn', address: CONTRACTS.tgn, label: '$TGN', role: 'Governance and staking token. Fiat purchases are swapped to TGN and paid out 95/5 to planters and verifiers.', kind: 'token', explorerUrl: `${EXPLORER}/token/${CONTRACTS.tgn}` },
    { key: 'verifierMinter', address: CONTRACTS.verifierMinter, label: 'VerifierMinter', role: 'The only address allowed to mint $MGRO. Every reward is a proposal that a majority of staked verifiers must approve.', kind: 'contract', explorerUrl: `${EXPLORER}/address/${CONTRACTS.verifierMinter}` },
    { key: 'tgnVault', address: CONTRACTS.tgnVault, label: 'TGN vault', role: 'Where verifiers stake TGN. Dishonest verifiers are slashed here.', kind: 'contract', explorerUrl: `${EXPLORER}/address/${CONTRACTS.tgnVault}` },
    { key: 'delegationRegistry', address: CONTRACTS.delegationRegistry, label: 'Delegation registry', role: 'Lets TGN holders delegate verification weight to a verifier.', kind: 'contract', explorerUrl: `${EXPLORER}/address/${CONTRACTS.delegationRegistry}` },
    { key: 'treasurySafe', address: CONTRACTS.treasurySafe, label: 'Treegens treasury', role: '2-of-4 multisig Safe that receives slashed stake and holds protocol funds.', kind: 'safe', explorerUrl: `${EXPLORER}/address/${CONTRACTS.treasurySafe}` },
  ],
  historicMinters: CONTRACTS.minters.slice(1).map(address => ({ address, explorerUrl: `${EXPLORER}/address/${address}` })),
}

function onchain() {
  const minted = BigInt(overview().totals.rewards.mgroMintedWei) + 120000n * WEI
  return { available: true, fetchedAt: new Date().toISOString(), blockNumber: 41236578 + Math.floor((Date.now() / 2000) % 1000), mgro: { totalSupplyWei: minted.toString() }, tgn: { totalSupplyWei: wei(100000000), treasuryBalanceWei: wei(2450000), vaultStakedWei: wei(318500) }, treasury: { address: CONTRACTS.treasurySafe, ethWei: wei(1.2) } }
}

// ------------------------------------------------------------------ dump ----
// `node scripts/mock-api.mjs --dump public/demo` writes a static bundle the
// site can serve in demo mode (config.js demoDataUrl: '/demo/data.json').
const dumpIdx = process.argv.indexOf('--dump')
if (dumpIdx > -1) {
  const outDir = path.resolve(process.argv[dumpIdx + 1] || 'public/demo')
  mkdirSync(path.join(outDir, 'media'), { recursive: true })
  for (const rel of Object.values(media)) {
    const name = path.basename(rel)
    const src = path.join(MEDIA_DIR, name)
    if (existsSync(src)) writeFileSync(path.join(outDir, 'media', name), readFileSync(src))
  }
  const bundle = {
    generatedAt: new Date().toISOString(),
    overview: overview(),
    flows: allFlows(),
    plantings: plantings.slice().sort((a, b) => new Date(b.approvedAt) - new Date(a.approvedAt)).map(summary),
    details: Object.fromEntries(plantings.map(p => [p.id, detail(p)])),
    map: { points: plantings.map(pl => ({ id: pl.id, lat: pl.gps.lat, lng: pl.gps.lng, trees: pl.trees, species: pl.species, location: pl.location, approvedAt: pl.approvedAt, funded: pl.funding.status === 'funded', videoUrl: pl.video.url })), total: plantings.length },
    onchain: onchain(),
    contracts,
  }
  writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(bundle))
  console.log(`demo bundle written to ${outDir} (${Object.keys(media).length} clips)`)
  process.exit(0)
}

// ---------------------------------------------------------------- server ----
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
const ok = (res, message, data) => json(res, 200, { message, data })

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname
  if (p.startsWith('/media/')) {
    const file = path.join(MEDIA_DIR, path.basename(p))
    if (!existsSync(file)) return json(res, 404, { error: 'no media' })
    const buf = readFileSync(file)
    res.writeHead(200, { 'content-type': file.endsWith('.webm') ? 'video/webm' : 'video/mp4', 'content-length': buf.length, 'access-control-allow-origin': '*' })
    return res.end(buf)
  }
  if (p === '/api/transparency/overview') return ok(res, 'Transparency overview', overview())
  if (p === '/api/transparency/flows') {
    const limit = Math.min(100, Number(url.searchParams.get('limit')) || 40)
    const kinds = (url.searchParams.get('kinds') || 'funding,payout,reward,retire,verified,update,donation').split(',')
    const cursor = url.searchParams.get('cursor')
    let items = allFlows().filter(i => kinds.includes(i.kind))
    if (cursor) { const idx = items.findIndex(i => i.id === cursor); items = idx >= 0 ? items.slice(idx + 1) : items }
    const page = items.slice(0, limit)
    return ok(res, 'Transparency flows', { items: page, nextCursor: items.length > limit ? page[page.length - 1].id : null, kinds })
  }
  if (p === '/api/transparency/plantings') {
    const page = Number(url.searchParams.get('page')) || 1
    const limit = Math.min(60, Number(url.searchParams.get('limit')) || 24)
    const sort = url.searchParams.get('sort') || 'recent'
    let list = plantings.slice()
    if (sort === 'trees') list.sort((a, b) => b.trees - a.trees)
    else if (sort === 'funded') list.sort((a, b) => Number(b.funding.status === 'funded') - Number(a.funding.status === 'funded'))
    else list.sort((a, b) => new Date(b.approvedAt) - new Date(a.approvedAt))
    return ok(res, 'Verified plantings', { items: list.slice((page - 1) * limit, page * limit).map(summary), page, limit, total: plantings.length })
  }
  const m = p.match(/^\/api\/transparency\/plantings\/([a-f0-9]{24})$/)
  if (m) { const pl = byId.get(m[1]); return pl ? ok(res, 'Planting detail', detail(pl)) : json(res, 404, { error: 'Planting not found' }) }
  if (p === '/api/transparency/map') return ok(res, 'Planting map', { points: plantings.map(pl => ({ id: pl.id, lat: pl.gps.lat, lng: pl.gps.lng, trees: pl.trees, species: pl.species, location: pl.location, approvedAt: pl.approvedAt, funded: pl.funding.status === 'funded', videoUrl: pl.video.url })), total: plantings.length })
  if (p === '/api/transparency/onchain') return ok(res, 'Live on-chain reads', onchain())
  if (p === '/api/transparency/contracts') return ok(res, 'Protocol contracts', contracts)
  if (p === '/api/transparency/status') return ok(res, 'Ledger status', { indexer: { enabled: true, lastProcessedBlock: 41236510, head: 41236578, lagBlocks: 68 }, cursors: [], events: {} })
  if (p === '/health/contracts') return json(res, 200, { chain: 'base-mainnet', ...CONTRACTS })
  json(res, 404, { error: 'not found' })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock transparency API on http://127.0.0.1:${PORT}  (media: ${Object.keys(media).length} clips)`)
})
