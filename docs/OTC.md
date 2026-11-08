# OTC desk: pay planters by M-Pesa, keep the MGRO

This document describes the OTC (over the counter) M-Pesa feature as it is built on
branch `feat/otc-mpesa`. Backend code lives in `treegens-backend-main/src/services/otcService.ts`,
`src/services/otcDealRules.ts`, `src/routes/otc.ts` and the OTC section of
`src/config/environment.ts`. The web pages live under `treegens-web-main/src/app/otc/`.

## 1. Purpose

Jimi asked for this:

> I want to be able to pay people with Mpesa the moment they upload videos and AI has
> counted the trees and I keep the $MGRO. The users get onboarded through a link where
> they put their Mpesa number, once filmed I get a notification and I send them. Once I
> upload a screenshot and they approve that they received the Mpesa the MGRO is released.

In the app this is called a **deal**. A deal ties one planting (submission) of an enrolled
planter to a KES amount. The buyer (Jimi) pays that amount by M-Pesa outside the app,
uploads the M-Pesa confirmation, and when the planter confirms receipt the planter's
MGRO share for that planting is released to the buyer's wallet. Until then the MGRO is
**held**: it is never minted to the planter and the planter cannot claim it.

Only **mangrove** submissions take part (D7). Only mangrove clips get an AI count,
verifier votes and approval, so only they can produce a deal. Planters who did not join
through an invite link, and non-mangrove plantings, behave exactly as before.

## 2. The flow

### 2.1 Jimi (the buyer)

1. **Get access.** Jimi's wallet address must be listed in `OTC_BUYER_WALLETS` on Render.
   After that `GET /api/users/me` returns `isOtcBuyer: true`, the profile page shows an
   **OTC desk** button, and Home shows a compact card "OTC desk: KES X to pay across N
   plantings".
2. **Create an invite link** on the desk (`/otc`), section **Invite links**: label (for
   example "Kilifi group, Nov"), KES per tree (prefilled from `OTC_DEFAULT_RATE_KES`),
   optional maximum number of uses. The desk copies the link to the clipboard; it looks like
   `https://treegens-app-web.netlify.app/otc/join/<code>`. Links can be switched off and on
   again from the same list.
3. **Wait for the planter to film.** When an enrolled planter uploads a plant clip and the AI
   has counted the trees, a deal is created and Jimi is alerted in the app, by web push and,
   when configured, on Telegram: "Pay KES 1,200 to Amina Juma", "AI counted 120 trees".
   The alert never contains the phone number; that is on the deal page.
4. **Pay by M-Pesa** using the number shown on the deal page (`/otc/deals/<id>`), which has a
   tap-to-copy button. If the planter changed their number since the deal was created the
   page shows both numbers with an amber "Number changed since this deal was created" note.
5. **Upload the proof** on the deal page: "Upload M-Pesa screenshot" (the page asks to crop out
   the M-Pesa balance), the 10-character **M-Pesa code** from the confirmation (required),
   the amount (prefilled), a "This is a partial payment" checkbox that becomes required when
   the amount differs from the deal amount, and an optional note. Jimi can replace the
   screenshot later; the old file is deleted from storage.
6. **The planter confirms.** Jimi gets "Amina Juma confirmed KES 1,200 / MGRO for 120 trees
   is being released to your wallet". The deal page then shows an MGRO card with a
   **Claim MGRO** button (the same claim path as planters use today), or says the MGRO will
   be released once verifiers approve the planting when there is no allocation yet.
7. **Desk overview.** Four tiles (To pay, Awaiting confirmation, Confirmed, MGRO released), a
   search box (name, phone or M-Pesa code), **Export CSV**, and tabs To pay / Sent / Issues
   (disputed and awaiting count) / Done / Cancelled / All. The **Planters** section lists
   enrollments with inline rate editing, pause/resume and an **Add planting** picker for
   plantings filmed before the planter joined.

