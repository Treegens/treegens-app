import { useEffect, useState } from 'react'
import { config, SITES } from '../config'
import type { ChainSnapshot } from '../lib/chain'
import { api, type ContractDirectory, type OnchainLive, type Overview } from '../lib/api'
import { formatInt, formatWei, timeAgo } from '../lib/format'
import { addressUrl, tokenUrl } from '../lib/explorer'
import { CopyButton } from './ui/Bits'
import { Icon } from './ui/Icon'

const FALLBACK: ContractDirectory['items'] = [
  { key: 'mgro', address: '0x46e564D039d0d7Ec4C88d517fD32a03d15e88568', label: '$MGRO', role: 'Reward token. Minted 1 per verified tree (95% planter, 5% verifiers) and burned by funders to retire trees.', kind: 'token', explorerUrl: '' },
  { key: 'tgn', address: '0xD75dfa972C6136f1c594Fec1945302f885E1ab29', label: '$TGN', role: 'Governance and staking token. Fiat purchases are swapped to TGN and paid out 95/5 to planters and verifiers.', kind: 'token', explorerUrl: '' },
  { key: 'verifierMinter', address: '0xE73941B1Ae8f630b6Ab2FDd73041bc92B13e397E', label: 'VerifierMinter', role: 'The only address allowed to mint $MGRO. Every reward is a proposal that a majority of staked verifiers must approve.', kind: 'contract', explorerUrl: '' },
  { key: 'tgnVault', address: '0x82a54F550131140Cc08Cf2b10Aa3a44fFDDa582C', label: 'TGN vault', role: 'Where verifiers stake TGN. Dishonest verifiers are slashed here.', kind: 'contract', explorerUrl: '' },
  { key: 'delegationRegistry', address: '0x9f122be6c32fdabe344e195d854a497353f3d162', label: 'Delegation registry', role: 'Lets TGN holders delegate verification weight to a verifier.', kind: 'contract', explorerUrl: '' },
  { key: 'treasurySafe', address: '0x64b05503c6F2233d279E6B8B8f2Da6936dEd584C', label: 'Treegens treasury', role: '2-of-4 multisig Safe that receives slashed stake and holds protocol funds.', kind: 'safe', explorerUrl: '' },
]

