// OAuth 2.0 (PKCE) token exchange, refresh and revoke for the X app.
// The client secret never leaves the server. After a fresh login we check the
// account against ALLOWED_X_USERNAMES and revoke the token if it isn't allowed,
// so strangers can't mint tokens billed to this developer app.
import { json, mintSession, rejectUser } from "../lib/session.mjs";

// X_API_BASE only exists so this can be pointed at a mock in local tests.
const X_API = process.env.X_API_BASE || "https://api.x.com/";
const TOKEN_URL = `${X_API}2/oauth2/token`;
const REVOKE_URL = `${X_API}2/oauth2/revoke`;

function clientHeaders() {
  const id = process.env.X_CLIENT_ID;
  const secret = process.env.X_CLIENT_SECRET;
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  // Confidential clients (the app has a Client Secret) must use Basic auth.
  if (secret) {
    headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  }
  return headers;
}

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: "POST",
    headers: clientHeaders(),
    body: new URLSearchParams({ client_id: process.env.X_CLIENT_ID, ...fields }),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // X sometimes answers errors with an empty body.
  }
  return { ok: res.ok, status: res.status, data };
}

async function revoke(token, hint = "access_token") {
  try {
    await postForm(REVOKE_URL, { token, token_type_hint: hint });
  } catch {
    // Best effort.
  }
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST only." }, 405);
  if (!process.env.X_CLIENT_ID) {
    return json({ error: "X_CLIENT_ID is not set on the server." }, 503);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }
  const origin = new URL(req.url).origin;

  if (body.grant_type === "revoke") {
    const hint = body.hint === "refresh_token" ? "refresh_token" : "access_token";
    if (body.token) await revoke(String(body.token), hint);
    return json({ ok: true });
  }

  let fields;
  if (body.grant_type === "authorization_code") {
    if (!body.code || !body.code_verifier) {
      return json({ error: "Missing code or code_verifier." }, 400);
    }
    fields = {
      grant_type: "authorization_code",
      code: String(body.code),
      code_verifier: String(body.code_verifier),
      redirect_uri: `${origin}/callback`,
    };
  } else if (body.grant_type === "refresh_token") {
    if (!body.refresh_token) return json({ error: "Missing refresh_token." }, 400);
    fields = { grant_type: "refresh_token", refresh_token: String(body.refresh_token) };
  } else {
    return json({ error: "Unknown grant_type." }, 400);
  }

  const result = await postForm(TOKEN_URL, fields);
  if (!result.ok || !result.data.access_token) {
    const msg = result.data.error_description || result.data.error || `X said ${result.status}`;
    return json({ error: msg }, result.status >= 400 && result.status < 500 ? 400 : 502);
  }

  const tokens = result.data;
  const out = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || null,
    expires_in: tokens.expires_in || 7200,
    scope: tokens.scope || "",
  };

  if (body.grant_type === "authorization_code") {
    const me = await fetch(`${X_API}2/users/me?user.fields=profile_image_url`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const meData = await me.json().catch(() => ({}));
    if (!me.ok || !meData.data) {
      return json({ error: "Signed in, but X wouldn't return your profile." }, 502);
    }
    const reason = rejectUser(meData.data.username);
    if (reason) {
      await revoke(tokens.access_token);
      if (tokens.refresh_token) await revoke(tokens.refresh_token, "refresh_token");
      return json({ error: reason, code: "not_allowed" }, 403);
    }
    out.user = meData.data;
    out.session = mintSession(meData.data);
  }

  return json(out);
};

export const config = { path: "/api/token" };
