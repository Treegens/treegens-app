// Signed, short-lived Canopy sessions. A session proves that the browser holds
// an X user token for one of the allowed accounts, so the drafting endpoint and
// the X proxy can't be used by anyone who just finds the site URL.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

const SESSION_TTL_SECONDS = 12 * 60 * 60;

function secret() {
  const raw =
    process.env.SESSION_SECRET ||
    process.env.X_CLIENT_SECRET ||
    process.env.ANTHROPIC_API_KEY;
  if (!raw) return null;
  return createHash("sha256").update(`canopy-session:${raw}`).digest();
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function allowedUsernames() {
  return (process.env.ALLOWED_X_USERNAMES || "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
}

// Returns null when the account may use Canopy, or a reason string when not.
export function rejectUser(username) {
  const allowed = allowedUsernames();
  if (allowed.length === 0) {
    return "ALLOWED_X_USERNAMES is not set on the server. Add your X handle to it in Netlify, then try again.";
  }
  if (!allowed.includes(String(username || "").toLowerCase())) {
    return `@${username} is not on this Canopy's allowlist.`;
  }
  return null;
}

export function mintSession(user) {
  const key = secret();
  if (!key) throw new Error("No SESSION_SECRET configured");
  const payload = b64url(
    JSON.stringify({
      uid: user.id,
      username: user.username,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    }),
  );
  const sig = b64url(createHmac("sha256", key).update(payload).digest());
  return `${payload}.${sig}`;
}

export function readSession(req) {
  const token = req.headers.get("x-canopy-session");
  const key = secret();
  if (!token || !key) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", key).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    // The allowlist can shrink after a session was issued.
    if (rejectUser(data.username)) return null;
    return data;
  } catch {
    return null;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
