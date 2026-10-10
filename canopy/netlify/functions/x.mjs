// Thin proxy to the X API. Browsers can't call api.x.com directly (no CORS),
// so the page sends its own user token here and we forward it. Only the few
// endpoints Canopy needs are allowed, and every call except /2/users/me needs
// a valid Canopy session. Nothing is stored server-side.
import { json, mintSession, readSession, rejectUser } from "../lib/session.mjs";

// X_API_BASE only exists so the proxy can be pointed at a mock in local tests.
const X_API = process.env.X_API_BASE || "https://api.x.com/";
const ID = "\\d{1,25}";

const ROUTES = [
  { method: "GET", re: /^2\/users\/me$/, open: true },
  { method: "GET", re: /^2\/dm_events$/ },
  { method: "GET", re: new RegExp(`^2/dm_conversations/with/${ID}/dm_events$`) },
  { method: "POST", re: new RegExp(`^2/dm_conversations/with/${ID}/messages$`) },
];

const PASS_HEADERS = [
  "x-rate-limit-limit",
  "x-rate-limit-remaining",
  "x-rate-limit-reset",
  "retry-after",
];

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/x\//, "");
  const route = ROUTES.find((r) => r.method === req.method && r.re.test(path));
  if (!route) return json({ error: "That X endpoint isn't allowed here." }, 404);

  const auth = req.headers.get("authorization") || "";
  if (!/^Bearer \S+$/.test(auth)) {
    return json({ error: "Missing X user access token." }, 401);
  }
  if (!route.open && !readSession(req)) {
    return json({ error: "Session expired. Reload the inbox to sign in again.", code: "session" }, 401);
  }

  const init = {
    method: req.method,
    headers: { authorization: auth, "user-agent": "Canopy/1.0" },
  };
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be JSON." }, 400);
    }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) return json({ error: "Message is empty." }, 400);
    if (text.length > 10000) return json({ error: "X DMs max out at 10,000 characters." }, 400);
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify({ text });
  }

  let upstream;
  try {
    upstream = await fetch(X_API + path + url.search, init);
  } catch (err) {
    return json({ error: `Could not reach X: ${err.message}` }, 502);
  }

  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  const text = await upstream.text();

  if (path === "2/users/me" && upstream.ok) {
    let user;
    try {
      user = JSON.parse(text).data;
    } catch {
      return json({ error: "X returned an unreadable profile." }, 502);
    }
    const reason = rejectUser(user?.username);
    if (reason) return json({ error: reason, code: "not_allowed" }, 403);
    headers["x-canopy-session"] = mintSession(user);
  }

  return new Response(text, { status: upstream.status, headers });
};

export const config = { path: "/api/x/*" };
