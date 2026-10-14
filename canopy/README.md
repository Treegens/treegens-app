# Canopy

Reply to everyone who already DM'd you on X. Claude drafts each reply, you edit
and approve, and Canopy sends only the approved ones, each into the existing
one-to-one conversation. It never messages anyone who hasn't written to you.

Netlify site: `canopy-treegens` → https://canopy-treegens.netlify.app

## How it works

- **Inbox.** Reads `GET /2/dm_events` with your own X user token. The API only
  returns the last 30 days. Group chats are skipped, and so are threads where
  only you wrote (cold threads).
- **Everyone, ever.** To reach people who messaged you more than 30 days ago,
  import your X data archive (Settings → Your account → Download an archive of
  your data). Pick `data/direct-messages.js` from the unzipped archive, plus any
  `direct-messages-partN.js` files. The file is read in the browser and never
  uploaded. Canopy looks up names with `GET /2/users` (100 per call, billed to
  your X app) and hides deleted or suspended accounts. The recent end of each
  imported thread is kept in localStorage so a reload doesn't need a re-import.
- **Drafts.** `Suggest next 12` asks Claude for a reply to each conversation
  in view, using the whole loaded thread plus your notes on how you write and
  an optional goal for the round. `Draft all` does every conversation in view
  (it asks first when there are more than 20) and can be stopped.
- **Approve and send.** Approve one by one or `Approve drafted` in bulk, then
  `Send approved`. You confirm once. Sends go one at a time through
  `POST /2/dm_conversations/with/:id/messages`, wait out X rate limits, and can
  be stopped mid-queue. People who closed their DMs just get a red note. If the
  first three sends are all refused, the queue stops, since that means the app
  or token can't send at all.
- **Billing.** X reads and sends are billed to your X developer app. Drafts are
  billed to the Anthropic key on the server.

The browser can't call api.x.com directly (no CORS), so three small Netlify
functions sit in between:

| Function | Path | Job |
|---|---|---|
| `x.mjs` | `/api/x/*` | Forwards your token to X. Only the five endpoints Canopy needs are allowed. |
| `token.mjs` | `/api/token` | OAuth 2.0 PKCE code exchange, refresh, revoke. Holds the client secret. |
| `draft.mjs` | `/api/draft` | One Claude call per draft. |

Your X token stays in your browser's localStorage and is never stored on the
server. After sign-in the server checks your handle against
`ALLOWED_X_USERNAMES`. Anyone else who tries to connect gets their token
revoked, so strangers can't run up your X or Anthropic bill.

## Setup

### 1. X developer app (console.x.com)

In your app, open **User authentication settings**:

- App permissions: **Read and write and Direct message**
- Type of App: **Web App, Automated App or Bot** (you have a Client Secret, so
  it's a confidential client)
- Callback URI: `https://canopy-treegens.netlify.app/callback`
- Website URL: `https://treegens.org`

Make sure the app has API credits. With no balance, inbox and send calls fail
even with a valid token.

### 2. Netlify environment variables

Site configuration → Environment variables on `canopy-treegens`:

| Key | Value |
|---|---|
| `X_CLIENT_ID` | OAuth 2.0 Client ID from the X app |
| `X_CLIENT_SECRET` | OAuth 2.0 Client Secret from the X app |
| `ALLOWED_X_USERNAMES` | Your X handle, e.g. `treegens` (comma separate several) |
| `ANTHROPIC_API_KEY` | Key for drafting |
| `SESSION_SECRET` | Already set to a random value |

Functions pick up env changes on the next deploy, so deploy after setting them.

### 3. Deploy

```
cd canopy
npm install
netlify deploy --prod --site 68e13998-00de-4ae8-ac05-8b1eb38b8bc3 --dir public --functions netlify/functions
```

### 4. Use it

Open the site, click **Connect X**, approve, and the inbox loads. Fill in "How
replies should sound" once. Then Suggest, edit, Approve, Send.

To message everyone who has ever DM'd you: import the archive, switch to
"Everyone who DM'd you", set a goal for the round (for example "tell everyone
the new app is live"), then `Draft all`, read them over, `Approve drafted`,
`Send approved`.

If you'd rather not use the Connect button, open "Paste a user access token
instead" and paste a token minted by hand. It needs `dm.read`, `dm.write`,
`tweet.read` and `users.read`.

## Local testing

`X_API_BASE` and `ANTHROPIC_BASE_URL` point the functions at mocks, so the
whole flow can run under `netlify dev` without touching real accounts.