### 2.2 The planter

1. **Open the invite link** (`/otc/join/<code>`). The page works signed out and shows "KES X
   per counted tree", three steps (Film your planting; {buyer} pays you by M-Pesa; Confirm
   with the M-Pesa code) and the plain sentence that the MGRO for these plantings goes to
   the buyer. If the link is off, expired or used up the page says so.
2. **Sign in with the M-Pesa phone number** ("Sign in with your M-Pesa phone number", SMS
   code) or tap "Use email instead". The join path survives the sign-in round trip even when
   the magic link opens a new tab (D12): it is stored for one hour and passed as `?next=`.
   If the planter signs in but lands on Home, a banner "Finish joining the M-Pesa program"
   brings them back.
3. **Enter M-Pesa details:** number (prefilled from the verified phone, editable), the name
   shown on M-Pesa, and a consent checkbox. Submit shows "You're in" with **Start planting**
   and **View my payouts**. Joining again with the same buyer's link just updates the
   details; a link from a different buyer is refused (`ALREADY_ENROLLED`).
4. **Film as usual.** After the plant clip is counted the upload celebration says "You will be
   paid KES X by M-Pesa for N trees" (or "Count pending" when there is no count yet) and the
   planter gets a "Planting added to M-Pesa payouts" notice.
5. **Confirm the payment.** When Jimi uploads the proof the planter gets "KES 1,200 sent to
   your M-Pesa". The submission page shows a prominent "Confirm you received KES 1,200" card;
   the deal page shows the screenshot large, "Did you receive KES 1,200?" (with "Deal: KES X,
   Sent: KES Y" when partial), a field "M-Pesa code from your SMS", **Yes, I received it**
   (with a confirm dialog), **Not yet, I'll check my M-Pesa** (goes back; a reminder comes
   after two hours) and **I did not receive it** (reason chips: Nothing arrived, Wrong
   amount, Sent to another number, Something else plus a text box).
6. **My payouts** (`/otc/me`, "M-Pesa payouts" button on the profile): enrollment card (phone,
   name, rate, who pays, status), edit form, **Pause payouts** / **Resume payouts**, and the
   list of deals. A paused enrollment gets no new deals; open deals are unaffected.

### 2.3 Deal states

```
awaiting_count ---> awaiting_payment ---> payment_sent ---> confirmed
      |                   |                  |    ^  |
      |                   |                  |    |  +--> disputed --> confirmed (resolve)
      |                   |                  |    |          |
      +-------------------+------------------+----+----------+--> cancelled
```

| Status | Meaning |
|---|---|
| `awaiting_count` | No payable count yet. `countNote` says why (batch rule, AI failed, waiting for approval). |
| `awaiting_payment` | Count is fundable; Jimi can pay. |
| `payment_sent` | Proof uploaded; waiting for the planter. Re-uploading proof keeps this status. |
| `confirmed` | Planter confirmed (or Jimi resolved a dispute with evidence). MGRO goes to the buyer. |
| `disputed` | Planter said the money did not arrive. Jimi can re-upload, resolve or cancel. |
| `cancelled` | By Jimi, by the system (submission rejected, expiry) or by resolving a dispute in the planter's favour. MGRO returns to the planter. |

A separate `release.status` tracks the MGRO side: `n/a` (no allocation yet), `held`,
`released`, `returned`, `unfundable`.

## 3. Decisions and the knobs behind them

