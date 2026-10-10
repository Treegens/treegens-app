"use strict";

// Canopy: reply to people who already DM'd you on X. AI drafts, you edit and
// approve, then Canopy sends only the approved replies, into existing 1:1
// conversations where the other person has written to you.

(() => {
  const SCOPES = "dm.read dm.write tweet.read users.read offline.access";
  const SUGGEST_BATCH = 12;
  const DRAFT_CONCURRENCY = 3;
  const SEND_GAP_MS = 1200;
  const MAX_RATE_WAIT_MS = 16 * 60 * 1000;
  const LOAD_ALL_MAX_PAGES = 50;
  const DM_MAX_CHARS = 10000;

  // ---------- small helpers ----------

  const $ = (id) => document.getElementById(id);

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  }

  const store = {
    get(key, fallback = null) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Private mode or storage disabled: Canopy still works for this tab.
      }
    },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function b64url(bytes) {
    let s = "";
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomString(len) {
    const a = new Uint8Array(len);
    crypto.getRandomValues(a);
    return b64url(a);
  }

  function decodeSession(token) {
    try {
      const payload = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(payload));
    } catch {
      return null;
    }
  }

  function ago(iso) {
    if (!iso) return "";
    const t = new Date(iso).getTime();
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function cmpId(a, b) {
    try {
      const x = BigInt(a);
      const y = BigInt(b);
      return x < y ? -1 : x > y ? 1 : 0;
    } catch {
      return String(a).localeCompare(String(b));
    }
  }

  function xError(status, data) {
    const detail =
      data?.error ||
      data?.detail ||
      data?.errors?.[0]?.message ||
      data?.errors?.[0]?.detail ||
      data?.title ||
      `X returned ${status}`;
    let hint = "";
    if (status === 402 || /credit|payment|billing/i.test(detail)) {
      hint = " Add API credits to your app in console.x.com.";
    } else if (status === 403 && !data?.code) {
      hint = " Check the app has Read, write and Direct message permissions and the token has dm.read and dm.write.";
    } else if (status === 401 && !data?.code) {
      hint = " Your X token was rejected. Reconnect X.";
    }
    const err = new Error(detail + hint);
    err.status = status;
    err.code = data?.code;
    return err;
  }

  // ---------- state ----------

  const S = {
    config: null,
    auth: store.get("canopy.auth"), // { access_token, refresh_token, expires_at, source }
    session: store.get("canopy.session"), // { token, exp }
    me: store.get("canopy.me"), // { id, name, username, profile_image_url }
    drafts: store.get("canopy.drafts", {}), // convId -> { text, status, basedOn }
    skipped: store.get("canopy.skipped", {}), // convId -> lastInboundId when skipped
    voice: store.get("canopy.voice", ""),
    goal: store.get("canopy.goal", ""),
    filter: store.get("canopy.filter", "waiting"),
    events: new Map(),
    users: new Map(),
    nextToken: null,
    loaded: false,
    loading: false,
    loadingAll: false,
    stopLoadAll: false,
    hiddenCold: 0,
    threads: [],
    busy: new Set(),
    errors: new Map(),
    sentNow: new Set(),
    expanded: new Set(),
    sending: null,
    cards: new Map(),
  };

  // ---------- samples ----------

  const SAMPLE = [
    {
      id: "sample-1",
      user: { name: "Amara (sample)", username: "amara_sample" },
      messages: [
        { from: "them", text: "Hey! Saw your post about the planting drive. How can I join as a planter?", hoursAgo: 3 },
      ],
      example: "Love that you want to plant with us! The easiest start is signing up as a planter in the app. Want me to send you the link and the first steps?",
    },
    {
      id: "sample-2",
      user: { name: "Leo (sample)", username: "leo_sample" },
      messages: [
        { from: "them", text: "Would love to collaborate on a regen project. Open to a call next week?", hoursAgo: 20 },
      ],
      example: "Yes, happy to talk. What's the project in a sentence or two? I'll check my week and send you a couple of times.",
    },
    {
      id: "sample-3",
      user: { name: "Priya (sample)", username: "priya_sample" },
      messages: [
        { from: "me", text: "Thanks for planting with us this month!", hoursAgo: 50 },
        { from: "them", text: "Thank you for the shoutout!! 🌱", hoursAgo: 30 },
      ],
      example: "You earned it! Thanks for showing up for the trees 🌱",
    },
    {
      id: "sample-4",
      user: { name: "Daniel (sample)", username: "daniel_sample" },
      messages: [
        { from: "them", text: "Quick q: can I sponsor trees for my team as a holiday gift?", hoursAgo: 72 },
      ],
      example: "Great idea. Yes, we can set that up. Roughly how many people are on your team? I'll come back with options.",
    },
  ];

  function sampleThreads() {
    const now = Date.now();
    return SAMPLE.map((s) => {
      const messages = s.messages.map((m, i) => ({
        id: `${s.id}-${i}`,
        from: m.from,
        text: m.text,
        at: new Date(now - m.hoursAgo * 3600 * 1000).toISOString(),
      }));
      const inbound = messages.filter((m) => m.from === "them");
      const last = messages[messages.length - 1];
      return {
        id: s.id,
        otherId: null,
        user: s.user,
        messages,
        lastInboundId: inbound[inbound.length - 1].id,
        lastAt: last.at,
        waiting: last.from === "them",
        sample: true,
        example: s.example,
      };
    });
  }

  // ---------- auth ----------

  function saveAuth(auth) {
    S.auth = auth;
    store.set("canopy.auth", auth);
  }

  function saveSession(token) {
    const data = token ? decodeSession(token) : null;
    S.session = data ? { token, exp: data.exp } : null;
    store.set("canopy.session", S.session);
  }

  function saveMe(me) {
    S.me = me;
    store.set("canopy.me", me);
  }

  const connected = () => Boolean(S.auth?.access_token);
  const sessionValid = () => Boolean(S.session?.token && S.session.exp * 1000 > Date.now() + 60_000);

  async function startOAuth() {
    if (!S.config?.clientId) return;
    const verifier = randomString(48);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = randomString(16);
    try {
      sessionStorage.setItem("canopy.pkce", JSON.stringify({ verifier, state }));
    } catch {
      notify("This browser blocks session storage, so the X sign-in can't finish here. Use the token option below.", "error");
      return;
    }
    const params = new URLSearchParams({
      response_type: "code",
      client_id: S.config.clientId,
      redirect_uri: `${location.origin}/callback`,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    location.assign(`https://x.com/i/oauth2/authorize?${params}`);
  }

  async function finishOAuth() {
    const q = new URLSearchParams(location.search);
    history.replaceState(null, "", "/");
    if (q.get("error")) {
      notify(`X sign-in didn't finish: ${q.get("error_description") || q.get("error")}`, "error");
      return false;
    }
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem("canopy.pkce") || "null");
      sessionStorage.removeItem("canopy.pkce");
    } catch {
      // handled below
    }
    if (!saved || saved.state !== q.get("state") || !q.get("code")) {
      notify("The X sign-in check didn't match. Click Connect X to try again.", "error");
      return false;
    }
    notify("Finishing X sign-in…");
    const res = await fetch("/api/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code: q.get("code"), code_verifier: saved.verifier }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      notify(`X sign-in failed: ${data.error || res.status}`, "error");
      return false;
    }
    saveAuth({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 7200) * 1000,
      source: "oauth",
    });
    saveSession(data.session);
    saveMe(data.user);
    notify(`Connected as @${data.user.username}.`);
    return true;
  }

  let refreshing = null;
  function refreshToken() {
    if (!S.auth?.refresh_token) return Promise.resolve(false);
    refreshing ??= (async () => {
      try {
        const res = await fetch("/api/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", refresh_token: S.auth.refresh_token }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return false;
        saveAuth({
          ...S.auth,
          access_token: data.access_token,
          refresh_token: data.refresh_token || S.auth.refresh_token,
          expires_at: Date.now() + (data.expires_in || 7200) * 1000,
        });
        return true;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function ensureFreshToken() {
    if (S.auth?.expires_at && S.auth.refresh_token && Date.now() > S.auth.expires_at - 60_000) {
      await refreshToken();
    }
  }

  async function xFetch(path, { method = "GET", body, retried = false } = {}) {
    if (!connected()) throw new Error("Connect X first.");
    await ensureFreshToken();
    const isMe = path.startsWith("2/users/me");
    if (!isMe && !sessionValid()) await refreshSession();
    const headers = { authorization: `Bearer ${S.auth.access_token}` };
    if (S.session?.token) headers["x-canopy-session"] = S.session.token;
    if (body) headers["content-type"] = "application/json";
    const res = await fetch(`/api/x/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && !retried) {
      const data = await res.clone().json().catch(() => ({}));
      if (data.code === "session") {
        await refreshSession();
        return xFetch(path, { method, body, retried: true });
      }
      if (await refreshToken()) return xFetch(path, { method, body, retried: true });
    }
    return res;
  }

  async function refreshSession() {
    const res = await xFetch("2/users/me?user.fields=profile_image_url");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw xError(res.status, data);
    saveMe(data.data);
    saveSession(res.headers.get("x-canopy-session"));
    if (!S.session) throw new Error("The server didn't issue a session. Check SESSION_SECRET on Netlify.");
  }

  async function disconnect() {
    const auth = S.auth;
    saveAuth(null);
    saveSession(null);
    saveMe(null);
    S.events.clear();
    S.users.clear();
    S.loaded = false;
    S.nextToken = null;
    if (auth?.source === "oauth") {
      for (const [token, hint] of [[auth.access_token, "access_token"], [auth.refresh_token, "refresh_token"]]) {
        if (!token) continue;
        fetch("/api/token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant_type: "revoke", token, hint }),
        }).catch(() => {});
      }
    }
    notify("Disconnected. Your token was removed from this browser.");
    rebuild();
  }

  // ---------- inbox ----------

  function inboxQuery(token) {
    const q = new URLSearchParams({
      max_results: "100",
      event_types: "MessageCreate",
      "dm_event.fields": "id,text,event_type,created_at,sender_id,dm_conversation_id,attachments",
      expansions: "sender_id",
      "user.fields": "name,username,profile_image_url",
    });
    if (token) q.set("pagination_token", token);
    return q;
  }

  async function fetchPage(token) {
    const res = await xFetch(`2/dm_events?${inboxQuery(token)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw xError(res.status, data);
    for (const e of data.data || []) S.events.set(e.id, e);
    for (const u of data.includes?.users || []) S.users.set(u.id, u);
    return data.meta?.next_token || null;
  }

  async function loadInbox() {
    if (S.loading) return;
    if (!connected()) {
      notify("Connect X first, then load your inbox.", "warn");
      $("setup").scrollIntoView({ behavior: "smooth" });
      return;
    }
    S.loading = true;
    renderToolbar();
    try {
      if (!sessionValid()) await refreshSession();
      const next = await fetchPage(null);
      if (!S.loaded) S.nextToken = next;
      S.loaded = true;
      hideNotice();
      rebuild();
    } catch (err) {
      notify(err.message, "error");
    } finally {
      S.loading = false;
      renderToolbar();
    }
  }

  async function loadOlder() {
    if (S.loading || !S.nextToken) return;
    S.loading = true;
    renderToolbar();
    try {
      S.nextToken = await fetchPage(S.nextToken);
      if (!S.nextToken) notify("That's everything X keeps. DM history only goes back about 30 days.");
      rebuild();
    } catch (err) {
      notify(err.message, "error");
    } finally {
      S.loading = false;
      renderToolbar();
    }
  }

  async function loadAll() {
    if (S.loadingAll) {
      S.stopLoadAll = true;
      return;
    }
    if (S.loading || !S.nextToken) return;
    S.loadingAll = true;
    S.stopLoadAll = false;
    S.loading = true;
    renderToolbar();
    let pages = 0;
    try {
      while (S.nextToken && !S.stopLoadAll && pages < LOAD_ALL_MAX_PAGES) {
        S.nextToken = await fetchPage(S.nextToken);
        pages += 1;
        rebuild();
      }
      if (!S.nextToken) notify("Loaded everything X keeps (about the last 30 days).");
      else if (pages >= LOAD_ALL_MAX_PAGES) notify(`Stopped after ${pages} pages. Click again to keep going.`, "warn");
    } catch (err) {
      notify(err.message, "error");
    } finally {
      S.loading = false;
      S.loadingAll = false;
      renderToolbar();
    }
  }

  function buildThreads() {
    if (!S.loaded || !S.me) return connected() ? [] : sampleThreads();
    const myId = S.me.id;
    const byConv = new Map();
    for (const e of S.events.values()) {
      if (e.event_type !== "MessageCreate") continue;
      const m = /^(\d+)-(\d+)$/.exec(e.dm_conversation_id || "");
      if (!m || m[1] === m[2]) continue; // group conversation or a note to self
      const otherId = m[1] === myId ? m[2] : m[2] === myId ? m[1] : null;
      if (!otherId) continue;
      if (!byConv.has(e.dm_conversation_id)) byConv.set(e.dm_conversation_id, { otherId, events: [] });
      byConv.get(e.dm_conversation_id).events.push(e);
    }

    const threads = [];
    let cold = 0;
    for (const [id, { otherId, events }] of byConv) {
      events.sort((a, b) => cmpId(a.id, b.id));
      const messages = events.map((e) => ({
        id: e.id,
        from: e.sender_id === otherId ? "them" : "me",
        text: e.text || (e.attachments ? "(media)" : ""),
        at: e.created_at,
        media: Boolean(e.attachments),
      }));
      const inbound = messages.filter((m) => m.from === "them");
      // Only people who wrote to you. Threads where only you wrote are cold.
      if (inbound.length === 0) {
        cold += 1;
        continue;
      }
      const last = messages[messages.length - 1];
      const u = S.users.get(otherId) || {};
      threads.push({
        id,
        otherId,
        user: { name: u.name || "Unknown", username: u.username || otherId, avatar: u.profile_image_url },
        messages,
        lastInboundId: inbound[inbound.length - 1].id,
        lastAt: last.at,
        waiting: last.from === "them",
        sample: false,
      });
    }
    threads.sort((a, b) => cmpId(b.lastInboundId, a.lastInboundId));
    S.hiddenCold = cold;
    return threads;
  }

  // ---------- drafts ----------

  function draftOf(t) {
    return S.drafts[t.id] || null;
  }

  function saveDrafts() {
    store.set("canopy.drafts", S.drafts);
  }

  function setDraft(id, value) {
    if (value) S.drafts[id] = value;
    else delete S.drafts[id];
    saveDrafts();
  }

  function isSkipped(t) {
    return S.skipped[t.id] === t.lastInboundId;
  }

  function isStale(t) {
    const d = draftOf(t);
    return Boolean(d?.basedOn && d.basedOn !== t.lastInboundId);
  }

  // empty | drafting | drafted | approved | sending | sent | skipped
  function statusOf(t) {
    if (S.sentNow.has(t.id)) return "sent";
    if (S.sending?.current === t.id) return "sending";
    if (S.busy.has(t.id)) return "drafting";
    if (isSkipped(t)) return "skipped";
    const d = draftOf(t);
    if (!d?.text?.trim()) return "empty";
    if (d.status === "approved" && !isStale(t)) return "approved";
    return "drafted";
  }

  function visibleThreads() {
    if (S.filter === "all") return S.threads;
    return S.threads.filter((t) => (t.waiting && !isSkipped(t)) || S.sentNow.has(t.id));
  }

  function draftingEnabled() {
    return connected() && S.config?.drafting !== false;
  }

  async function draftFor(t, retried = false) {
    S.busy.add(t.id);
    S.errors.delete(t.id);
    updateCard(t);
    renderToolbar();
    try {
      if (!sessionValid()) await refreshSession();
      const res = await fetch("/api/draft", {
        method: "POST",
        headers: { "content-type": "application/json", "x-canopy-session": S.session.token },
        body: JSON.stringify({
          thread: {
            name: t.user.name,
            username: t.user.username,
            messages: t.messages.map(({ from, text, at }) => ({ from, text, at })),
          },
          voice: S.voice,
          goal: S.goal,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data.code === "session" && !retried) {
        S.busy.delete(t.id);
        await refreshSession();
        return await draftFor(t, true);
      }
      if (!res.ok) throw new Error(data.error || `Drafting failed (${res.status}).`);
      setDraft(t.id, { text: data.draft, status: "drafted", basedOn: t.lastInboundId });
    } catch (err) {
      S.errors.set(t.id, err.message);
    } finally {
      S.busy.delete(t.id);
      updateCard(t);
      renderToolbar();
    }
  }

  async function suggestNext() {
    if (!draftingEnabled()) {
      notify(connected() ? "Drafting is off until ANTHROPIC_API_KEY is set on Netlify." : "Connect X first. Drafting is locked to your account.", "warn");
      return;
    }
    const picks = visibleThreads()
      .filter((t) => statusOf(t) === "empty")
      .slice(0, SUGGEST_BATCH);
    if (picks.length === 0) {
      notify("Every conversation in this view already has a draft.");
      return;
    }
    const queue = [...picks];
    const worker = async () => {
      while (queue.length) await draftFor(queue.shift());
    };
    await Promise.all(Array.from({ length: Math.min(DRAFT_CONCURRENCY, picks.length) }, worker));
  }

  function approveAll() {
    let n = 0;
    for (const t of visibleThreads()) {
      if (statusOf(t) !== "drafted") continue;
      const d = draftOf(t);
      setDraft(t.id, { ...d, status: "approved", basedOn: t.lastInboundId });
      n += 1;
    }
    if (n === 0) notify("Nothing to approve. Suggest or write some drafts first.");
    renderList();
  }

  // ---------- sending ----------

  function sendable(t) {
    const d = draftOf(t);
    return (
      !t.sample &&
      t.otherId &&
      t.messages.some((m) => m.from === "them") &&
      statusOf(t) === "approved" &&
      d.text.trim().length > 0 &&
      d.text.length <= DM_MAX_CHARS
    );
  }

  function confirmSend(list) {
    return new Promise((resolve) => {
      const dlg = $("confirm");
      $("confirm-title").textContent = `Send ${list.length} ${list.length === 1 ? "DM" : "DMs"}?`;
      $("confirm-body").textContent =
        "Each reply goes into your existing conversation with that person, as written in its box. This can't be undone.";
      const ul = $("confirm-list");
      ul.replaceChildren(
        ...list.slice(0, 12).map((t) => el("li", { text: `${t.user.name} (@${t.user.username})` })),
        list.length > 12 ? el("li", { text: `and ${list.length - 12} more` }) : null,
      );
      $("confirm-ok").textContent = `Send ${list.length}`;
      dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
      dlg.returnValue = "";
      dlg.showModal();
    });
  }

  async function sendApproved() {
    if (S.sending) return;
    const list = S.threads.filter(sendable);
    if (list.length === 0) {
      const anySample = S.threads.some((t) => t.sample);
      notify(anySample ? "Samples can't be sent. Load your inbox to reply to real people." : "Approve at least one draft first.", "warn");
      return;
    }
    if (!(await confirmSend(list))) return;

    S.sending = { total: list.length, done: 0, failed: 0, stop: false, current: null };
    showSendbar();
    try {
      for (const t of list) {
        if (S.sending.stop) break;
        // Re-check right before sending: the draft may have changed.
        if (!sendable(t)) continue;
        S.sending.current = t.id;
        updateCard(t);
        setSendLabel(`Sending to @${t.user.username}…`);
        const ok = await sendOne(t);
        S.sending.current = null;
        if (ok) S.sending.done += 1;
        else S.sending.failed += 1;
        updateCard(t);
        renderToolbar();
        setSendProgress();
        if (S.sending.stop) break;
        await sleep(SEND_GAP_MS);
      }
    } finally {
      const { done, failed, stop, total } = S.sending;
      S.sending = null;
      hideSendbar();
      rebuild();
      const skipped = total - done - failed;
      const parts = [`Sent ${done} of ${total}.`];
      if (failed) parts.push(`${failed} failed, see the red notes.`);
      if (stop && skipped > 0) parts.push(`Stopped before the last ${skipped}.`);
      notify(parts.join(" "), failed ? "warn" : undefined);
    }
  }

  async function sendOne(t) {
    const text = draftOf(t).text.trim();
    for (;;) {
      let res;
      try {
        res = await xFetch(`2/dm_conversations/with/${t.otherId}/messages`, { method: "POST", body: { text } });
      } catch (err) {
        S.errors.set(t.id, err.message);
        return false;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        S.errors.delete(t.id);
        const eventId = data.data?.dm_event_id || `local-${Date.now()}`;
        S.events.set(eventId, {
          id: eventId,
          event_type: "MessageCreate",
          text,
          sender_id: S.me.id,
          dm_conversation_id: data.data?.dm_conversation_id || t.id,
          created_at: new Date().toISOString(),
        });
        setDraft(t.id, null);
        S.sentNow.add(t.id);
        t.messages.push({ id: eventId, from: "me", text, at: new Date().toISOString() });
        return true;
      }
      if (res.status === 429) {
        const reset = Number(res.headers.get("x-rate-limit-reset"));
        const wait = reset ? reset * 1000 - Date.now() + 1000 : 60_000;
        if (wait > MAX_RATE_WAIT_MS) {
          S.errors.set(t.id, "X's daily DM limit was reached. Try the rest later.");
          S.sending.stop = true;
          return false;
        }
        const until = Date.now() + Math.max(wait, 5000);
        while (Date.now() < until && !S.sending.stop) {
          setSendLabel(`X rate limit. Resuming in ${Math.ceil((until - Date.now()) / 1000)}s…`);
          await sleep(1000);
        }
        if (S.sending.stop) return false;
        continue;
      }
      S.errors.set(t.id, xError(res.status, data).message);
      if (res.status === 401 || res.status === 402) S.sending.stop = true;
      return false;
    }
  }

  function showSendbar() {
    $("sendbar").hidden = false;
    setSendProgress();
  }
  function hideSendbar() {
    $("sendbar").hidden = true;
  }
  function setSendLabel(s) {
    $("send-label").textContent = s;
  }
  function setSendProgress() {
    if (!S.sending) return;
    const { done, failed, total } = S.sending;
    $("send-progress").style.width = `${Math.round(((done + failed) / total) * 100)}%`;
  }

  // ---------- rendering ----------

  function notify(msg, kind) {
    const n = $("notice");
    n.textContent = msg;
    n.className = `notice${kind ? ` ${kind}` : ""}`;
    n.hidden = false;
  }
  function hideNotice() {
    $("notice").hidden = true;
  }

  function avatar(user) {
    const initials = (user.name || user.username || "?").replace(/\(.*\)/, "").trim().slice(0, 1).toUpperCase();
    const fallback = el("div", { class: "avatar", "aria-hidden": "true", text: initials });
    if (!user.avatar) return fallback;
    const img = el("img", { class: "avatar", src: user.avatar, alt: "", referrerpolicy: "no-referrer", loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(fallback), { once: true });
    return img;
  }

  const PILL_TEXT = {
    empty: null,
    drafting: "Drafting",
    drafted: "Draft",
    approved: "Approved",
    sending: "Sending",
    sent: "Sent",
    skipped: "Skipped",
  };

  function createCard(t) {
    // Handlers read card._thread, which updateCard keeps current after reloads.
    let card;
    const cur = () => card._thread;
    const textarea = el("textarea", {
      rows: "3",
      "aria-label": `Reply to ${t.user.name}`,
      placeholder: "Write a reply, or click Suggest.",
    });
    textarea.addEventListener("input", () => {
      const th = cur();
      const d = draftOf(th) || { status: "drafted", basedOn: th.lastInboundId };
      setDraft(th.id, textarea.value ? { ...d, text: textarea.value } : null);
      updateCard(th, { keepText: true });
      renderToolbar();
    });

    card = el(
      "article",
      { class: "card" },
      el(
        "div",
        { class: "card-head" },
        avatar(t.user),
        el(
          "div",
          { class: "who-block" },
          el("div", { class: "name", text: t.user.name }),
          el("div", { class: "meta" }),
        ),
        el("span", { class: "pill" }),
      ),
      el("div", { class: "msgs" }),
      el(
        "div",
        { class: "draft" },
        textarea,
        el(
          "div",
          { class: "actions" },
          el("button", { class: "btn small suggest", type: "button", onclick: () => draftFor(cur()) }),
          el("button", { class: "btn small approve", type: "button", onclick: () => toggleApprove(cur()) }, "Approve"),
          el("button", { class: "btn small ghost skip", type: "button", text: "Skip", onclick: () => toggleSkip(cur()) }),
          el("span", { class: "count" }),
        ),
      ),
      el("div", { class: "sent-note", hidden: true, text: "Sent ✓" }),
      el("div", { class: "warnline", hidden: true }),
      el("div", { class: "err", role: "alert", hidden: true }),
    );
    card._thread = t;
    return card;
  }

  function renderMessages(box, t) {
    const all = t.messages;
    const show = S.expanded.has(t.id) ? all : all.slice(-3);
    const kids = [];
    if (show.length < all.length) {
      kids.push(
        el("button", {
          class: "more",
          type: "button",
          text: `Show ${all.length - show.length} earlier`,
          onclick: () => {
            S.expanded.add(t.id);
            updateCard(t, { keepText: true });
          },
        }),
      );
    }
    for (const m of show) {
      kids.push(
        el(
          "div",
          { class: `msg ${m.from}` },
          m.text,
          el("time", { datetime: m.at, text: `${m.from === "me" ? "You" : t.user.name.split(" ")[0]} · ${ago(m.at)}` }),
        ),
      );
    }
    box.replaceChildren(...kids);
  }

  function updateCard(t, { keepText = false } = {}) {
    const card = S.cards.get(t.id);
    if (!card) return;
    card._thread = t;
    const status = statusOf(t);
    const d = draftOf(t);
    const sendingAny = Boolean(S.sending);

    card.className = `card ${status}`;
    card.querySelector(".meta").textContent = `@${t.user.username} · ${t.waiting ? "waiting on you" : "you replied last"} · ${ago(t.lastAt)}`;
    const pill = card.querySelector(".pill");
    pill.textContent = PILL_TEXT[status] || "";
    pill.className = `pill ${status}`;
    pill.hidden = !PILL_TEXT[status];

    renderMessages(card.querySelector(".msgs"), t);

    const draftBox = card.querySelector(".draft");
    const textarea = draftBox.querySelector("textarea");
    draftBox.hidden = status === "sent" || status === "skipped";
    card.querySelector(".sent-note").hidden = status !== "sent";

    const text = d?.text ?? "";
    if (!keepText && document.activeElement !== textarea && textarea.value !== text) textarea.value = text;
    textarea.disabled = status === "drafting" || status === "sending" || sendingAny;

    const suggest = draftBox.querySelector(".suggest");
    suggest.replaceChildren();
    if (status === "drafting") {
      suggest.append(el("span", { class: "spinner", "aria-hidden": "true" }), " Drafting");
    } else {
      suggest.append(d?.text ? "Redo" : "Suggest");
    }
    suggest.disabled = status === "drafting" || sendingAny || !draftingEnabled();
    suggest.title = draftingEnabled() ? "" : connected() ? "Drafting is off until ANTHROPIC_API_KEY is set" : "Connect X to draft with AI";

    const approve = draftBox.querySelector(".approve");
    approve.textContent = status === "approved" ? "Approved ✓" : "Approve";
    approve.classList.toggle("on", status === "approved");
    approve.setAttribute("aria-pressed", String(status === "approved"));
    approve.disabled = !d?.text?.trim() || status === "drafting" || sendingAny || (d?.text?.length ?? 0) > DM_MAX_CHARS;

    draftBox.querySelector(".skip").disabled = sendingAny;

    const len = textarea.value.length;
    const count = draftBox.querySelector(".count");
    count.textContent = len ? `${len.toLocaleString()} chars` : "";
    count.style.color = len > DM_MAX_CHARS ? "var(--danger)" : "";

    const warn = card.querySelector(".warnline");
    if (status === "skipped") {
      warn.replaceChildren("Skipped. ", el("button", { class: "more", type: "button", text: "Undo", onclick: () => toggleSkip(t) }));
      warn.hidden = false;
    } else if (isStale(t) && d?.text) {
      warn.textContent = "They wrote again after this draft. Check it, then approve again.";
      warn.hidden = false;
    } else if (t.sample) {
      warn.textContent = draftingEnabled() ? "Sample conversation. Drafting works, sending doesn't." : "Sample conversation with an example draft.";
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }

    const err = card.querySelector(".err");
    err.textContent = S.errors.get(t.id) || "";
    err.hidden = !S.errors.has(t.id);
  }

  function toggleApprove(t) {
    const d = draftOf(t);
    if (!d?.text?.trim()) return;
    const approved = statusOf(t) === "approved";
    setDraft(t.id, { ...d, status: approved ? "drafted" : "approved", basedOn: t.lastInboundId });
    updateCard(t, { keepText: true });
    renderToolbar();
  }

  function toggleSkip(t) {
    if (isSkipped(t)) delete S.skipped[t.id];
    else S.skipped[t.id] = t.lastInboundId;
    store.set("canopy.skipped", S.skipped);
    renderList();
  }

  function renderList() {
    const list = $("list");
    const visible = visibleThreads();
    const keep = new Set(visible.map((t) => t.id));
    for (const [id, card] of S.cards) {
      if (!keep.has(id)) {
        card.remove();
        S.cards.delete(id);
      }
    }
    visible.forEach((t, i) => {
      let card = S.cards.get(t.id);
      if (!card) {
        card = createCard(t);
        S.cards.set(t.id, card);
      }
      if (list.children[i] !== card) list.insertBefore(card, list.children[i] || null);
      updateCard(t);
    });

    const empty = $("empty");
    if (visible.length === 0) {
      empty.hidden = false;
      empty.textContent = !S.loaded
        ? "Load your inbox to see who messaged you."
        : S.threads.length === 0
          ? "Nobody has DM'd you in the loaded history. Try Load older."
          : "You're caught up. Nobody in this view is waiting on you.";
    } else {
      empty.hidden = true;
    }
    $("sample-banner").hidden = !S.threads.some((t) => t.sample);
    renderToolbar();
  }

  function renderToolbar() {
    const real = S.loaded;
    const waiting = S.threads.filter((t) => t.waiting && !isSkipped(t)).length;
    $("c-waiting").textContent = waiting;
    $("c-all").textContent = S.threads.length;
    $("c-drafted").textContent = visibleThreads().filter((t) => statusOf(t) === "drafted").length;
    $("c-approved").textContent = S.threads.filter(sendable).length;
    $("f-waiting").setAttribute("aria-selected", String(S.filter === "waiting"));
    $("f-all").setAttribute("aria-selected", String(S.filter === "all"));

    const busy = S.loading || Boolean(S.sending);
    $("load").disabled = busy || !connected();
    $("load").textContent = S.loading && !S.loadingAll ? "Loading…" : real ? "Refresh inbox" : "Load inbox";
    $("older").disabled = busy || !S.nextToken;
    $("all").disabled = Boolean(S.sending) || (!S.loadingAll && (S.loading || !S.nextToken));
    $("all").textContent = S.loadingAll ? "Stop loading" : "Load all 30 days";
    $("suggest").disabled = Boolean(S.sending) || !draftingEnabled();
    $("approve-all").disabled = Boolean(S.sending);
    $("send").disabled = Boolean(S.sending) || !connected();

    if (real) {
      const times = [...S.events.values()].map((e) => e.created_at).filter(Boolean).sort();
      const since = times.length ? new Date(times[0]).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
      const bits = [`${S.threads.length} ${S.threads.length === 1 ? "person" : "people"} DM'd you`];
      if (since) bits.push(`since ${since}`);
      if (S.hiddenCold) bits.push(`${S.hiddenCold} cold thread${S.hiddenCold === 1 ? "" : "s"} hidden`);
      $("load-status").textContent = bits.join(" · ");
    } else {
      $("load-status").textContent = "";
    }
  }

  function renderAccount() {
    const box = $("account");
    if (connected() && S.me) {
      box.replaceChildren(
        el(
          "div",
          { class: "who" },
          avatar({ name: S.me.name, username: S.me.username, avatar: S.me.profile_image_url }),
          el("span", { text: `@${S.me.username}` }),
        ),
        el("button", { class: "btn small ghost", type: "button", text: "Disconnect", onclick: disconnect }),
      );
    } else if (connected()) {
      box.replaceChildren(el("span", { class: "muted small", text: "Token saved" }),
        el("button", { class: "btn small ghost", type: "button", text: "Disconnect", onclick: disconnect }));
    } else {
      box.replaceChildren(el("span", { class: "muted small", text: "Not connected" }));
    }
  }

  function renderSetup() {
    const setup = $("setup");
    setup.hidden = connected();
    if (connected()) return;
    const c = S.config || {};
    const box = $("setup-oauth");
    const callback = `${location.origin}/callback`;
    const kids = [];
    if (c.oauth) {
      kids.push(
        el("button", { class: "btn primary connect", type: "button", text: "Connect X", onclick: startOAuth }),
        el(
          "div",
          { class: "callback small muted" },
          "Callback URL registered in your X app must be exactly ",
          el("code", { text: callback }),
          el("button", {
            class: "btn small ghost",
            type: "button",
            text: "Copy",
            onclick: (e) => {
              navigator.clipboard?.writeText(callback).then(() => (e.target.textContent = "Copied"), () => {});
            },
          }),
        ),
      );
    }
    const items = [
      ["X_CLIENT_ID", c.oauth, "your X app's OAuth 2.0 Client ID (plus X_CLIENT_SECRET if the app has one)"],
      ["ALLOWED_X_USERNAMES", c.allowlist, "your X handle, so only you can use this Canopy"],
      ["ANTHROPIC_API_KEY", c.drafting, "turns on AI drafting"],
    ];
    if (items.some(([, ok]) => !ok)) {
      kids.push(
        el("p", { class: "small", text: "Server setup on Netlify (Site configuration → Environment variables):" }),
        el(
          "ul",
          { class: "checklist small" },
          ...items.map(([key, ok, what]) =>
            el("li", { class: ok ? "ok" : "missing" }, `${ok ? "✓" : "○"} `, el("code", { text: key }), ` ${what}`),
          ),
        ),
      );
    }
    box.replaceChildren(...kids);
  }

  function rebuild() {
    S.threads = buildThreads();
    if (!draftingEnabled()) {
      // Seed example drafts on the samples so edit and approve can be tried
      // before signing in.
      for (const t of S.threads) {
        if (t.sample && !draftOf(t)) setDraft(t.id, { text: t.example, status: "drafted", basedOn: t.lastInboundId });
      }
    }
    renderAccount();
    renderSetup();
    renderList();
  }

  // ---------- wiring ----------

  function wire() {
    $("load").addEventListener("click", loadInbox);
    $("older").addEventListener("click", loadOlder);
    $("all").addEventListener("click", loadAll);
    $("suggest").addEventListener("click", suggestNext);
    $("approve-all").addEventListener("click", approveAll);
    $("send").addEventListener("click", sendApproved);
    $("send-stop").addEventListener("click", () => {
      if (S.sending) {
        S.sending.stop = true;
        setSendLabel("Stopping after the current message…");
      }
    });
    for (const [id, f] of [["f-waiting", "waiting"], ["f-all", "all"]]) {
      $(id).addEventListener("click", () => {
        S.filter = f;
        store.set("canopy.filter", f);
        renderList();
      });
    }

    const voice = $("voice");
    const goal = $("goal");
    voice.value = S.voice;
    goal.value = S.goal;
    const summarize = () => {
      const bits = [];
      if (S.voice.trim()) bits.push("voice set");
      if (S.goal.trim()) bits.push(`goal: ${S.goal.trim().slice(0, 60)}${S.goal.trim().length > 60 ? "…" : ""}`);
      $("voice-summary").textContent = bits.length ? bits.join(" · ") : "not set yet";
    };
    voice.addEventListener("input", () => {
      S.voice = voice.value;
      store.set("canopy.voice", S.voice);
      summarize();
    });
    goal.addEventListener("input", () => {
      S.goal = goal.value;
      store.set("canopy.goal", S.goal);
      summarize();
    });
    summarize();
    if (!S.voice.trim()) $("voice-box").open = true;

    $("manual-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = $("manual-token").value.trim();
      if (!token) return;
      saveAuth({ access_token: token, refresh_token: null, expires_at: null, source: "manual" });
      $("manual-token").value = "";
      try {
        await refreshSession();
        notify(`Connected as @${S.me.username}.`);
        rebuild();
        await loadInbox();
      } catch (err) {
        saveAuth(null);
        saveSession(null);
        notify(err.message, "error");
        rebuild();
      }
    });

    window.addEventListener("beforeunload", (e) => {
      if (S.sending) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  async function init() {
    wire();
    try {
      const res = await fetch("/api/config");
      S.config = res.ok ? await res.json() : {};
    } catch {
      S.config = {};
    }

    let autoload = false;
    if (location.pathname === "/callback") autoload = await finishOAuth();

    rebuild();
    if (connected() && S.config.drafting === false) {
      notify("Drafting is off until ANTHROPIC_API_KEY is set on Netlify. You can still write and send replies by hand.", "warn");
    }
    if (autoload) await loadInbox();
  }

  init();
})();
