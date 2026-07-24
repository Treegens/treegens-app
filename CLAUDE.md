# Working rules for this repo

## ⛔ Domains — do not touch (Jimi's standing decision, 2026-07-23)

**Never attach `treegens.app`, `www.treegens.app`, `greenlegacy.app`,
`ashaaraamagariisaa.com`, or `world.treegens.app` to any Netlify site.**

Jimi decided: `treegens.app` is served by the Netlify site
**`treegens-english`** (id `e13d31dd-5abd-44c4-8371-43d441c20468`), which runs
the actively maintained web app (repo `Treegens/treegens-web`, branch
`lang-en`, SW v1.410+). The mainnet stack in this repo takes over the domain
**only when Jimi explicitly says so** — not before.

On 2026-07-23 a session working in this repo created the Netlify site
`treegens-app-web` and moved `treegens.app` onto it. That silently replaced
the live app with the months-old `treegens-web-main/` snapshot in this repo —
no background uploads, no offline-queue durability, old branding. It was
reverted the same evening, and a watchdog now runs on Jimi's Mac every 10
minutes that will automatically revert any such move and notify Jimi.

If you believe the mainnet web app is ready to serve `treegens.app`:
**stop and ask Jimi in chat first.** The cutover also requires updating the
watchdog table in `~/.claude/guards/treegens-domain-guard.mjs`, or your
change will be automatically undone within 10 minutes.

## 🪙 Canonical $MGRO (Jimi's decision, 2026-07-24)

**The mainnet MGRO token is `0x46e564D039d0d7Ec4C88d517fD32a03d15e88568`.**
The deployment at `0xe846…2283` is NOT the token — do not mint against it,
do not point envs at it. If your minter wallet's MINTER_ROLE / gas / key
setup was done against 0xe846…2283, it must be redone on 0x46e5…8568 by
Jimi's admin wallet before any real payout.

## Repo context

- `treegens-backend-main/` and `treegens-web-main/` are snapshots from the
  original handover. The **live, maintained** web app is in
  `Treegens/treegens-web` (3 language branches); the live backend is
  `Treegens/treegens-backend` on Render (`treegens-backend-1eyq`).
- The Render Blueprint here (`render.yaml`) deploys the Base-mainnet API and
  workers (`treegens-api`, `treegens-redis`, reward/slash workers).