| # | Decision | Knob |
|---|---|---|
| D1 | **Full release by default.** The normal reward schedule vests the planter share over six tranches gated by health-check videos that only the planter can film. A planter already paid in cash has no reason to film them, so the buyer would otherwise receive one sixth. In `full` mode the whole planter share is minted to the buyer in one mint on confirmation. In `vesting` mode the schedule stays and the buyer may file the health checks. | `OTC_RELEASE_MODE` |
| D2 | **Deal count = MGRO count.** When a deal exists, the reward allocation's tree count is taken from `deal.trees`, so the KES paid and the MGRO received are computed from the same number. Non-OTC submissions keep using the declared count. | none |
| D3 | **Payable at AI count, but only for a fundable count.** A deal becomes payable as soon as the AI count completes and passes the 100-tree batch rule. A count the batch rule will never approve (for example 143) stays `awaiting_count` with the batch reason as `countNote`. When the AI decision is `pending_verifier` the deal is payable but marked "not yet verified by verifiers" so Jimi can wait. `approval` makes deals payable only after verifier approval. | `OTC_PAY_ON` |
| D4 | **Rejection handling.** When verifiers reject a planting: unpaid deals (`awaiting_count`, `awaiting_payment`) are cancelled with reason `submission_rejected` and both parties are told; paid deals (`payment_sent`, `confirmed`, `disputed`) keep their status but get `release.status = unfundable` and Jimi gets "Planting rejected after payment". | none |
| D5 | **Confirmation needs the M-Pesa code.** The code is required on upload (10 upper-case letters/digits). The planter must type the same code to confirm; a wrong code is answered with "The code does not match the payment. Check your M-Pesa SMS." | `OTC_CONFIRM_REQUIRES_REF` |
| D6 | **Nothing is stuck forever.** An idempotent reconcile runs after every transition, after allocation creation, on every deal read and in a 5-minute sweep. Unpaid deals auto-cancel after N days and the hold is returned. Planters can pause. No deals are created for a buyer no longer in the allowlist. | `OTC_DEAL_EXPIRY_DAYS`, `ENABLE_OTC_RECONCILER`, `OTC_BUYER_WALLETS` |
| D7 | **Mangrove only.** Only mangrove submissions have AI counts and approvals, so only they create deals. | none |
| D8 | **Disputes.** From `disputed` Jimi may re-upload proof, cancel (requires a written reason; the UI warns it does not refund the M-Pesa) or **Resolve** with a written evidence note that releases the MGRO to him. The evidence is stored on the deal and shown in the timeline. | none |
| D9 | **Names and labels.** `{name}` in every buyer alert is the M-Pesa name the planter typed (the name Jimi must match on the M-Pesa confirmation), never the profile name. Planters see the buyer as the display name; the invite label is for the desk only. | `OTC_BUYER_DISPLAY_NAME` |
| D10 | **Partial payments.** When Jimi sends an amount different from the deal amount he must tick "This is a partial payment". Both sides see "Deal: KES X, Sent: KES Y". The planter confirms the sent amount. Confirmation still releases the whole MGRO: Jimi decides what he pays, the planter decides whether to confirm. | none |
| D11 | **Plantings filmed before the link.** On a new enrollment the planter's existing mangrove plantings with a plant clip, status `pending_review` or `approved`, and no MGRO paid yet get deals too. Jimi gets one "New M-Pesa planter" alert that says how many were added. The desk also has the per-planter **Add planting** picker, which shows ineligible plantings disabled with the reason. | none |
| D12 | **Low-end Android reality.** Post-login redirect is stored in `localStorage` for one hour and passed as `?next=`. Home shows a "Finish joining the M-Pesa program" banner while the redirect exists. The invite page offers SMS sign-in first, email as fallback, and prefills the M-Pesa number with the verified phone. | none (thirdweb dashboard, see section 6) |

Small implementation notes that differ from the first draft of the design: a manual
count can be set from `awaiting_count` and from `awaiting_payment` (before any proof is
uploaded), although the desk only shows the **Set count** button in `awaiting_count`; the
`otc_profile_changed` notice masks the phone number (`+254•••••678`) because no alert may
carry a phone number; and when verifiers approve a different count than the AI counted,
every non-terminal deal is updated to the approved count so the allocation can never mint
more than what was approved.

## 4. Environment variables

