# Donation pipeline: treegensfoundation.org → Mercury → Stripe → USDC → $MGRO → locked

Status: **implemented** (`src/services/treasury/`, console at
`/api/admin/treasury/*`). Jimi's decision, 2026-10-18: *take the USD, on-ramp
it to USDC, buy $MGRO and permanently lock it.*

Nothing moves until the keys for a stage exist **and**
`TREASURY_PIPELINE_MODE=live`. The default mode is `dry_run`: the pipeline
detects real donations and writes down, verbatim, the request each stage
would have sent, so the whole chain can be checked before a cent moves.

## What already worked (world.treegens.app, in production)

| Leg | Mechanism | Reused from |
|---|---|---|
| USD → USDC | Stripe Money Management: a financial account, an outbound payment to a **crypto-wallet payout method** (`cwa_…`), API version `2025-11-17.preview` | `netlify/functions/treasury-cron.js` |
| USDC → $MGRO | OpenOcean aggregator quote + swap (Uniswap V2/V3/V4, Aerodrome) | `fulfill-background.js` → `acquireMgro()` |
| $MGRO → gone | `MangroveRetirement.retire()` sends to `0x…dEaD` | `contracts/src/MangroveRetirement.sol` |

The only new leg is **Mercury → Stripe**, an ACH to a saved recipient.

## The flow

```
donor ──► Mercury (foundation account)
            │  detect   credit ≥ TREASURY_MIN_DONATION_USD, of a donation kind,
            │           not an ACH return from Stripe → DonationFlow (status detected)
            │  sweep    ONE ACH per tick for every detected flow that fits
            │           TREASURY_MAX_SWEEP_USD → the Stripe financial account
            ▼           (Mercury recipient MERCURY_STRIPE_RECIPIENT_ID)
          Stripe financial account (USD)
            │  onramp   per flow, FIFO within the available USD balance:
            │           outbound payment  from {fa, usd}  to {cwa_, usdc}
            │           → USDC lands in the treasury wallet on Base; the
            ▼           transfer is matched on-chain (trace id or size)
          Treasury hot wallet (Base)
            │  swap     USDC → canonical $MGRO 0x46e564D039d0d7Ec4C88d517fD32a03d15e88568
            │           Uniswap V3 (USDC→WETH→MGRO, best fee tiers) when such a
            │           pool exists, else OpenOcean (also routes Uniswap V4)
            ▼
          locked        settle: transfer to 0x…dEaD (default), or retire /
                        burn / forward — see TREASURY_LOCK_METHOD
```

Every stage writes to the donation's `DonationFlow` row. The public ledger
(`/api/transparency/overview` → `totals.donations`, `/flows?kinds=donation`)
shows the amount and the three transaction hashes of every **live** flow.
Never the donor: the counterparty is stored only as a SHA-256 hash, and the
bank memo is not stored at all.

## Stage by stage

**detect** `GET /account/{MERCURY_ACCOUNT_ID}/transactions?status=sent&start=<lookback>`.
A credit counts when `amount > 0`, `kind ∈ TREASURY_DONATION_KINDS`, the
amount is at least the minimum, and the counterparty is not the Stripe
recipient (so a returned sweep never reads as a donation). One flow per
Mercury transaction id (unique index); detection is an insert-only upsert.
`TREASURY_REQUIRE_APPROVAL=true` parks each new flow as `held`; new money
above `TREASURY_MAX_TICK_USD` in one tick is held too.

**sweep** `POST /account/{id}/transactions` (or `/request-send-money` with
`MERCURY_SEND_MODE=request`) `{ recipientId, amount, paymentMethod: 'ach',
idempotencyKey }`. The flows swept together share a `batchId`; the key is a
hash of the members, so a retry of an unacknowledged batch cannot create a
second payment. The payment is polled until Mercury says `sent`; `failed` or
`cancelled` fails the flows (an admin release starts them over with a fresh key).

