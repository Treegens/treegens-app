# Treeapp01 — Treegens monorepo

This repository contains the **Treegens** web application and **Node.js backend** used for proof-of-tree video submissions, IPFS uploads, verifier workflows, and optional AI-assisted mangrove checks.

## Layout

| Path | Description |
|------|--------------|
| [`treegens-web-main/`](treegens-web-main/) | Next.js frontend (App Router, Thirdweb auth, Tailwind). |
| [`treegens-backend-main/`](treegens-backend-main/) | Express API, MongoDB, Pinata/IPFS uploads, rewards and submission logic. |

Each package has its own `package.json`, lockfile, and `.gitignore`. **Do not commit** `.env` files — they are excluded from Git.

## Prerequisites

- **Node.js** ≥ 22 (backend `engines` requirement; use a compatible version for the web app too)
- **Yarn** 1.x (both projects declare Yarn)
- **MongoDB** (local or Atlas) for the backend
- **Pinata** (or configured gateway) credentials for IPFS uploads, as documented in the backend env

## Backend

```bash
cd treegens-backend-main
yarn install
cp .env.example .env   # then fill secrets (never commit .env)
yarn dev               # tsx watch
```

Additional scripts: `yarn build`, `yarn start`, `yarn test`, `yarn lint`.

**Mangrove AI verification** (optional): configurable via `AI_PROVIDER` — either Ultralytics-style multipart `/predict` (Bearer + file) or `roboflow_workflow` (JSON to Roboflow Serverless). See `treegens-backend-main/.env.example` and embedded comments.

Smoke test against Roboflow (with env set):

```bash
cd treegens-backend-main && yarn roboflow:smoke /path/to/video.mp4
```

More detail: [treegens-backend-main/README.md](treegens-backend-main/README.md).

## Web

```bash
cd treegens-web-main
yarn install
# Configure env (names depend on app; typical: .env.local or .env — see README in this folder)
yarn dev
```

Point the frontend API base URL at your running backend instance.

More detail: [treegens-web-main/README.md](treegens-web-main/README.md).

## Site Check

Before planting mangroves, planters check the site: a GPS boundary, a short
field questionnaire on tides and history, photos, and a satellite check of how
often the tide covers the spot. They get a verdict: plant here, fix first,
protect and let it regrow, or not a mangrove site. See
[docs/site-check.md](docs/site-check.md).

## CI and tests

Backend tests:

```bash
cd treegens-backend-main && yarn test
```

GitHub Actions for the backend live under [`treegens-backend-main/.github/workflows/`](treegens-backend-main/.github/workflows/).

## Remote

Default remote after setup: **`origin`** → [github.com/Laszlo23/treeapp01](https://github.com/Laszlo23/treeapp01) (adjust if your fork or org differs).