All values are read in `treegens-backend-main/src/config/environment.ts`. Defaults apply
when the variable is missing or empty.

| Name | Default | Meaning |
|---|---|---|
| `OTC_BUYER_WALLETS` | empty (desk disabled) | Comma-separated wallet addresses allowed to run the desk. Compared lowercase. Empty means every buyer endpoint answers 403 and no deals are created. |
| `OTC_PUBLIC_APP_URL` | `https://treegens-app-web.netlify.app` | Origin used in invite links and Telegram links. Must never be `treegens.app` (see repo CLAUDE.md). |
| `OTC_TELEGRAM_BOT_TOKEN` | falls back to `TELEGRAM_BOT_TOKEN` | Bot token for buyer alerts. |
| `OTC_TELEGRAM_CHAT_ID` | empty (Telegram off) | Chat id that receives buyer alerts. |
| `OTC_DEFAULT_RATE_KES` | `0` (no default) | Prefill for the KES-per-tree field when creating an invite. |
| `OTC_RELEASE_MODE` | `full` | `full` or `vesting` (D1). |
| `OTC_PAY_ON` | `ai_count` | `ai_count` or `approval` (D3). |
| `OTC_CONFIRM_REQUIRES_REF` | `true` | Any value other than `false` keeps the M-Pesa code check on (D5). |
| `OTC_DEAL_EXPIRY_DAYS` | `14` (minimum 1) | Unpaid deals older than this are cancelled by the sweep (D6). |
| `ENABLE_OTC_RECONCILER` | `true` | `false` disables the 5-minute sweep. API process only; never set in the workers. |
| `OTC_BUYER_DISPLAY_NAME` | `TreeGens` | How planters see the buyer in alerts and on pages (D9). |

`render.yaml` carries everything the desk needs for `treegens-api`: the buyer wallet
(`OTC_BUYER_WALLETS`, a public address, so it ships with the Blueprint), `OTC_PUBLIC_APP_URL`,
and the literal defaults (`OTC_RELEASE_MODE=full`, `OTC_PAY_ON=ai_count`,
`OTC_CONFIRM_REQUIRES_REF="true"`, `OTC_DEAL_EXPIRY_DAYS="14"`, `OTC_BUYER_DISPLAY_NAME=TreeGens`,
`ENABLE_OTC_RECONCILER="true"`). When the branch lands on `main`, the Blueprint sync applies
them and redeploys the API and workers with no dashboard input. The Telegram variables are
deliberately NOT in the Blueprint (a `sync: false` entry would make the sync wait for a value).

### Render dashboard steps

Nothing is required for the desk itself. Optional:

1. To turn on Telegram alerts, open the Render dashboard, service **treegens-api**, tab
   **Environment**, and add `OTC_TELEGRAM_BOT_TOKEN` and `OTC_TELEGRAM_CHAT_ID` (section 5).
   Without them, in-app and web push alerts still work.
2. To add a second buyer, edit `OTC_BUYER_WALLETS` in `render.yaml` (comma-separated) and merge.
3. Optionally set `OTC_DEFAULT_RATE_KES`, or change any default from the table.
4. Check `GET https://treegens-api.onrender.com/health/otc`. It returns `enabled: true`, the
   number of buyer wallets, `telegram: true/false` and the public app URL. No wallet addresses
   are listed.

The same keys go in `treegens-backend-main/.env` for local runs; `.env.example` documents them.

### Deploying the web app (Netlify site treegens-app-web)

The site is not linked to the repository; it is deployed from a laptop. From a machine
that is logged in to Netlify (`netlify login` once):

```bash
cd treegens-web-main
netlify link --id 03de1bac-b485-4c37-9229-6480e5e5ca59   # once per checkout
NEXT_PUBLIC_API_URL=https://treegens-api.onrender.com \
NEXT_PUBLIC_THIRDWEB_CLIENT_ID=4854d732c59a7444a276c61ff0f8be70 \
netlify deploy --prod --build
```

