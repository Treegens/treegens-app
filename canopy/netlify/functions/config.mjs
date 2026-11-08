// Tells the page what the server is set up for. No secrets here: the X Client
// ID is public by design (it appears in the authorize URL).
import { allowedUsernames, json } from "../lib/session.mjs";

export default async () =>
  json({
    clientId: process.env.X_CLIENT_ID || null,
    oauth: Boolean(process.env.X_CLIENT_ID),
    drafting: Boolean(process.env.ANTHROPIC_API_KEY),
    allowlist: allowedUsernames().length > 0,
  });

export const config = { path: "/api/config" };