**onramp** `GET /v2/money_management/financial_accounts/{fa}` for the
available USD, then per flow `POST /v2/money_management/outbound_payments`
`{ from: { financial_account, currency: 'usd' }, to: { payout_method: cwa_,
currency: 'usdc' }, amount: { value: cents, currency: 'usd' } }` with
`Idempotency-Key: tg-donation-<flow>-onramp`. If Stripe asks for a quote
(`outbound_payment_quotes`) one is created and the payment retried with it.
Before the first payout the payout method is read back and must pay exactly
`TREASURY_WALLET_ADDRESS` on Base. When the payment is `posted`, the USDC
`Transfer` to the wallet is found on-chain (Stripe's trace id when it is a
tx hash, otherwise by size within 90–102 % of the amount, oldest unclaimed
first) and recorded with its hash.

**swap** per flow, `min ≤ amount ≤ max`: quote every Uniswap V3 path with
liquidity (direct and via WETH, all fee tiers) and take the best; with no
V3 pool, OpenOcean. `amountOutMinimum` = quote × (1 − slippage). The USDC
approval is for the exact amount. The transaction hash is saved **before**
the receipt is awaited; the $MGRO received is read from the receipt's
Transfer logs, so a crash between the two can never swap twice.

**settle** the lock. `dead` transfers to `0x…dEaD` (needs nothing, always
permanent). `retire` calls `MangroveRetirement.retire(safe, amount,
treegens://donation/<flow>, keccak(donation:<flow>))` after checking that
`retirement.mgro()` is the canonical token and the wallet holds
`RETIRER_ROLE`. `burn` calls ERC20Burnable `burn()` after a `staticCall`
probe. `forward` is a plain transfer to the Safe (not a lock). Same two-phase
send/confirm as the swap.

## Safety model

- `dry_run` by default; `live` is the only value that moves money.
- Caps: per Mercury payment, per Stripe payout, per swap, per tick. Over the
  swap cap a flow is **held** (not split) until the cap is raised and it is
  released.
- Idempotency keys on every payment; `releases` counter makes a restarted
  stage's key new, while a stage whose payment is merely unconfirmed keeps
  its ids and is polled.
- The hot wallet key must sign as `TREASURY_WALLET_ADDRESS`, else no
  on-chain stage runs; the Stripe payout method must pay that same address.
- The retired `0xe846…2283` deployment as MGRO is a fatal config error.
- One process at a time (Mongo lease `treasury-pipeline`); `assertHeld()`
  right before every payment and transaction.
- Nothing about a donor is stored in clear or published.

## Runbook (what Jimi does once)

1. **Mercury.** Settings → API tokens: a token with *read* and *send money*
   permission for the foundation account. Note the account id
   (`GET /api/admin/treasury/mercury` lists them once the token is set).
2. **Stripe.** `GET /api/admin/treasury/stripe` lists the financial accounts
   (`fa_…`), their bank details (`financialAddresses` → routing + account
   number) and the payout methods. In the Stripe Dashboard register the
   treasury wallet as a **Base USDC crypto-wallet payout method**; note its
   `cwa_…` id. If the financial account has no US bank address yet, create
   one in the Dashboard (Balances → the account → Add funds).
3. **Mercury recipient.** Save the financial account's bank details as a
   recipient (ACH, business checking). Note the recipient id
   (`/api/admin/treasury/mercury` → `recipients`).
4. **Treasury wallet.** A fresh key, ~0.005 ETH on Base for gas. Set
   `TREASURY_WALLET_PRIVATE_KEY` **and** `TREASURY_WALLET_ADDRESS`.
5. **Render env** (`.env.example` has the list). Leave
   `TREASURY_PIPELINE_MODE=dry_run`. Let a tick run (or `POST
   /api/admin/treasury/tick`), read `GET /api/admin/treasury/flows` and the
   `dryRun` payload on each stage.
6. Flip `TREASURY_PIPELINE_MODE=live`. Donations detected during the dry run
   stay dry-run records (the ledger ignores them); release the ones that
   should really be processed with `POST /flows/:id/release`, which moves
   them into live mode from the start. For the first weeks consider
   `TREASURY_REQUIRE_APPROVAL=true` and `MERCURY_SEND_MODE=request`.