export function Contracts({ overview, onchain, chain }: { overview: Overview | null; onchain: OnchainLive | null; chain: ChainSnapshot | null }) {
  const [dir, setDir] = useState<ContractDirectory | null>(null)
  useEffect(() => {
    const c = new AbortController()
    api.contracts(c.signal).then(setDir).catch(() => {})
    return () => c.abort()
  }, [])
  const items = dir?.items || FALLBACK
  const live = onchain && onchain.available ? onchain : null
  const mgroSupply = chain?.mgroSupplyWei ?? live?.mgro.totalSupplyWei ?? null
  const vaultStaked = chain?.vaultStakedWei ?? live?.tgn.vaultStakedWei ?? null
  const treasuryTgn = chain?.treasuryTgnWei ?? live?.tgn.treasuryBalanceWei ?? null
  const treasuryEth = live?.treasury.ethWei ?? null
  const block = chain?.blockNumber ?? live?.blockNumber ?? null

  const liveLine = (key: string) => {
    switch (key) {
      case 'mgro':
        return mgroSupply ? `Total supply ${formatWei(mgroSupply)} MGRO` : null
      case 'tgnVault':
        return vaultStaked ? `${formatWei(vaultStaked)} TGN staked by verifiers` : null
      case 'treasurySafe':
        return treasuryTgn || treasuryEth ? `${treasuryTgn ? `${formatWei(treasuryTgn)} TGN` : ''}${treasuryTgn && treasuryEth ? ' · ' : ''}${treasuryEth ? `${formatWei(treasuryEth, { maxFraction: 3 })} ETH` : ''}` : null
      case 'verifierMinter':
        return overview ? `${formatInt(overview.totals.rewards.proposals.executed)} mints executed · ${formatInt(overview.totals.rewards.proposals.pending)} awaiting verifiers` : null
      default:
        return null
    }
  }

  const endpoints = ['overview', 'flows', 'plantings', 'map', 'onchain', 'contracts', 'status']

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map(it => {
          const url = it.explorerUrl || (it.kind === 'token' ? tokenUrl(it.address) : addressUrl(it.address)) || '#'
          const line = liveLine(it.key)
          return (
            <article key={it.key} className="tg-card flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-extrabold">{it.label}</h3>
                <span className="tg-chip">{it.kind === 'token' ? 'ERC-20' : it.kind === 'safe' ? 'Safe' : 'Contract'}</span>
              </div>
              <p className="text-xs leading-snug text-ink-2">{it.role}</p>
              {line ? (
                <p className="text-sm font-bold text-ink">
                  <span className="mr-1 inline-flex align-middle text-ink-3"><Icon name="chain" size={12} /></span>
                  {line}
                </p>
              ) : null}
              <div className="mt-auto flex items-center gap-2 pt-1">
                <code className="tg-mono flex-1 truncate rounded-lg bg-surface-2 px-2 py-1 text-ink-2" title={it.address}>
                  {it.address}
                </code>
                <CopyButton value={it.address} />
                <a className="tg-btn !px-2.5" href={url} target="_blank" rel="noreferrer noopener" aria-label={`Open ${it.label} on Basescan`}>
                  <Icon name="external" size={14} />
                </a>
              </div>
            </article>
          )
        })}
      </div>

      <div className="grid gap-4 content-start">
        <div className="tg-card p-5">
          <p className="tg-kicker">Verify it yourself</p>
          <ol className="mt-3 grid gap-3 text-sm text-ink-2">
            <li className="flex gap-3"><span className="font-extrabold text-accent">1</span><span>Open any entry in the ledger and click <strong className="text-ink">View on Basescan</strong>. The amount, sender and receiver you see here are read from that transaction's logs.</span></li>
            <li className="flex gap-3"><span className="font-extrabold text-accent">2</span><span>Open the <strong className="text-ink">$MGRO</strong> token: every reward is a mint from the zero address by the VerifierMinter, every retirement a burn to it. Supply above is read live from Base{block ? ` (block #${formatInt(block)})` : ''}.</span></li>
            <li className="flex gap-3"><span className="font-extrabold text-accent">3</span><span>Open a <strong className="text-ink">MintProposed</strong> event on the VerifierMinter: its evidence URI names the planting it pays for. That link lives on-chain, not in our database.</span></li>
            <li className="flex gap-3"><span className="font-extrabold text-accent">4</span><span>Pull the same numbers as JSON from the open API below and recompute them.</span></li>
          </ol>
        </div>

        <div className="tg-card p-5">
          <p className="tg-kicker">Open data</p>
          <ul className="mt-3 grid gap-1.5 text-sm">
            {endpoints.map(e => (
              <li key={e}>
                <a className="tg-link tg-mono" href={`${config.apiBaseUrl}/api/transparency/${e}`} target="_blank" rel="noreferrer noopener">
                  /api/transparency/{e}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-3">
            Public, read-only, no key.{overview?.ledger.lastSyncAt ? ` Ledger indexer synced ${timeAgo(overview.ledger.lastSyncAt)} · ${formatInt(overview.ledger.eventCount)} on-chain events.` : ''}
          </p>
        </div>

        <div className="tg-card p-5">
          <p className="tg-kicker">Where the money enters</p>
          <ul className="mt-3 grid gap-2 text-sm text-ink-2">
            <li><a className="tg-link font-semibold" href={SITES.world.url} target="_blank" rel="noreferrer noopener">{SITES.world.label}</a> · buy verified plantings by card or $MGRO; the payout rails above fire automatically.</li>
            <li><a className="tg-link font-semibold" href={SITES.foundation.url} target="_blank" rel="noreferrer noopener">{SITES.foundation.label}</a> · donations and grants; the treasury Safe balance is read live above.</li>
            <li><a className="tg-link font-semibold" href={SITES.burn.url} target="_blank" rel="noreferrer noopener">{SITES.burn.label}</a> · retire trees by burning $MGRO directly.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