Both values are public and are the ones the live site was built with. Never attach
`treegens.app` or the other production domains to this site (repo CLAUDE.md).

## 5. Telegram bot setup

Buyer alerts (new planter, deal ready to pay, confirmed, disputed, unfundable, system
cancellations) are mirrored to Telegram when both `OTC_TELEGRAM_BOT_TOKEN` and
`OTC_TELEGRAM_CHAT_ID` are set. Messages contain the planter's M-Pesa name, tree counts
and KES amounts, and a link to the deal page. **Phone numbers are never sent** to Telegram
or to web push; they are only shown on the authenticated deal page.

Use a **private chat** (Jimi and the bot), not a group, because names and amounts are
personal data of the planters.

1. In Telegram, open **@BotFather**, send `/newbot`, follow the prompts, and copy the token
   (looks like `123456789:AAH...`). This is `OTC_TELEGRAM_BOT_TOKEN`. If the backend already
   has `TELEGRAM_BOT_TOKEN`, that bot is reused when `OTC_TELEGRAM_BOT_TOKEN` is empty.
2. Open a chat with the new bot and send it any message (for example `hi`). A bot cannot
   message a user who has not written to it first.
3. Get the chat id: open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and
   read `result[0].message.chat.id` (a positive number for a private chat). Alternatively
   send `/start` to **@userinfobot**, which replies with your numeric id; that id is the same
   as your private chat id with any bot.
4. Set `OTC_TELEGRAM_CHAT_ID` to that number on Render and redeploy.
5. Confirm with `GET /health/otc` (`telegram: true`) and by creating a test invite; the first
   planter who joins produces a "New M-Pesa planter" message.

Telegram failures are logged and never fail the action that caused them.

## 6. thirdweb dashboard: phone (SMS) sign-in

The invite page signs planters in with the thirdweb in-app wallet `phone` strategy (SMS
code). This only works when **Phone** is enabled for the web app's client id in the thirdweb
dashboard: **Project > In-App Wallets (or Connect) > Authentication > enable Phone**. Until
then `preAuthenticate` rejects the request; the form shows thirdweb's error message (or
"Could not send the SMS code. Try again or use email." when thirdweb gives none) together
with a "Use email instead" button, so the planter can fall back to email sign-in. `'phone'` is also
listed in `TREEGENS_IN_APP_AUTH_OPTIONS` (`treegens-web-main/src/config/treegensInAppWallet.ts`)
so the regular connect modal offers it too. Kenyan numbers typed as `07XX XXX XXX` are
normalized to `+2547XX...` on both web and backend.

## 7. What happens to the MGRO

Rewards work as before for everyone who is not in a deal: the planter share (95%) vests
over six tranches, verifiers share 5%.

When a deal exists for a planting:

- **Creation / approval.** The reward allocation is created with `treesPlanted = deal.trees`
  (D2) and `otc.hold = true`. No claim job is queued for the planter. The planter's reward
  status shows `otcHold: true`, the Claim button is hidden and `POST /api/rewards/claim`
  answers 409 `OTC_HOLD`. If the allocation already existed when the deal was created (a
  planting approved earlier), the hold is taken atomically, but only when nothing has been
  paid, is processing or has an on-chain proposal; otherwise the deal is refused with
  `PLANTER_ALREADY_PAID`.
- **Confirmation.** `allocation.planterWallet` becomes the buyer, the hold is cleared,
  `releasedToBuyerAt` is set, every tranche's pending `proposalId` is removed (a proposal
  aimed at the planter must never execute for the buyer) and a claim job is queued for the
  buyer. The planter's status now says `otcReleased: true` and their claim answers 409
  `OTC_RELEASED`.