7. Optional: `TREASURY_LOCK_METHOD=retire` with a MangroveRetirement that
   retires the canonical $MGRO (the 2026-07-23 deployment at `0x645A…` points
   at the old token and is refused) after granting the wallet `RETIRER_ROLE`.

## Console

```
GET  /api/admin/treasury/status            mode, problems, caps, balances, last tick
GET  /api/admin/treasury/flows?status=&mode=&limit=
GET  /api/admin/treasury/flows/:id
POST /api/admin/treasury/flows/:id/release
POST /api/admin/treasury/flows/:id/hold     { "reason": "…" }
POST /api/admin/treasury/tick
GET  /api/admin/treasury/stripe
GET  /api/admin/treasury/mercury
```

All bearer `ADMIN_API_TOKEN`. A flow's `events` array is the audit trail:
what each tick saw, sent, waited on or refused, newest last.

## Env vars

```
DISABLE_TREASURY_PIPELINE, TREASURY_PIPELINE_MODE (dry_run|live), TREASURY_POLL_MS,
TREASURY_REQUIRE_APPROVAL, TREASURY_LOOKBACK_DAYS, TREASURY_MIN_DONATION_USD,
TREASURY_DONATION_KINDS, TREASURY_SWEEP_RESERVE_PCT, TREASURY_MAX_SWEEP_USD,
TREASURY_MAX_ONRAMP_USD, TREASURY_MAX_TICK_USD, TREASURY_MAX_SWAP_USDC,
TREASURY_MIN_SWAP_USDC, TREASURY_SWAP_SLIPPAGE_PCT, TREASURY_SWAP_ROUTE,
TREASURY_LOCK_METHOD, TREASURY_FORWARD_TO, TREASURY_RETIREMENT_ADDRESS,
TREASURY_MAX_ATTEMPTS, TREASURY_ARRIVAL_WAIT_TICKS,
MERCURY_API_BASE, MERCURY_API_TOKEN, MERCURY_ACCOUNT_ID, MERCURY_STRIPE_RECIPIENT_ID,
MERCURY_SEND_MODE, STRIPE_TREASURY_SECRET_KEY (falls back to STRIPE_SECRET_KEY),
STRIPE_FINANCIAL_ACCOUNT_ID, STRIPE_CRYPTO_PAYOUT_METHOD_ID, STRIPE_MONEY_MANAGEMENT_VERSION,
TREASURY_WALLET_PRIVATE_KEY, TREASURY_WALLET_ADDRESS, TREASURY_RPC_URL (defaults to BASE_RPC_URL),
TREASURY_MGRO_ADDRESS (defaults to MGRO_TOKEN_ADDRESS), TREASURY_USDC_ADDRESS, TREASURY_WETH_ADDRESS,
TREASURY_UNISWAP_V3_FACTORY / _QUOTER / _ROUTER, OPENOCEAN_API_BASE
```

## Notes

- **"It's an ETH pool."** Uniswap V3 routes USDC → WETH → MGRO in one
  transaction; the quoter picks the fee tiers. If the pool was created as
  Uniswap **V4** (the default for new pools in the Uniswap app), no V3 pool
  will be found and the swap goes through OpenOcean, which routes V4 on Base.
  `TREASURY_SWAP_ROUTE=openocean` forces that path; `uniswap_v3` forbids it.
- **Mercury API payments** may need in-app approval depending on account
  settings, and the direct endpoint is limited to allow-listed IPs on some
  accounts. `MERCURY_SEND_MODE=request` uses the approval queue instead.
  Mercury also rejects a second payment with the same recipient and amount
  within 24 hours; the batch key makes retries idempotent rather than
  duplicates.
- **Stripe cross-currency** sends (USD balance → USDC payout) may require an
  outbound payment quote; the client handles that automatically.
- A flow whose Stripe payout is `posted` but whose USDC cannot be matched
  on-chain after `TREASURY_ARRIVAL_WAIT_TICKS` is credited with the Stripe
  amount; the swap still spends only what the wallet actually holds.