- **`full` mode (default).** The buyer's first claim mints `planterTotal - alreadyPaid` in one
  mint (evidence URI `treegens://submission/<id>/otc/<dealId>/full`), ignoring unlock dates
  and health checks; the remaining tranches are marked paid with amount 0 and the schedule
  is complete. The submission's `planterRewardClaimedWei` (which means "minted to the
  planter") is not touched.
- **`vesting` mode.** The six-tranche schedule stays. The buyer claims each tranche as it
  unlocks and, from checkpoint 2, must upload the health-check videos. In this mode the
  health-check endpoints also authorize the buyer wallet.
- **Cancellation.** The hold is lifted, `returnedToPlanterAt` is set and a claim job is queued
  for the planter. Nothing else changes.
- **Verifier rewards** are untouched. The yes-voter list is always filtered against the
  original planter, so a buyer who also voted yes still counts as a verifier and the other
  verifiers' shares do not move.

## 8. The reconciler and expiry

`reconcileDealAllocation(dealId)` is idempotent and never throws. It takes a hold for a new
allocation, releases to the buyer on `confirmed`, returns to the planter on `cancelled`,
records `release.status` (`held`, `released`, `returned`, `n/a` with an
`allocation_already_paid` event when the planter was already paid) and refreshes the
submission status snapshot. It runs after every transition, after allocation creation and
on every `GET /deals/:id` read.

`startOtcReconciler()` (started from `server.ts` unless `ENABLE_OTC_RECONCILER=false`) runs
once 30 seconds after boot and then every 5 minutes, with an in-flight guard:

- (a) reconcile `confirmed`/`cancelled` deals whose `release.status` is still `held` or `n/a`
  (updated in the last 30 days, up to 200 per pass), and open deals whose `release.status`
  is still `n/a` although a `RewardAllocation` already exists for the submission (up to 500
  per pass), so the hold is taken even when the allocation was created outside the approval
  path;
- (b) cancel `awaiting_count`/`awaiting_payment` deals older than `OTC_DEAL_EXPIRY_DAYS`
  with reason `expired`; both parties are told ("TreeGens did not pay within 14 days");
- (c) apply D4 to open deals whose submission is now `rejected`;
- (d) send one reminder to planters who have not confirmed two hours after the proof was
  uploaded ("Did KES 1,200 arrive? Open the deal to confirm with the M-Pesa code.").

## 9. Troubleshooting

| Symptom | What to check |
|---|---|
| Planter confirmed but the buyer's deal page shows no MGRO card / `release.status` stays `held` | Open `GET /api/otc/deals/:id` (any read runs the reconcile) or wait for the 5-minute sweep. If `release.status` is `n/a` the planting is not approved yet; the release happens when the allocation is created. Check the API logs for `[OTC] reconcile failed`. |
| Planter joined after filming; their earlier plantings have no deals | Backfill (D11) only covers `pending_review`/`approved` plantings with a plant clip and no MGRO paid. Use **Planters > Add planting** on the desk; disabled rows show the reason (`Not eligible`, already has a deal, planter already claimed MGRO). |
| Deal stuck in `awaiting_count` | Read `countNote`. "143 trees is not a whole multiple of 100" is the batch rule (`ENFORCE_TREE_BATCHES`); the planting will never mint as is. "AI could not count this clip" needs a verifier count or **Set count** on the deal page. "Payable once verifiers approve this planting" means `OTC_PAY_ON=approval`. A manual count that is not fundable keeps the deal in `awaiting_count` with the new reason. |
| Deal shows an "unfundable" badge | Verifiers rejected the planting after KES was sent (D4). No MGRO will mint. The deal keeps its status for the record. |
| Planter gets "The code does not match the payment" | The code typed differs from the one Jimi uploaded. Both must be the 10-character M-Pesa code (case does not matter). Jimi can re-upload the proof with the right code. Setting `OTC_CONFIRM_REQUIRES_REF=false` turns the check off. |
| Upload answers 400 `PARTIAL_FLAG_REQUIRED` | The amount differs from the deal amount; tick "This is a partial payment" (D10). |
| Upload answers 400 `INVALID_IMAGE` | The file is not a PNG, JPEG, WebP, GIF or HEIC image (checked by content, not by name). Maximum 10 MB. |
| 409 `INVALID_TRANSITION` | The deal moved while the page was open (for example the planter confirmed while Jimi was cancelling). The response includes the current status; refresh. |
| No deal is created when an enrolled planter uploads | Confirm the planting is mangrove, the enrollment is `active` (not paused), and the enrollment's buyer is still in `OTC_BUYER_WALLETS`. |
| Buyer endpoints answer 403 | The wallet is not in `OTC_BUYER_WALLETS` (compare lowercase) or the variable was not saved on Render. `GET /health/otc` shows the count of configured buyers. |
| No Telegram messages | `GET /health/otc` must show `telegram: true`. The chat id must be the private chat with the bot, and Jimi must have messaged the bot once. Look for `[OTC] Telegram alert failed` in the logs. |
| Planter never gets back to the join page after email sign-in | The stored redirect lasts one hour. Home shows "Finish joining the M-Pesa program" while it exists; after that, open the invite link again. |
| SMS sign-in says it could not send the code | Enable Phone authentication for the client in the thirdweb dashboard (section 6). Email sign-in still works. |
| Invite page says the link is unavailable | The link was switched off, expired or reached its maximum uses. Create a new link on the desk. |

## 10. Security notes

- Buyer endpoints require a wallet in `OTC_BUYER_WALLETS`; planter endpoints require the
  deal or enrollment to belong to the caller. Deal reads answer 403 for anyone else. The
  buyer may also read `GET /api/submissions/:id` for plantings that have a deal with them.
- Every state change is one atomic conditional update; a stale client gets 409 instead of
  overwriting another change.
- M-Pesa screenshots are stored in the `otc` folder with `Cache-Control: private, max-age=0,
  no-store` because they can show the buyer's balance. The desk asks the buyer to crop the
  balance before uploading. Superseded screenshots are deleted.
- Image uploads are checked by magic bytes; the client's declared type and extension are
  ignored. Limit 10 MB.
- Phone numbers never appear in push or Telegram text, only on authenticated pages. The
  planter is notified when their payout number or name changes ("if this wasn't you,
  contact support") and the change is written to every open deal's timeline.
- The planter must type the M-Pesa code from their own SMS to confirm, which protects them
  from a misclick or a fake screenshot. A pending planter-targeted mint proposal is dropped
  on release so it cannot execute for the buyer.
- Jimi's dispute resolution (release to buyer with evidence) is an admin action and is
  recorded on the deal with the evidence text, who did it and when.
- Rate limits: invite preview 600/min per IP (a field meeting puts many phones behind one
  carrier NAT), plus separate limiters for join, planter actions, buyer actions and uploads.
- Deals are never created for a buyer wallet that has been removed from the allowlist.

## 11. API reference

All routes are under `/api/otc`. Responses follow the usual `{ success, message, data }`
envelope; OTC errors are `{ error, code, ...extra }` with the status shown. Lists are
paginated `{ items, total, page, limit }`.

| Method and path | Who | Purpose |
|---|---|---|
| `GET /invites/:code/preview` | public | Invite card data: label, buyer label, rate, `acceptable`, `reason`, `releaseMode`. 404 for unknown codes. |
| `POST /join` | planter | `{ code, mpesaNumber, mpesaName }`. 201 on new enrollment (`backfilled` count), 200 when already enrolled with this buyer, 409 `ALREADY_ENROLLED`, 410 `INVITE_UNAVAILABLE`, 400 `INVALID_PHONE`. |
| `GET /me` | planter | `{ isBuyer, enrollment, buyer, deals, releaseMode, confirmRequiresRef }`. |
| `PATCH /me` | planter | `{ mpesaNumber?, mpesaName?, status? }` (`active` or `paused`). |
| `GET /deals/by-submission/:submissionId` | buyer or planter | Deal detail for a planting. |
| `GET /deals/:dealId` | buyer or planter | Deal detail; runs the reconcile first. |
| `POST /deals/:dealId/confirm` | planter | `{ mpesaRef }`. 400 `MPESA_REF_MISMATCH`, 409 `INVALID_TRANSITION`. Idempotent on `confirmed`. |
| `POST /deals/:dealId/dispute` | planter | `{ reasonCode: nothing_arrived / wrong_amount / wrong_number / other, reason? }`. |
| `GET /summary` | buyer | Counts per status, `kesToPay`, `kesAwaitingConfirmation`, `kesConfirmed`, `kesSent`, `treesConfirmed`, `expectedMgroWeiConfirmed`, `releasedCount`, `unfundableCount`, `enrollmentCount`, `defaults`, `telegram`, `releaseMode`, `payOn`. |
| `POST /invites` / `GET /invites` / `PATCH /invites/:code` | buyer | Create (`{ label, ratePerTreeKes, maxUses?, expiresAt? }` -> `{ invite, url }`), list, update (label, rate, active, max uses). |
| `GET /enrollments` / `PATCH /enrollments/:planterWallet` | buyer | List planters with `planterName` and `dealCounts`; change `ratePerTreeKes` or `status`. |
| `GET /enrollments/:planterWallet/submissions` | buyer | Picker rows: `submissionId, status, treesPlanted, aiCount, uploadedAt, location, hasDeal, eligible, ineligibleReason`. 404 `NOT_ENROLLED`, 409 `ENROLLMENT_PAUSED`. |
| `GET /deals?status=&q=&from=&to=&page=&limit=` | buyer | Filtered deal list. `q` matches name, phone, M-Pesa code, or a 24-hex submission id. |
| `GET /deals/export.csv?status=&q=&from=&to=` | buyer | CSV, max 5000 rows: createdAt, status, mpesaName, mpesaNumber, trees, countSource, verified, amountKes, paidKes, mpesaRef, paymentSentAt, confirmedAt, submissionId, submissionStatus, releaseStatus, expectedMgroWei. |
| `POST /deals` | buyer | `{ submissionId }`. 404 `SUBMISSION_NOT_FOUND`; 409 `NOT_ENROLLED`, `ENROLLMENT_PAUSED`, `NOT_MANGROVE`, `NO_PLANT_CLIP`, `SUBMISSION_REJECTED`, `DEAL_EXISTS`, `PLANTER_ALREADY_PAID`. When the planter's MGRO allocation already exists, the deal is priced from the allocation's tree count (not the AI count) so KES paid and MGRO received match. |
| `POST /deals/:dealId/payment` | buyer | multipart: `screenshot` file, `mpesaRef` (required), `amountKes?`, `partial?`, `note?`. 400 `NO_FILE`, `INVALID_IMAGE`, `INVALID_MPESA_REF`, `PARTIAL_FLAG_REQUIRED`. |
| `PATCH /deals/:dealId/count` | buyer | `{ trees }`; `countSource = manual`. 400 `COUNT_ABOVE_DECLARED` when `trees` exceeds the count the planter declared (`{ declared }`), 409 `ALLOCATION_EXISTS` once the MGRO allocation exists (its count is fixed), 409 `INVALID_TRANSITION` after payment proof. |
| `POST /deals/:dealId/cancel` | buyer | `{ reason? }`; reason required from `payment_sent` or `disputed`. Never from `confirmed`. |
| `POST /deals/:dealId/resolve` | buyer | `{ outcome: release_to_buyer / return_to_planter, evidence }` from `disputed` only. |

Related: `GET /health/otc` (no auth) reports desk readiness; `POST /api/rewards/claim`
answers 409 `OTC_HOLD` or `OTC_RELEASED` with `dealId` for the planter of a deal.
