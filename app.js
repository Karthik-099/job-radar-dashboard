// Job Radar dashboard. Plain JS, no build step, no CDN. All job text is untrusted: it is only ever set via
// textContent, and links are allowed only for http(s) URLs.
"use strict";
(() => {
  const { deriveKey, decryptBlob, encryptWithKey, decryptWithKey } = window.JRCrypto;

  // ------------------------------------------------------------------ constants and state
  // Pipeline in order. "shortlisted" is the recruiter screen (key kept for old data).
  const STATUSES = ["new", "applied", "shortlisted", "assessment", "interview", "final", "offer", "rejected", "ghosted", "ignored"];
  const LABEL = { new: "New", applied: "Applied", shortlisted: "Screening", assessment: "Assessment", interview: "Interview",
    final: "Final round", offer: "Offer", rejected: "Rejected", ghosted: "Ghosted", ignored: "Hidden" };
  // You already applied (any outcome): the same role is never shown again as new, under any city or board.
  const APPLIED = new Set(["applied", "shortlisted", "assessment", "interview", "final", "offer", "rejected", "ghosted"]);
  const RESPONDED = new Set(["shortlisted", "assessment", "interview", "final", "offer", "rejected"]);
  const ACTIVE = ["applied", "shortlisted", "assessment", "interview", "final"];
  const STAGE_VAR = Object.fromEntries(STATUSES.map((s) => [s, `--st-${s}`]));
  const REGION = { india: "India", remote: "Remote", abroad: "Abroad", unknown: "Unclear" };
  const LOCK_AFTER_MS = 15 * 60 * 1000;
  const SYNC_DEBOUNCE_MS = 20 * 1000;
  // Fallback when the token can't write files: one workflow run per batch, at most every 5 minutes (~1-2 Actions
  // minutes each), and anything GitHub dropped (it cancels queued runs) is re-sent after 15 minutes.
  const DISPATCH_EVERY_MS = 5 * 60 * 1000;
  const RESEND_MS = 15 * 60 * 1000;
  const LS = { local: "jr.local.v1", salt: "jr.salt.v1", theme: "jr.theme" };
  const DAY = 86400000;
  const VIEWS = ["today", "jobs", "board", "companies", "map", "learn", "insights", "settings"];

  const S = {
    pass: null, localKey: null, data: null, jobs: [], byId: new Map(),
    local: { overrides: {}, token: "", repo: "", goal: 5, lastSync: null, lastSyncError: "", views: [] },
    view: "today", listLimit: 150, sort: "prio", showIgnored: false, selectedId: null, bulk: new Set(),
    filters: { q: "", status: "open", region: "", posted: "", minScore: "", source: "", hideClosed: true, target: false, yc: false },
    range: 30, learnTopic: "all", lastActive: Date.now(), syncTimer: null, failed: 0, appliedRk: new Set(),
    remote: {}, renderedView: null,
  };

  // ------------------------------------------------------------------ tiny DOM helpers (textContent only)
  const $ = (sel, root = document) => root.querySelector(sel);
  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "href") node.setAttribute("href", safeUrl(v));
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      if (typeof kid === "string" && /^(null|undefined|none|nan)+$/i.test(kid.trim())) continue; // never show "nullnull"
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
  // Append children, skipping empty sections and flattening lists (Element.append would print "null").
  function put(root, ...kids) { for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) root.append(k); }
  const svg = (tag, attrs = {}) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  function safeUrl(u) { return /^https?:\/\//i.test(String(u || "")) ? String(u) : "#"; }
  function extLink(text, url, cls = "btn") {
    return el("a", { class: cls, href: url, target: "_blank", rel: "noopener noreferrer" }, text);
  }
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add("hidden"), 2800);
  }
  const fmtInt = (n) => new Intl.NumberFormat().format(n || 0);
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");
  const localDay = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Icons: small inline strokes (no icon font, no CDN).
  const ICONS = {
    home: "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z", list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    board: "M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z", globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
    play: "M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM10 8.5v7l6-3.5z", chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3", refresh: "M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5",
    moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z", lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
    ext: "M14 3h7v7M10 14 21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5", check: "M20 6 9 17l-5-5",
    x: "M18 6 6 18M6 6l12 12", copy: "M9 9h11v11H9zM5 15H4V4h11v1", down: "M12 3v12m0 0-5-5m5 5 5-5M4 21h16",
    star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z", mail: "M3 5h18v14H3zM3 6l9 7 9-7",
    filter: "M3 5h18l-7 9v6l-4-2v-4z", building: "M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h3M8 12h3M8 16h3", key: "M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z",
  };
  function icon(name, size = 16) {
    const s = svg("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
      "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "ic" });
    s.append(svg("path", { d: ICONS[name] || "" }));
    return s;
  }
  function hydrateIcons(root = document) { root.querySelectorAll("i[data-icon]").forEach((i) => i.replaceWith(icon(i.dataset.icon))); }

  // ------------------------------------------------------------------ time labels
  function parse(iso) { const t = Date.parse(iso || ""); return Number.isNaN(t) ? null : t; }
  function hasTime(iso) { return !!iso && !/T00:00:00(\+00:00|Z)?$/.test(iso); }
  function agoLabel(iso) {
    const t = parse(iso);
    if (t === null) return "";
    const h = Math.max(0, (Date.now() - t) / 3600000);
    if (hasTime(iso) && h < 48) return h < 1 ? "just now" : `${Math.floor(h)}h ago`;
    const d = Math.floor(h / 24);
    return d === 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
  }
  function closesLabel(iso) {
    const t = parse(iso);
    if (t === null) return "";
    const d = Math.floor((t - Date.now()) / DAY);
    if (d < 0) return "closed";
    return d === 0 ? "closes today" : `closes in ${d}d`;
  }
  const postedAt = (j) => parse(j.posted) ?? parse(j.seen) ?? 0;

  // ------------------------------------------------------------------ status model (server + local + other devices)
  function lastServerChange(job) {
    const h = (job.history || []).filter((x) => x.status);
    return h.length ? h[h.length - 1].at : "";
  }
  // Newest wins: this device's unsynced change, another device's change waiting in the repo inbox, or the server.
  function override(job) {
    const a = S.local.overrides[job.id], b = S.remote[job.id];
    const o = a && b ? (a.at >= b.at ? a : b) : a || b;
    return o && o.at > lastServerChange(job) ? o : null;
  }
  function statusOf(job) { return override(job)?.status || job.status; }
  function noteOf(job) {
    const o = override(job);
    return o?.note ?? ((job.history || []).filter((h) => h.note && h.via !== "gmail").slice(-1)[0]?.note || "");
  }
  function setStatus(job, status, note) {
    const prev = S.local.overrides[job.id];
    S.local.overrides[job.id] = { status, at: new Date().toISOString(), note: note ?? prev?.note ?? noteOf(job), sent: false };
    saveLocal();
    scheduleSync();
    render();
    toast(`${LABEL[status]}: ${job.title}`);
  }
  // A local change is kept until the published data shows it (or something newer), then dropped.
  function pruneSyncedOverrides() {
    for (const [id, o] of Object.entries(S.local.overrides)) {
      const job = S.byId.get(id);
      if (!job) { if (Date.now() - (parse(o.at) || 0) > 3 * DAY) delete S.local.overrides[id]; continue; }
      const stamp = o.at.slice(0, 19);
      const h = job.history || [];
      const applied = h.some((x) => x.status === o.status && x.at.slice(0, 19) >= stamp);
      const newer = lastServerChange(job).slice(0, 19) > stamp;
      const lastNote = (h.filter((x) => x.note).slice(-1)[0] || {}).note || "";
      const same = job.status === o.status && (o.note || "") === lastNote;
      if (applied || newer || same) delete S.local.overrides[id];
    }
  }
  const unconfirmed = () => Object.entries(S.local.overrides);
  const pendingChanges = () => unconfirmed().filter(([, o]) => !o.sent || (S.local.mode === "actions" && Date.now() - (o.sentAt || 0) > RESEND_MS));

  function appliedStamp(job) {
    const stamps = (job.history || []).filter((h) => h.status === "applied").map((h) => h.at);
    const o = override(job);
    if (o && o.status === "applied") stamps.push(o.at);
    return stamps.sort()[0] || (APPLIED.has(statusOf(job)) ? lastServerChange(job) || job.seen : null);
  }
  function appliedDays() {
    const days = new Map();
    for (const job of S.jobs) {
      if (!APPLIED.has(statusOf(job)) && !(job.history || []).some((h) => h.status === "applied")) continue;
      const first = appliedStamp(job);
      if (first) days.set(localDay(first), (days.get(localDay(first)) || 0) + 1);
    }
    return days;
  }
  function streak(days) {
    let n = 0;
    const d = new Date();
    if (!days.get(localDay(d))) d.setDate(d.getDate() - 1);
    while (days.get(localDay(d))) { n += 1; d.setDate(d.getDate() - 1); }
    return n;
  }
  // Funnel from everything this browser knows, so every tile agrees with "Applied today".
  function funnel(sinceMs = 0) {
    const ever = (j, st) => statusOf(j) === st || (j.history || []).some((h) => h.status === st);
    const applied = S.jobs.filter((j) => (APPLIED.has(statusOf(j)) || ever(j, "applied")) && (parse(appliedStamp(j)) || 0) >= sinceMs);
    const f = { tracked: S.jobs.length, applied: applied.length, responded: 0, screening: 0, assessment: 0, interviews: 0,
      final: 0, offers: 0, rejected: 0, ghosted: 0, list: applied };
    for (const j of applied) {
      const st = statusOf(j);
      if (RESPONDED.has(st)) f.responded += 1;
      if (["shortlisted", "assessment", "interview", "final", "offer"].includes(st) || ever(j, "shortlisted")) f.screening += 1;
      if (["assessment", "interview", "final", "offer"].includes(st) || ever(j, "assessment")) f.assessment += 1;
      if (["interview", "final", "offer"].includes(st) || ever(j, "interview")) f.interviews += 1;
      if (["final", "offer"].includes(st) || ever(j, "final")) f.final += 1;
      if (st === "offer") f.offers += 1;
      if (st === "rejected") f.rejected += 1;
      if (st === "ghosted") f.ghosted += 1;
    }
    return f;
  }

  // ------------------------------------------------------------------ local encrypted storage
  async function localKeyFor(pass) {
    let salt = null;
    try { salt = localStorage.getItem(LS.salt); } catch (_) { /* storage blocked */ }
    if (!salt) {
      salt = window.JRCrypto.b64e(crypto.getRandomValues(new Uint8Array(16)));
      try { localStorage.setItem(LS.salt, salt); } catch (_) { /* fine */ }
    }
    return deriveKey(pass, window.JRCrypto.b64d(salt), 600000);
  }
  async function loadLocal() {
    try {
      const raw = localStorage.getItem(LS.local);
      if (raw) Object.assign(S.local, await decryptWithKey(S.localKey, JSON.parse(raw)));
    } catch (_) { toast("Saved settings were made with another passphrase and were reset"); }
    S.local.views = S.local.views || [];
  }
  async function saveLocal() {
    if (!S.localKey) return;
    try { localStorage.setItem(LS.local, JSON.stringify(await encryptWithKey(S.localKey, S.local))); } catch (_) { /* storage blocked */ }
  }

  // ------------------------------------------------------------------ unlock / lock / refresh
  async function fetchBlob(path = "data/jobs.enc.json") {
    const resp = await fetch(path, { cache: "no-store" });
    if (!resp.ok) throw new Error(resp.status === 404 ? "No data published yet. Run the scan workflow once." : `Could not load data (${resp.status})`);
    return resp.json();
  }
  // Start downloading the encrypted data as soon as the page opens, while you type the passphrase.
  let early = fetchBlob().then((blob) => ({ blob, at: Date.now() })).catch(() => null);
  async function unlock(pass) {
    const pre = early && await early;
    early = null;
    const blob = pre && Date.now() - pre.at < 5 * 60 * 1000 ? pre.blob : await fetchBlob();
    const [data, localKey] = await Promise.all([decryptBlob(blob, pass), localKeyFor(pass)]);
    S.pass = pass;
    S.localKey = localKey;
    await loadLocal();
    setData(data);
    readInbox();
  }
  function setData(data) {
    S.data = data;
    S.jobs = data.jobs || [];
    S.byId = new Map(S.jobs.map((j) => [j.id, j]));
    pruneSyncedOverrides();
    if (!S.local.repo) S.local.repo = guessRepo();
    if (S.localKey) saveLocal();
    if (pendingChanges().length) scheduleSync();
  }
  async function refresh() {
    try {
      setData(await decryptBlob(await fetchBlob(), S.pass));
      await readInbox();
      render();
      toast("Up to date");
    } catch (e) { toast(e.message || "Refresh failed"); }
  }
  function lock() {
    flushSync();
    S.pass = null; S.localKey = null; S.data = null; S.jobs = []; S.byId = new Map();
    location.reload(); // wipes every key and decrypted byte from memory
  }
  function guessRepo() {
    const owner = location.hostname.endsWith(".github.io") ? location.hostname.split(".")[0] : "";
    return owner ? `${owner}/job-radar` : "";
  }

  $("#lock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#pass"), btn = $("#unlock-btn"), err = $("#lock-error");
    btn.disabled = true;
    btn.textContent = "Unlocking…";
    err.textContent = "";
    try {
      await unlock(input.value);
      input.value = "";
      $("#lock").classList.add("hidden");
      $("#app").classList.remove("hidden");
      S.failed = 0;
      const hash = location.hash.slice(1);
      if (VIEWS.includes(hash)) S.view = hash;
      render();
      $("#view").focus({ preventScroll: true });
    } catch (ex) {
      S.failed += 1;
      await new Promise((r) => setTimeout(r, Math.min(8000, 900 * S.failed))); // slow down guessing
      err.textContent = ex instanceof DOMException || ex?.name === "OperationError" ? "Wrong passphrase." : (ex.message || "Could not unlock.");
      input.select();
    } finally {
      btn.disabled = false;
      btn.textContent = "Unlock";
    }
  });
  $("#pass-toggle").addEventListener("click", (e) => {
    const input = $("#pass"), show = input.type === "password";
    input.type = show ? "text" : "password";
    e.currentTarget.textContent = show ? "Hide" : "Show";
    e.currentTarget.setAttribute("aria-pressed", String(show));
    e.currentTarget.setAttribute("aria-label", show ? "Hide passphrase" : "Show passphrase");
    input.focus();
  });
  $("#lock-btn").addEventListener("click", lock);
  $("#refresh-btn").addEventListener("click", refresh);
  $("#palette-btn").addEventListener("click", openPalette);
  for (const ev of ["pointerdown", "keydown", "scroll", "touchstart"]) addEventListener(ev, () => { S.lastActive = Date.now(); }, { passive: true });
  setInterval(() => { if (S.pass && Date.now() - S.lastActive > LOCK_AFTER_MS) lock(); }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSync();
    else if (S.pass && Date.now() - S.lastActive > LOCK_AFTER_MS) lock();
  });

  // ------------------------------------------------------------------ themes
  const THEMES = { light: "Light · ocean", dark: "Dark · ocean" };
  // Light is the default; any older saved choice (system, midnight, aurora) falls back to it.
  function currentTheme() { try { const t = localStorage.getItem(LS.theme); return THEMES[t] ? t : "light"; } catch (_) { return "light"; } }
  function applyTheme() {
    document.documentElement.dataset.theme = currentTheme();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue("--page").trim() || "#0f1115";
  }
  function setTheme(t) {
    try { localStorage.setItem(LS.theme, t); } catch (_) { /* fine */ }
    applyTheme();
    $(".theme-menu")?.remove();
    if (S.data) render();
  }
  function toggleTheme() {
    const order = Object.keys(THEMES), next = order[(order.indexOf(currentTheme()) + 1) % order.length];
    setTheme(next);
    toast(`Theme: ${THEMES[next]}`);
  }
  $("#theme-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $(".theme-menu");
    if (open) return open.remove();
    const menu = el("div", { class: "theme-menu", role: "menu", "aria-label": "Theme" }, Object.entries(THEMES).map(([k, label]) =>
      el("button", { type: "button", role: "menuitemradio", "aria-checked": String(currentTheme() === k), onclick: () => setTheme(k) },
        el("span", { class: `swatch ${k}` }), label)));
    $("#theme-btn").parentElement.append(menu);
    setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }));
  });
  applyTheme();
  hydrateIcons();

  // ------------------------------------------------------------------ sync to the private repo
  // Two ways, picked automatically from what the token may do:
  //   files    token has Contents: write -> each batch is a small JSON file in state/inbox/ (0 Actions minutes);
  //            other devices read those files, and the next scan applies them.
  //   actions  token has only Actions: write -> the update-status workflow is started (old way, costs minutes),
  //            batched to at most one run per DISPATCH_EVERY_MS.
  const repoOk = () => /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(S.local.repo || "");
  async function gh(path, opts = {}) {
    return fetch(`https://api.github.com/repos/${S.local.repo}/${path}`, { ...opts,
      headers: { Authorization: `Bearer ${S.local.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) } });
  }
  function b64utf8(text) { return window.JRCrypto.b64e(new TextEncoder().encode(text)); }
  async function pushInbox(kind, body) {
    if (!S.local.token || !repoOk()) throw new Error("Add your token in Settings → Sync");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `state/inbox/${stamp}-${Math.random().toString(36).slice(2, 8)}-${kind}.json`;
    const resp = await gh(`contents/${name}`, { method: "PUT", body: JSON.stringify({
      message: `inbox: ${kind}`, content: b64utf8(JSON.stringify({ v: 1, kind, ...body })) }) }); // default branch
    if (resp.status === 401 || resp.status === 403 || resp.status === 404) throw Object.assign(new Error("Token can't write files"), { noContents: true });
    if (!resp.ok) throw new Error(`GitHub said ${resp.status}`);
  }
  async function dispatch(changes, keepalive) {
    const resp = await gh("actions/workflows/update-status.yml/dispatches", { method: "POST", keepalive,
      body: JSON.stringify({ ref: "prod", inputs: { changes: JSON.stringify(changes) } }) });
    if (resp.status !== 204) throw new Error(resp.status === 401 || resp.status === 403 ? "Token rejected: check it in Settings" : `GitHub said ${resp.status}`);
  }
  async function readInbox() {
    if (!S.local.token || !repoOk()) return;
    try {
      const list = await gh("contents/state/inbox");
      if (!list.ok) { S.remote = {}; return; }
      const files = (await list.json()).filter((f) => f.type === "file" && /-status\.json$|^\d.*\.json$/.test(f.name)).slice(-60);
      const remote = {};
      await Promise.all(files.map(async (f) => {
        const r = await gh(`contents/${f.path}`, { headers: { Accept: "application/vnd.github.raw+json" } });
        if (!r.ok) return;
        const body = await r.json().catch(() => null);
        if (body?.kind !== "status") return;
        for (const c of body.changes || []) {
          if (!c || !S.byId.has(c.id) || !STATUSES.includes(c.status)) continue;
          if (!remote[c.id] || remote[c.id].at < c.at) remote[c.id] = { status: c.status, at: String(c.at), note: c.note || "" };
        }
      }));
      S.remote = remote;
      if (S.data) render();
    } catch (_) { /* offline: local view still works */ }
  }
  function scheduleSync() {
    if (!S.local.token) return renderSyncPill();
    clearTimeout(S.syncTimer);
    const wait = S.local.mode === "actions" ? Math.max(SYNC_DEBOUNCE_MS, (S.local.lastDispatch || 0) + DISPATCH_EVERY_MS - Date.now()) : SYNC_DEBOUNCE_MS;
    S.syncTimer = setTimeout(() => sync(), wait);
    renderSyncPill();
  }
  // Leaving the page: send now in files mode; in actions mode only if no run was started in the last 2 minutes.
  function flushSync() {
    if (!S.local.token || !pendingChanges().length) return;
    if (S.local.mode !== "actions" || Date.now() - (S.local.lastDispatch || 0) > 2 * 60 * 1000) sync(true);
  }
  async function sync(keepalive = false) {
    clearTimeout(S.syncTimer);
    const pending = pendingChanges();
    if (!pending.length || !S.local.token) return renderSyncPill();
    if (!repoOk()) { S.local.lastSyncError = "Set the repository in Settings"; return renderSyncPill(); }
    try {
      if (S.local.mode !== "actions") {
        try {
          await pushInbox("status", { changes: pending.map(([id, o]) => ({ id, status: o.status, at: o.at, note: o.note || undefined })) });
          S.local.mode = "files";
          for (const [, o] of pending) o.sent = true;
        } catch (e) {
          if (!e.noContents) throw e;
          S.local.mode = "actions"; // this token can't write files: fall back to the workflow, batched
        }
      }
      if (S.local.mode === "actions") {
        // Every run carries ALL unconfirmed changes: GitHub cancels a queued run when a newer one arrives.
        const all = unconfirmed().sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, 150)
          .map(([id, o]) => ({ id, status: o.status, at: o.at, note: o.note || undefined }));
        while (all.length > 1 && JSON.stringify(all).length > 60000) all.pop(); // workflow input limit ~65 KB
        await dispatch(all, keepalive);
        S.local.lastDispatch = Date.now();
        for (const c of all) Object.assign(S.local.overrides[c.id] || {}, { sent: true, sentAt: Date.now() });
      }
      S.local.lastSync = new Date().toISOString();
      S.local.lastSyncError = "";
    } catch (e) { S.local.lastSyncError = e.message || "Sync failed"; }
    await saveLocal();
    renderSyncPill();
  }
  function renderSyncPill() {
    const pill = $("#sync-pill");
    const n = unconfirmed().length, due = pendingChanges().length;
    pill.className = "pill";
    pill.title = "";
    if (!S.local.token) { pill.textContent = n ? `${n} on this device only` : "Local only"; if (n) pill.classList.add("pending"); return; }
    if (S.local.lastSyncError) { pill.textContent = "Sync error"; pill.title = S.local.lastSyncError; pill.classList.add("pending"); return; }
    if (due) { pill.textContent = `${due} to sync`; pill.classList.add("pending"); return; }
    if (n) {
      pill.textContent = S.local.mode === "actions" ? `${n} syncing` : `${n} saved to repo`;
      pill.classList.add("busy");
      pill.title = S.local.mode === "actions" ? "Sent to GitHub; other devices show it in about 3 minutes after Refresh." : "Saved in your private repo; folded into the data at the next scan.";
      return;
    }
    pill.textContent = "Synced";
    pill.classList.add("ok");
  }

  // ------------------------------------------------------------------ routing
  document.querySelectorAll(".nav button").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));
  function go(view) {
    if (!VIEWS.includes(view)) return;
    S.view = view;
    S.listLimit = 150;
    history.replaceState(null, "", `#${view}`);
    render();
    scrollTo(0, 0);
  }
  function render() {
    if (!S.data) return;
    document.querySelectorAll(".nav button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === S.view)));
    S.appliedRk = new Set(S.jobs.filter((j) => APPLIED.has(statusOf(j)) && j.rk).map((j) => j.rk));
    $("#updated").textContent = `Data ${agoLabel(S.data.generated_at) || "–"} · ${fmtInt(S.jobs.length)} jobs`;
    $("#count-jobs").textContent = fmtInt(S.jobs.filter((j) => statusOf(j) === "new" && isOpen(j)).length);
    $("#count-pipe").textContent = fmtInt(S.jobs.filter((j) => ACTIVE.includes(statusOf(j))).length) || "";
    renderSyncPill();
    const view = $("#view");
    if (S.view !== "map") window.JRMap?.unmount?.();
    view.replaceChildren();
    view.classList.remove("enter");
    if (S.renderedView !== S.view) { void view.offsetWidth; view.classList.add("enter"); S.renderedView = S.view; }
    view.dataset.view = S.view;
    ({ today: renderToday, jobs: renderJobs, board: renderBoard, companies: renderCompanies, map: renderMap, learn: renderLearn,
      insights: renderInsights, settings: renderSettings })[S.view](view);
    animateCounters(view);
  }
  function animateCounters(root) {
    if (reduceMotion) return;
    root.querySelectorAll("[data-count]").forEach((node) => {
      const target = Number(node.dataset.count), suffix = node.dataset.suffix || "";
      if (!Number.isFinite(target) || target === 0) return;
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 600), eased = 1 - (1 - k) ** 3;
        node.textContent = fmtInt(Math.round(target * eased)) + suffix;
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  // ------------------------------------------------------------------ shared job bits
  const sameRoleApplied = (j) => statusOf(j) === "new" && !!j.rk && S.appliedRk.has(j.rk);
  const isOpen = (j) => !["ignored", "rejected", "offer", "ghosted"].includes(statusOf(j)) && !(j.flags || []).includes("closed") && !sameRoleApplied(j);
  function scoreRing(j, size = 40) {
    const s = j.score, v = s == null ? 0 : Math.max(0, Math.min(10, s)) / 10;
    const cls = s == null ? "lo" : s >= 7.5 ? "hi" : s >= 5 ? "mid" : "lo";
    const r = size / 2 - 3, c = 2 * Math.PI * r;
    const ring = svg("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size, "aria-hidden": "true" });
    ring.append(svg("circle", { cx: size / 2, cy: size / 2, r, class: "ring-bg" }),
      svg("circle", { cx: size / 2, cy: size / 2, r, class: "ring-fg", "stroke-dasharray": `${c * v} ${c}`, transform: `rotate(-90 ${size / 2} ${size / 2})` }));
    return el("div", { class: `ring ${cls}`, title: `Resume fit ${s ?? "?"}/10 · priority ${Math.round(j.prio || 0)}`,
      "aria-label": `Fit ${s ?? "unknown"} out of 10` }, ring, el("span", {}, s == null ? "–" : Number(s).toFixed(1)));
  }
  function flagChips(j) {
    const out = [], f = j.flags || [];
    if (j.target) out.push(el("span", { class: "chip target" }, "Target"));
    if (j.yc) out.push(el("span", { class: "chip yc", title: "Y Combinator company" }, "YC"));
    if (sameRoleApplied(j)) out.push(el("span", { class: "chip have", title: "You applied to this same role elsewhere" }, "Applied (same role)"));
    const last = (j.history || []).filter((h) => h.status).slice(-1)[0];
    if (last && last.via === "gmail" && last.status === j.status) out.push(el("span", { class: "chip mail", title: last.note || "" }, "✉ From Gmail"));
    if (f.includes("closed")) out.push(el("span", { class: "chip flag" }, "Closed"));
    if (f.includes("reposted")) out.push(el("span", { class: "chip warn", title: "Re-posted several times: may be an evergreen or ghost listing" }, "Re-posted"));
    if (f.includes("hidden_text")) out.push(el("span", { class: "chip flag", title: "The posting hides text or instructions aimed at AI screeners" }, "Hidden text"));
    if (f.includes("no_visa_info")) out.push(el("span", { class: "chip warn" }, "Visa?"));
    if (j.visa === true) out.push(el("span", { class: "chip have" }, "Visa / relocation"));
    if (j.ai?.level_fit === "too_senior") out.push(el("span", { class: "chip flag" }, "Likely too senior"));
    return out;
  }
  function metaLine(j) {
    const posted = agoLabel(j.posted) || (j.seen ? `seen ${agoLabel(j.seen)}` : "");
    const closes = closesLabel(j.expires);
    const fresh = postedAt(j) > Date.now() - DAY;
    return el("div", { class: "meta" },
      posted && el("span", { class: fresh ? "chip fresh" : "" }, posted.startsWith("seen") ? posted : posted),
      closes && el("span", { class: "chip warn" }, closes),
      el("span", {}, REGION[j.region] || j.region),
      j.years != null && el("span", {}, `${j.years}+ yrs`),
      j.salary && el("span", {}, j.salary),
      el("span", { class: "src" }, j.source));
  }
  function stageSelect(j) {
    const st = statusOf(j);
    return el("label", { class: "stage-select" }, el("span", { class: "sr-only" }, "Stage"),
      el("select", { class: `st-${st}`, "aria-label": `Stage for ${j.title}`, onclick: (e) => e.stopPropagation(),
        onchange: (e) => setStatus(j, e.target.value) },
        STATUSES.map((s) => el("option", { value: s, selected: s === st }, LABEL[s]))));
  }
  function stageChip(st) { return el("span", { class: `chip stage st-${st}` }, el("i", { class: "dot" }), LABEL[st]); }
  // Fit as a "match" ring (score out of 10 shown as a percentage).
  function matchRing(j) {
    const s = j.score, v = s == null ? 0 : Math.max(0, Math.min(10, s)) / 10, r = 24, c = 2 * Math.PI * r;
    const ring = svg("svg", { viewBox: "0 0 56 56", width: 56, height: 56, "aria-hidden": "true" });
    ring.append(svg("circle", { cx: 28, cy: 28, r, class: "mr-bg" }),
      svg("circle", { cx: 28, cy: 28, r, class: "mr-fg", "stroke-dasharray": `${c * v} ${c}`, transform: "rotate(-90 28 28)" }));
    return el("div", { class: "match", title: `Resume fit ${s ?? "?"}/10 · priority ${Math.round(j.prio || 0)}`, "aria-label": `${s == null ? "Unscored" : `${Math.round(v * 100)}% match`}` },
      ring, el("div", { class: "mr-text" }, el("strong", {}, s == null ? "–" : `${Math.round(v * 100)}%`), el("span", {}, "match")));
  }
  const TONES = 6;
  const toneOf = (name) => [...String(name)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % TONES; // stable per company
  const initials = (name) => String(name).replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
  function jobCard(j) {
    const st = statusOf(j), sel = S.view === "jobs" && j.id === S.selectedId;
    const skills = [...new Set([...(j.ai?.matched_skills || []), ...(j.tl?.have || [])])].slice(0, 6);
    const posted = agoLabel(j.posted) || (j.seen ? `seen ${agoLabel(j.seen)}` : "");
    const closes = closesLabel(j.expires);
    return el("article", { class: `jc tone-${toneOf(j.company)} st-${st}${sel ? " sel" : ""}${(j.flags || []).includes("closed") ? " closed" : ""}`,
      dataset: { id: j.id }, tabindex: "-1" },
      el("div", { class: "jc-top" },
        el("div", { class: "jc-head" },
          el("div", { class: "jc-where" },
            el("div", { class: "jc-loc" }, j.location || REGION[j.region] || "Location unclear",
              j.years != null ? el("span", { class: "jc-badge", title: "Stated minimum experience" }, `${j.years}+ yrs`) : null),
            el("div", { class: "jc-when" }, j.remote || j.region === "remote" ? el("span", { class: "jc-remote" }, "Remote") : null,
              posted ? el("span", { class: postedAt(j) > Date.now() - DAY ? "jc-fresh" : "" }, posted) : null,
              closes ? el("span", { class: "jc-closes" }, closes) : null)),
          S.view === "jobs" ? el("input", { type: "checkbox", class: "bulk", checked: S.bulk.has(j.id), "aria-label": `Select ${j.title}`,
            onclick: (e) => { e.stopPropagation(); toggleBulk(j.id); } }) : null,
          matchRing(j)),
        el("button", { class: "jc-title", type: "button", onclick: () => openJob(j) }, j.title),
        skills.length ? el("div", { class: "jc-tags" }, skills.map((x) => el("span", {}, x))) : null,
        el("div", { class: "jc-flags" }, st !== "new" ? stageChip(st) : null, flagChips(j))),
      el("div", { class: "jc-bar" },
        st === "new" || st === "ignored"
          ? el("button", { type: "button", onclick: () => setStatus(j, "applied") }, icon("check", 14), "Mark applied")
          : el("div", { class: "jc-stage" }, stageSelect(j)),
        el("button", { type: "button", onclick: () => openJob(j) }, icon("list", 14), "Details")),
      el("div", { class: "jc-foot" },
        el("span", { class: "jc-avatar", "aria-hidden": "true" }, initials(j.company)),
        el("span", { class: "jc-co", title: j.company }, j.company),
        el("button", { class: "btn small pill", type: "button", title: st === "ignored" ? "Show again" : "Hide this job",
          onclick: () => setStatus(j, st === "ignored" ? "new" : "ignored") }, st === "ignored" ? "Unpass" : "Pass"),
        extLink("Apply", j.url, "btn small pill dark")));
  }
  function cardsOrEmpty(list, emptyText) {
    return list.length ? el("div", { class: "cards" }, list.map(jobCard)) : el("div", { class: "empty" }, emptyText);
  }
  function section(title, sub, body, extra) {
    return el("section", { class: "section" }, el("div", { class: "section-head" }, el("h2", {}, title, sub && el("span", { class: "sub" }, sub)), extra), body);
  }
  function tile(label, value, note, extra, opts = {}) {
    const v = el("div", { class: "value" }, value);
    if (opts.count != null) { v.dataset.count = String(opts.count); if (opts.suffix) v.dataset.suffix = opts.suffix; }
    return el("div", { class: `tile ${opts.cls || ""}` }, el("div", { class: "label" }, label), v,
      note && el("div", { class: "note" }, note), extra);
  }
  function pageHead(title, sub, ...actions) {
    return el("div", { class: "page-head" }, el("div", {}, el("h1", {}, title), sub && el("p", { class: "sub" }, sub)),
      actions.length ? el("div", { class: "page-actions" }, actions) : null);
  }

  // ------------------------------------------------------------------ scanner status
  function nextRunAt(schedule) {
    const every = schedule?.every_hours || 4, minute = schedule?.minute_utc ?? 17;
    const d = new Date();
    d.setUTCSeconds(0, 0);
    for (let i = 0; i < 24 * 60; i++) {
      d.setUTCMinutes(d.getUTCMinutes() + 1);
      if (d.getUTCMinutes() === minute && d.getUTCHours() % every === 0) return d;
    }
    return null;
  }
  function inLabel(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  function scannerPanel() {
    const runs = S.data.runs || [], last = runs[runs.length - 1], lr = S.data.last_run || {};
    const next = nextRunAt(S.data.schedule);
    const ok = last ? last.sources_ok === last.sources_total : !lr.sources_failed;
    const today = runs.filter((r) => localDay(r.at) === localDay(Date.now()));
    const b = S.data.budget || {};
    const cell = (label, value, note, cls) => el("div", { class: `scan-cell ${cls || ""}` },
      el("div", { class: "label" }, label), el("div", { class: "value" }, value), note && el("div", { class: "note" }, note));
    return el("section", { class: "scanner", "aria-label": "Scanner status" },
      cell("Last scan", last ? agoLabel(last.at) : agoLabel(S.data.generated_at),
        last ? (ok ? "✓ all sources OK" : `⚠ ${last.sources_total - last.sources_ok} of ${last.sources_total} sources failed`) : "", ok ? "ok" : "warn"),
      cell("Added last scan", last ? `+${fmtInt(last.added)}` : "–", last ? `${fmtInt(last.already_tracked)} already tracked` : ""),
      cell("Added today", `+${fmtInt(today.reduce((n, r) => n + (r.added || 0), 0))}`, `${today.length} scan${today.length === 1 ? "" : "s"} today`),
      cell("Next scan", next ? `in ${inLabel(next - Date.now())}` : "–", next ? `about ${next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""),
      cell("Actions minutes", b.cap ? `${fmtInt(b.used)} / ${fmtInt(b.cap)}` : "–", b.cap ? "this month · hard stop at the cap" : "", b.used > b.cap * 0.9 ? "warn" : ""));
  }

  // ------------------------------------------------------------------ Today
  function renderToday(root) {
    const days = appliedDays();
    const today = days.get(localDay(Date.now())) || 0;
    const goal = Math.max(1, Number(S.local.goal) || 5);
    const bar = el("div", { class: "goal-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(goal), "aria-valuenow": String(today) }, el("div"));
    bar.firstChild.style.width = `${Math.min(100, (100 * today) / goal)}%`;
    const st = streak(days);
    const open = S.jobs.filter((j) => statusOf(j) === "new" && isOpen(j));
    const fresh = open.filter((j) => postedAt(j) > Date.now() - DAY).sort((a, b) => postedAt(b) - postedAt(a));
    const picks = (S.data.apply_next || []).map((id) => S.byId.get(id)).filter((j) => j && statusOf(j) === "new" && isOpen(j));
    const closing = open.filter((j) => { const t = parse(j.expires); return t && t > Date.now() && t - Date.now() < 5 * DAY; }).sort((a, b) => parse(a.expires) - parse(b.expires));
    const follow = (S.data.follow_ups || []).map((f) => S.byId.get(f.id)).filter((j) => j && statusOf(j) === "applied");
    const f = funnel();
    const review = (S.data.gmail?.review || []).filter((r) => Date.now() - (parse(r.at) || 0) < 21 * DAY && !(S.local.dismissed || []).includes(r.key));
    const hour = new Date().getHours();
    put(root, pageHead(`${hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}, ${S.data.resume?.intro?.first_name || "there"}`,
        `${fmtInt(open.length)} open matches · ${fmtInt(fresh.length)} new in the last 24 hours`),
      scannerPanel(),
      el("div", { class: "tiles" },
        tile("Applied today", `${today} / ${goal}`, today >= goal ? "Goal met. Nice work." : `${goal - today} to go`, bar, { cls: "accent" }),
        tile("Streak", `${st} day${st === 1 ? "" : "s"}`, "days in a row with an application"),
        tile("In progress", fmtInt(f.applied - f.rejected - f.ghosted - f.offers), "active applications", null, { count: f.applied - f.rejected - f.ghosted - f.offers }),
        tile("Response rate", pct(f.responded, f.applied), `${f.responded} of ${f.applied} replied`),
        tile("Interviews", fmtInt(f.interviews), `${pct(f.interviews, f.applied)} of applications`, null, { count: f.interviews })),
      review.length ? gmailReview(review) : null,
      section("Apply next", "best fit × location × freshness, max 3 per company", cardsOrEmpty(picks.slice(0, 12), "Nothing waiting. New jobs arrive with every scan.")),
      section("Fresh", "posted in the last 24 hours", cardsOrEmpty(fresh.slice(0, 12), "No new postings in the last 24 hours yet.")),
      closing.length ? section("Closing soon", "apply before the deadline", cardsOrEmpty(closing.slice(0, 9), "")) : null,
      follow.length ? section("Follow up", "applied a week ago, no update: ping the recruiter or a referrer", cardsOrEmpty(follow.slice(0, 9), "")) : null);
  }
  function gmailReview(items) {
    const dismiss = async (r) => {
      S.local.dismissed = [...(S.local.dismissed || []), r.key].slice(-200);
      await saveLocal();
      try { await pushInbox("dismiss", { review: [r.key] }); } catch (_) { /* stays dismissed on this device */ }
      render();
    };
    return section("Check by hand", "a company you applied to emailed you, but it wasn't certain which job or outcome: nothing was changed",
      el("div", { class: "review-list" }, items.slice().reverse().map((r) => {
        const sug = r.suggest && S.byId.get(r.suggest);
        return el("div", { class: "review" },
          el("div", { class: "review-top" }, icon("mail"), el("strong", {}, r.company), stageChip(r.outcome), el("span", { class: "sub" }, agoLabel(r.at))),
          el("div", { class: "subject" }, r.subject), el("div", { class: "sub" }, r.why),
          el("div", { class: "card-actions" },
            sug ? el("button", { class: "btn small primary", type: "button", onclick: () => { setStatus(sug, r.outcome, `Gmail: ${r.subject}`.slice(0, 500)); dismiss(r); } },
              `Mark "${sug.title}" ${LABEL[r.outcome] || r.outcome}`) : null,
            (r.jobs || []).map((id) => S.byId.get(id)).filter((j) => j && j !== sug)
              .map((j) => el("button", { class: "btn small", type: "button", onclick: () => openJob(j) }, `${j.title} ↗`)),
            el("button", { class: "btn small ghost", type: "button", onclick: () => dismiss(r) }, "Dismiss")));
      })));
  }

  // ------------------------------------------------------------------ Jobs (list + detail)
  const SORTS = { prio: ["Priority", (j) => -(j.prio || 0)], fit: ["Fit", (j) => -(j.score ?? -1)], posted: ["Newest", (j) => -postedAt(j)],
    company: ["Company", (j) => j.company.toLowerCase()] };
  function filtered() {
    const f = S.filters, q = f.q.trim().toLowerCase();
    const horizon = { "24h": DAY, "3d": 3 * DAY, "7d": 7 * DAY, "30d": 30 * DAY }[f.posted];
    const terms = q ? q.split(/\s+/) : [];
    return S.jobs.filter((j) => {
      const st = statusOf(j);
      if (f.status === "open" && (!isOpen(j) || st !== "new")) return false;
      if (f.status === "active" && !ACTIVE.includes(st)) return false;
      if (f.status && !["open", "active"].includes(f.status) && st !== f.status) return false;
      if (f.region && j.region !== f.region) return false;
      if (horizon && postedAt(j) < Date.now() - horizon) return false;
      if (f.minScore && (j.score ?? 0) < Number(f.minScore)) return false;
      if (f.source && j.source !== f.source) return false;
      if (f.hideClosed && (j.flags || []).includes("closed")) return false;
      if (f.target && !j.target) return false;
      if (f.yc && !j.yc) return false;
      if (terms.length) { const hay = `${j.title} ${j.company} ${j.location} ${j.source}`.toLowerCase(); if (!terms.every((t) => hay.includes(t))) return false; }
      return true;
    }).sort((a, b) => { const k = SORTS[S.sort][1]; const x = k(a), y = k(b); return x > y ? 1 : x < y ? -1 : 0; });
  }
  function pill(label, key, options) {
    const f = S.filters, current = options.find(([v]) => v === f[key]) || options[0];
    return el("label", { class: `fpill${f[key] && f[key] !== options[0][0] ? " on" : ""}` }, el("span", { class: "fl" }, label),
      el("select", { "aria-label": label, onchange: (e) => { f[key] = e.target.value; S.listLimit = 150; render(); } },
        options.map(([v, t]) => el("option", { value: v, selected: v === current[0] }, t))));
  }
  function toggle(label, key) {
    return el("button", { type: "button", class: `fpill toggle${S.filters[key] ? " on" : ""}`, "aria-pressed": String(!!S.filters[key]),
      onclick: () => { S.filters[key] = !S.filters[key]; render(); } }, label);
  }
  function renderJobs(root) {
    const f = S.filters;
    const sources = [...new Set(S.jobs.map((j) => j.source))].sort();
    const rows = filtered();
    if (!S.selectedId || !rows.some((j) => j.id === S.selectedId)) S.selectedId = rows[0]?.id || null;
    const search = el("input", { type: "search", class: "search", placeholder: "Filter by title, company, city…", value: f.q, "aria-label": "Filter jobs" });
    let typing = null;
    search.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { f.q = search.value; S.listLimit = 150; render(); $(".search")?.focus(); const s = $(".search"); if (s) s.selectionStart = s.selectionEnd = s.value.length; }, 160); });
    const saved = el("div", { class: "views-row" },
      (S.local.views || []).map((v, i) => el("span", { class: "view-chip" },
        el("button", { type: "button", onclick: () => { S.filters = { ...S.filters, ...v.filters }; render(); } }, v.name),
        el("button", { type: "button", class: "x", "aria-label": `Delete view ${v.name}`, onclick: async () => { S.local.views.splice(i, 1); await saveLocal(); render(); } }, "×"))),
      el("button", { type: "button", class: "btn small ghost", onclick: async () => {
        const name = prompt("Name this view (filters are saved):");
        if (!name) return;
        S.local.views.push({ name: name.slice(0, 30), filters: { ...S.filters } });
        await saveLocal(); render();
      } }, "+ Save view"));
    const filters = el("div", { class: "filterbar" }, search, el("div", { class: "fpills" },
      pill("Status", "status", [["open", "Not applied"], ["active", "In progress"], ["", "Any"], ...STATUSES.map((s) => [s, LABEL[s]])]),
      pill("Region", "region", [["", "All"], ["india", "India"], ["remote", "Remote"], ["abroad", "Abroad"]]),
      pill("Posted", "posted", [["", "Any time"], ["24h", "24 hours"], ["3d", "3 days"], ["7d", "7 days"], ["30d", "30 days"]]),
      pill("Fit", "minScore", [["", "Any"], ["6", "6+"], ["7", "7+"], ["8", "8+"]]),
      pill("Source", "source", [["", "All"], ...sources.map((s) => [s, s])]),
      toggle("Target cos", "target"), toggle("YC", "yc"), toggle("Hide closed", "hideClosed"),
      el("label", { class: "fpill" }, el("span", { class: "fl" }, "Sort"),
        el("select", { "aria-label": "Sort", onchange: (e) => { S.sort = e.target.value; render(); } },
          Object.entries(SORTS).map(([k, [t]]) => el("option", { value: k, selected: S.sort === k }, t))))));
    const more = rows.length > S.listLimit
      ? el("button", { class: "btn more", type: "button", onclick: () => { S.listLimit += 150; render(); } }, `Show ${fmtInt(Math.min(150, rows.length - S.listLimit))} more`) : null;
    put(root, pageHead("Browse jobs", `${fmtInt(rows.length)} shown · j/k move · Enter details · a applied · x pass · o open · space select`),
      filters, saved, bulkBar(),
      rows.length ? el("div", { class: "cards" }, rows.slice(0, S.listLimit).map(jobCard)) : el("div", { class: "empty" }, "No jobs match these filters."), more);
  }
  function selectJob(id) {
    S.selectedId = id;
    render();
    document.querySelector(`.jc[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }
  function toggleBulk(id) { if (S.bulk.has(id)) S.bulk.delete(id); else S.bulk.add(id); render(); }
  function bulkBar() {
    if (!S.bulk.size) return null;
    const apply = (st) => {
      const at = new Date().toISOString();
      for (const id of S.bulk) { const j = S.byId.get(id); if (j) S.local.overrides[id] = { status: st, at, note: noteOf(j), sent: false }; }
      toast(`${S.bulk.size} jobs → ${LABEL[st]}`);
      S.bulk.clear(); saveLocal(); scheduleSync(); render();
    };
    return el("div", { class: "bulkbar", role: "region", "aria-label": "Bulk actions" }, el("strong", {}, `${S.bulk.size} selected`),
      el("button", { class: "btn small good", type: "button", onclick: () => apply("applied") }, "Mark applied"),
      el("button", { class: "btn small", type: "button", onclick: () => apply("ignored") }, "Hide"),
      el("button", { class: "btn small ghost", type: "button", onclick: () => { S.bulk.clear(); render(); } }, "Clear"));
  }
  function openJob(j) {
    if (S.view === "jobs") S.selectedId = j.id;
    openDrawer(j);
  }

  // ------------------------------------------------------------------ job detail (pane on desktop, drawer elsewhere)
  function jobDetail(j) {
    const ai = j.ai || {}, st = statusOf(j);
    const list = (items, ordered) => el(ordered ? "ol" : "ul", {}, (items || []).map((t) => el("li", {}, t)));
    const people = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${j.company} engineer`)}`;
    const note = el("textarea", { "aria-label": "Your notes", placeholder: "Notes: referral contact, recruiter name, salary discussed…" });
    note.value = noteOf(j);
    note.addEventListener("change", () => {
      const o = S.local.overrides[j.id] || { status: statusOf(j), at: new Date().toISOString(), note: "", sent: false };
      if (o.note === note.value) return;
      S.local.overrides[j.id] = { ...o, note: note.value.slice(0, 500), at: new Date().toISOString(), sent: false };
      saveLocal(); scheduleSync(); toast("Note saved");
    });
    const message = referralMessage(j), short = referralShort(j);
    const musts = ai.must_haves || [];
    const brief = ai.brief || {};
    const block = (title, ...body) => el("section", { class: "dblock" }, el("h3", {}, title), ...body);
    const steps = ["applied", "shortlisted", "assessment", "interview", "final", "offer"];
    const stepIdx = steps.indexOf(st);
    return el("div", { class: "detail" },
      el("div", { class: "detail-head" },
        el("div", {}, el("h2", {}, j.title), el("div", { class: "card-co" }, `${j.company} · ${j.location || ""}`), metaLine(j)),
        scoreRing(j, 56)),
      el("div", { class: "detail-actions" }, extLink([icon("ext", 14), "Open job"], j.url, "btn primary"),
        st === "new" ? el("button", { class: "btn good", type: "button", onclick: () => setStatus(j, "applied") }, icon("check", 14), "Mark applied") : null,
        stageSelect(j), (j.alt || []).map((u, i) => extLink(`Alt ${i + 1} ↗`, u, "btn ghost"))),
      APPLIED.has(st) ? el("ol", { class: "stepper", "aria-label": "Application progress" }, steps.map((s, i) =>
        el("li", { class: i < stepIdx ? "done" : i === stepIdx ? "now" : "" }, LABEL[s])),
        st === "rejected" || st === "ghosted" ? el("li", { class: "end" }, LABEL[st]) : null) : null,
      el("div", { class: "chips" }, flagChips(j)),
      (j.reasons || []).length ? el("p", { class: "reasons" }, j.reasons.join(" · ")) : null,
      musts.length ? block("Must-haves vs your resume", el("ul", { class: "checklist" }, musts.map((m) =>
        el("li", { class: m.met ? "ok" : "no" }, icon(m.met ? "check" : "x", 14), m.req)))) : null,
      brief.they_want?.length || brief.specifics?.length ? block("The role in brief",
        brief.they_want?.length ? el("p", {}, el("strong", {}, "They want: "), brief.they_want.join("; ")) : null,
        brief.specifics?.length ? el("p", {}, el("strong", {}, "Specifics: "), brief.specifics.join("; ")) : null,
        brief.unclear?.length ? el("p", { class: "sub" }, el("strong", {}, "Not stated: "), brief.unclear.join("; ")) : null) : null,
      block("Tailored resume", tailorPanel(j)),
      j.letter ? block("Cover letter", el("div", { class: "letter-box" }, j.letter),
        el("div", { class: "row" }, el("button", { class: "btn small", type: "button", onclick: () => copy(j.letter, "Cover letter") }, icon("copy", 14), "Copy"),
          el("button", { class: "btn small", type: "button", onclick: () => printDoc(j, "letter") }, icon("down", 14), "Download PDF")),
        el("p", { class: "sub" }, "Drafted by a free model and fact-checked: sentences with numbers or tools not on your resume were removed.")) : null,
      block("People to contact", el("p", { class: "sub" }, "Searches that open on LinkedIn in your browser. Nothing is fetched or automated, so your account is never at risk."),
        el("div", { class: "contacts" }, contactLinks(j).map(([who, hint, url]) =>
          el("a", { class: "contact", href: url, target: "_blank", rel: "noopener noreferrer" }, el("strong", {}, who), el("span", {}, hint), icon("ext", 14))))),
      block("Referral message", el("div", { class: "referral" }, message),
        el("div", { class: "row" }, el("button", { class: "btn small primary", type: "button", onclick: () => copy(message, "Referral message") }, icon("copy", 14), "Copy message"),
          el("button", { class: "btn small", type: "button", title: short, onclick: () => copy(short, "Short note (fits LinkedIn's 300 characters)") }, "Copy short note"),
          extLink("Find a referrer ↗", people, "btn small ghost")),
        el("p", { class: "sub" }, "Replace [Name], attach your PDF and send it yourself. Nothing is ever sent or automated on LinkedIn.")),
      ai.matched_skills?.length || ai.missing_skills?.length ? block("Skills",
        el("div", { class: "chips" }, (ai.matched_skills || []).map((s) => el("span", { class: "chip have" }, s)),
          (ai.missing_skills || []).map((s) => el("span", { class: "chip miss" }, s)))) : null,
      [...(ai.red_flags || []), ...(ai.legit || [])].length ? block("Watch out", list([...(ai.red_flags || []), ...(ai.legit || [])])) : null,
      ai.interview_topics?.length ? block("Interview prep", list(ai.interview_topics, true)) : null,
      ai.tailoring_tips?.length ? block("Points to stress", list(ai.tailoring_tips, true)) : null,
      ai.method !== "llm" ? el("p", { class: "sub" }, "The AI brief appears after this job is scored by the AI (usually within a few scans).") : null,
      (j.history || []).length ? block("Timeline", el("ol", { class: "timeline" }, [...(j.history || [])].reverse().slice(0, 10).map((h) =>
        el("li", {}, el("span", { class: "t-when" }, agoLabel(h.at)), h.status ? stageChip(h.status) : el("span", {}, h.event || "event"),
          h.via ? el("span", { class: "sub" }, `via ${h.via}`) : null, h.note && h.via === "gmail" ? el("span", { class: "sub" }, h.note) : null)))) : null,
      block("Notes", note),
      j.desc ? block("From the posting", el("div", { class: "desc" }, j.desc)) : null);
  }
  function openDrawer(j) {
    const rootEl = $("#drawer-root");
    const prevFocus = document.activeElement;
    const close = () => { rootEl.replaceChildren(); document.removeEventListener("keydown", onKey); prevFocus?.focus?.(); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    const drawer = el("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": `${j.title} at ${j.company}` },
      el("button", { class: "btn small ghost close", type: "button", onclick: close, "aria-label": "Close" }, icon("x")), jobDetail(j));
    rootEl.replaceChildren(el("div", { class: "backdrop", onclick: close }), drawer);
    drawer.querySelector(".close").focus();
  }

  // ------------------------------------------------------------------ people to contact (LinkedIn search links only)
  // The likely hiring manager's title, from the job's family.
  function managerTitle(title) {
    const t = title.toLowerCase();
    if (/hpc|research computing|scientific computing|supercomput|gpu/.test(t)) return "HPC OR \"Research Computing\" manager";
    if (/mlops|ml ops|machine learning|ai /.test(t)) return "\"ML Platform\" OR \"MLOps\" manager";
    if (/secur|devsecops/.test(t)) return "\"Security Engineering\" OR DevSecOps manager";
    if (/sre|reliability|observability/.test(t)) return "SRE OR \"Site Reliability\" manager";
    if (/platform|kubernetes/.test(t)) return "\"Platform Engineering\" manager";
    if (/cloud|aws|azure|gcp/.test(t)) return "\"Cloud Engineering\" OR \"Cloud Infrastructure\" manager";
    if (/system|linux|admin/.test(t)) return "\"IT Infrastructure\" OR \"Systems\" manager";
    return "DevOps OR \"Engineering Manager\" OR \"Infrastructure\" manager";
  }
  function contactLinks(j) {
    const q = (kw) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${kw} ${j.company}`)}`;
    return [
      ["Recruiters", "Technical recruiter, talent acquisition", q("\"technical recruiter\" OR \"talent acquisition\" OR recruiter")],
      ["Likely hiring manager", managerTitle(j.title).replace(/\\?"/g, ""), q(managerTitle(j.title))],
      ["Engineers on the team", "Ask for a referral", q("DevOps OR SRE OR \"platform engineer\" OR \"cloud engineer\"")],
    ];
  }

  // ------------------------------------------------------------------ referral message (your format, max 5 lines)
  const GENERIC_SKILLS = new Set(["Containerization", "Container Orchestration", "Microservices", "Machine Learning", "Infrastructure as Code",
    "Continuous Integration", "Continuous Delivery", "Cost Optimization", "Capacity Planning", "Monitoring", "Automation", "Dashboards",
    "Compliance", "Encryption", "Alerting", "Linux", "Git", "YAML", "Bash", "DNS", "SSH", "TCP/IP", "SSL/TLS", "Troubleshooting",
    "Networking", "SQL", "NoSQL", "IaC", "CI/CD Pipelines"]);
  function topSkills(j, n = 3) {
    const have = (j.tl?.have || []).filter((x) => !GENERIC_SKILLS.has(x));
    const ai = (j.ai?.matched_skills || []).map((x) => x.replace(/\b\w/g, (c) => c.toUpperCase()));
    const out = [...new Set([...have, ...ai, "Kubernetes", "Terraform", "AWS"])].slice(0, n);
    return out.length > 1 ? `${out.slice(0, -1).join(", ")} and ${out[out.length - 1]}` : out[0];
  }
  function referralMessage(j) {
    const r = S.data.resume || {}, me = r.intro || {};
    const hl = (r.highlights || [])[j.tl?.hl ?? 0]?.text;
    const role = j.ref ? `the ${j.title} role at ${j.company} (Job ID: ${j.ref})` : `the ${j.title} role at ${j.company}`;
    return ["Hello [Name],",
      `I am ${me.first_name || "Karthik"} from ${me.city || "Bangalore, India"}, currently working as a ${me.title || "DevOps Engineer"} at ${me.company || "InCruiter"}.`,
      `I came across ${role} and would be grateful if you could refer me${j.ref ? "." : `: ${j.url}`}`,
      `I have hands-on experience with ${topSkills(j)}${hl ? `, and I ${hl}` : ""}.`,
      "I have attached my resume for your reference. Thank you for your time."].join("\n");
  }
  function referralShort(j) {
    const me = S.data.resume?.intro || {};
    const id = j.ref ? ` (Job ID: ${j.ref})` : "";
    let msg = `Hi [Name], I'm ${me.first_name || "Karthik"}, a ${me.title || "DevOps Engineer"} at ${me.company || "InCruiter"}. I'm applying for the ${j.title} role at ${j.company}${id} and would really appreciate a referral. Happy to share my resume. Thank you.`;
    if (msg.length > 300) msg = msg.replace(` the ${j.title} role`, " this role");
    return msg.slice(0, 300);
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch (_) { toast("Copy failed: select the text instead"); }
  }

  // ------------------------------------------------------------------ resume + cover letter printed to PDF (your layout)
  function rich(text) {
    return String(text || "").split(/(\*\*[^*]+\*\*)/).filter(Boolean)
      .map((part) => (part.startsWith("**") ? el("strong", {}, part.slice(2, -2)) : document.createTextNode(part)));
  }
  const ordered = (items, order) => (order && order.length === items.length ? order.map((i) => items[i]) : items);
  function contactLine(r) {
    const c = r.contact || {};
    const bits = [c.email, c.phone, c.location].filter(Boolean).map((x) => document.createTextNode(x));
    for (const l of c.links || []) bits.push(el("a", { href: l.url }, l.label));
    return el("div", { class: "r-contact" }, bits.flatMap((b, i) => (i ? [document.createTextNode(" | "), b] : [b])));
  }
  function resumeNode(j) {
    const r = S.data.resume || {}, t = (j && j.tl) || {}, c = r.contact || {};
    const sec = (title, ...kids) => el("section", {}, el("h2", {}, title), ...kids);
    const profile = (r.profile || {})[t.fam] || (r.profile || {}).default || "";
    const mine = j ? chosenSkills(j) : [];
    const lastLine = Math.max(0, (r.skills || []).length - 1);
    const skills = (r.skills || []).map((line, i) => {
      // Skills you chose to add for this job go in the line they belong to (or the last line).
      const yours = mine.filter((name) => Math.min(t.mline?.[t.missing.indexOf(name)] ?? lastLine, lastLine) === i);
      const items = [...ordered(line.items || [], (t.skills || [])[i]), ...((t.add || {})[i] || []), ...yours];
      return el("p", { class: "r-skill" }, el("strong", {}, `${line.label}: `), items.join(", "));
    });
    const exp = (r.experience || []).map((x, i) => el("div", { class: "r-role" },
      el("div", { class: "r-row" }, el("strong", {}, [x.title, x.company, x.location].filter(Boolean).join(", ")), el("strong", {}, x.dates)),
      x.subtitle ? el("div", { class: "r-sub" }, x.subtitle) : null,
      el("ul", {}, ordered(x.bullets || [], (t.exp || [])[i]).map((b) => el("li", {}, rich(b))))));
    const gh = (c.links || []).find((l) => /github/i.test(l.label))?.url;
    const projects = el("ul", {}, ordered(r.projects || [], t.proj).map((pr) => el("li", {},
      el("strong", {}, `${pr.name}${pr.year ? ` (${pr.year})` : ""}`), " ", pr.link || gh ? el("a", { href: pr.link || gh }, "[GitHub]") : null, ": ", rich(pr.text))));
    const edu = (r.education || []).map((e) => el("div", { class: "r-role" },
      el("div", { class: "r-row" }, el("strong", {}, e.school), el("strong", {}, e.dates)), el("div", {}, e.degree)));
    return el("article", { class: "resume" }, el("h1", {}, r.name || ""), contactLine(r), c.tagline ? el("div", { class: "r-tag" }, c.tagline) : null,
      profile ? sec("Profile", el("p", {}, profile)) : null, sec("Skills", ...skills), sec("Work Experience", ...exp),
      (r.projects || []).length ? sec("Projects", projects) : null,
      (r.awards || []).length ? sec("Awards & Certifications", el("ul", {}, (r.awards || []).map((a) => el("li", {}, rich(a))))) : null,
      sec("Education", ...edu));
  }
  function letterNode(j) {
    const r = S.data.resume || {};
    const date = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    return el("article", { class: "resume letter" }, el("h1", {}, r.name || ""), contactLine(r),
      el("div", { class: "l-meta" }, el("div", {}, date), el("div", {}, `${j.company}`), el("div", {}, `Re: ${j.title}${j.ref ? ` (Job ID: ${j.ref})` : ""}`)),
      el("p", {}, "Dear Hiring Team,"), String(j.letter || "").split(/\n\n+/).map((p) => el("p", {}, p)),
      el("p", {}, "Kind regards,"), el("p", {}, el("strong", {}, r.name || "")));
  }
  // Fit on one A4 sheet: start at your PDF's size and step down only if needed.
  function fitOnePage(node) {
    const pagePx = (297 * 96) / 25.4 - 6;
    let size = 13.4;
    node.style.fontSize = `${size}px`;
    while (node.scrollHeight > pagePx && size > 10.6) { size -= 0.2; node.style.fontSize = `${size.toFixed(1)}px`; }
  }
  async function printDoc(j, kind = "resume") {
    const r = S.data.resume;
    if (!r || !r.name) { toast("No resume data yet: it appears after the next scan."); return; }
    const root = $("#print-root");
    const node = kind === "letter" ? letterNode(j) : resumeNode(j);
    root.replaceChildren(node);
    root.classList.add("measuring");
    try { await Promise.all(["400", "700", "italic 400"].map((w) => document.fonts.load(`${w} 13px "Lato JR"`))); } catch (_) { /* fallback font */ }
    fitOnePage(node);
    root.classList.remove("measuring");
    const prevTitle = document.title;
    const company = j ? `_${j.company.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}` : "";
    document.title = `${(r.name || "Resume").replace(/\s+/g, "_")}_${kind === "letter" ? "Cover_Letter" : "Resume"}${company}`; // the PDF's file name
    const done = () => { document.title = prevTitle; root.replaceChildren(); removeEventListener("afterprint", done); };
    addEventListener("afterprint", done);
    setTimeout(() => window.print(), 50);
  }
  // Missing keywords you decided to add to this job's tailored resume (saved encrypted on this device).
  function chosenSkills(j) { return ((S.local.addedSkills || {})[j.id] || []).filter((x) => (j.tl?.missing || []).includes(x)); }
  function toggleSkill(j, name, panel) {
    const all = (S.local.addedSkills = S.local.addedSkills || {});
    const cur = new Set(all[j.id] || []);
    if (cur.has(name)) cur.delete(name); else cur.add(name);
    if (cur.size) all[j.id] = [...cur]; else delete all[j.id];
    saveLocal();
    panel.replaceWith(tailorPanel(j));
    toast(cur.has(name) ? `Added ${name} to this tailored resume` : `Removed ${name}`);
  }
  function tailorPanel(j) {
    const t = j.tl || {};
    if (!S.data.resume?.name) return el("p", { class: "sub" }, "Tailored resume appears after the next scan.");
    const meter = (label, v, cls) => {
      const bar = el("div", { class: `meter ${cls}` }, el("div"));
      bar.firstChild.style.width = `${v ?? 0}%`;
      return el("div", { class: "meter-row" }, el("span", {}, label), bar, el("strong", {}, v == null ? "–" : `${v}%`));
    };
    const fam = { default: "your standard profile", sre: "SRE wording", platform: "platform wording", cloud: "cloud wording", mlops: "MLOps wording", devsecops: "DevSecOps wording" }[t.fam] || "your standard profile";
    const mine = chosenSkills(j);
    // Keyword hits after tailoring, plus the ones you added yourself.
    const after = t.after != null && t.n ? Math.min(100, Math.round((100 * (Math.round((t.after * t.n) / 100) + mine.length)) / t.n)) : t.after;
    const panel = el("div", { class: "tailor" });
    put(panel,
      t.before != null ? el("div", { class: "meters" }, meter("Your resume", t.before, "before"), meter("Tailored", after, "after"))
        : el("p", { class: "sub" }, "This posting lists few keywords, so the resume is reordered only."),
      el("p", { class: "sub" }, `ATS keyword match with this job. Most relevant bullets first, profile uses ${fam}. Same layout, one page, nothing invented.`),
      t.added?.length ? [el("div", { class: "sub" }, "Added to skills (your resume already proves these):"), el("div", { class: "chips" }, t.added.map((x) => el("span", { class: "chip have" }, `+ ${x}`)))] : null,
      t.missing?.length ? [el("div", { class: "sub" }, "Asked for but not on your resume. Click + to add one to this tailored resume's skills:"),
        el("div", { class: "chips" }, t.missing.map((x) => {
          const on = mine.includes(x);
          return el("button", { type: "button", class: `chip add-skill${on ? " on" : ""}`, "aria-pressed": String(on),
            title: on ? "Remove from this tailored resume" : "Add to this tailored resume's skills", onclick: () => toggleSkill(j, x, panel) }, on ? `✓ ${x}` : `+ ${x}`);
        })),
        mine.length ? el("p", { class: "sub warn-text" }, `Added by you: ${mine.join(", ")}. Only keep skills you can talk about in an interview.`) : null] : null,
      el("div", { class: "row" }, el("button", { class: "btn primary", type: "button", onclick: () => printDoc(j) }, icon("down", 14), "Download tailored resume (PDF)")),
      el("p", { class: "sub" }, "In the print window choose \"Save as PDF\" and paper A4. The PDF contains only your resume."));
    return panel;
  }

  // ------------------------------------------------------------------ Pipeline (kanban)
  function renderBoard(root) {
    const cols = ["new", "applied", "shortlisted", "assessment", "interview", "final", "offer", "rejected", "ghosted", ...(S.showIgnored ? ["ignored"] : [])];
    const groups = Object.fromEntries(cols.map((s) => [s, []]));
    for (const j of S.jobs) { const s = statusOf(j); if (groups[s]) groups[s].push(j); }
    groups.new = groups.new.filter((j) => isOpen(j)).sort((a, b) => (b.prio || 0) - (a.prio || 0)).slice(0, 40);
    const board = el("div", { class: "board" }, cols.map((s) => {
      const col = el("div", { class: `col st-${s}`, dataset: { status: s }, "aria-label": `${LABEL[s]} column` },
        el("h3", {}, el("span", { class: "col-title" }, el("i", { class: "dot" }), LABEL[s]), el("span", { class: "count-pill" }, s === "new" ? "top 40" : String(groups[s].length))),
        groups[s].length ? null : el("div", { class: "col-empty" }, "Drop cards here"),
        groups[s].map((j) => el("div", { class: `mini st-${s}`, draggable: "true", tabindex: "0", role: "button", "aria-label": `${j.title} at ${j.company}`,
          ondragstart: (e) => e.dataTransfer.setData("text/plain", j.id), onclick: () => openDrawer(j), onkeydown: (e) => { if (e.key === "Enter") openDrawer(j); } },
          el("div", { class: "t" }, j.title), el("div", { class: "c" }, j.company),
          el("div", { class: "m" }, el("span", {}, j.score != null ? `fit ${Number(j.score).toFixed(1)}` : ""), el("span", {}, agoLabel(lastServerChange(j) || j.posted)), el("span", {}, REGION[j.region] || "")))));
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drop"); });
      col.addEventListener("dragleave", () => col.classList.remove("drop"));
      col.addEventListener("drop", (e) => { e.preventDefault(); col.classList.remove("drop"); const job = S.byId.get(e.dataTransfer.getData("text/plain")); if (job && statusOf(job) !== s) setStatus(job, s); });
      return col;
    }));
    put(root, pageHead("Pipeline", "Drag cards between stages, or open a card to change its stage.",
      el("label", { class: "fpill toggle" }, el("input", { type: "checkbox", checked: S.showIgnored, onchange: (e) => { S.showIgnored = e.target.checked; render(); } }), " Show hidden")), board);
  }

  // ------------------------------------------------------------------ Insights (analytics)
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function niceMax(v) { if (v <= 5) return 5; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p) * p; }
  function shortDate(iso) { const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }
  function barChart({ title, sub, rows, series, goal, dateFmt }) {
    const fmtDate = dateFmt || shortDate;
    const W = 640, H = 220, L = 34, R = 8, T = 10, B = 26;
    const box = el("div", { class: "chart" }, el("h3", {}, title), el("div", { class: "sub" }, sub));
    if (series.length > 1) put(box, el("div", { class: "legend" }, series.map((s) => { const i = el("i"); i.style.background = cssVar(s.color); return el("span", {}, i, s.label); })));
    const totals = rows.map((r) => series.reduce((a, s) => a + (r[s.key] || 0), 0));
    const max = niceMax(Math.max(1, goal || 0, ...totals));
    const plotW = W - L - R, plotH = H - T - B, step = plotW / Math.max(1, rows.length), bw = Math.min(26, Math.max(2, step - 2));
    const y = (v) => T + plotH - (v / max) * plotH;
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title}. ${sub}` });
    for (const t of [0, max / 2, max]) {
      put(root, svg("line", { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 ? "base" : "grid" }));
      const lab = svg("text", { x: L - 6, y: y(t) + 4, "text-anchor": "end", class: "axis-label" }); lab.textContent = fmtInt(t); put(root, lab);
    }
    const tip = el("div", { class: "tooltip hidden", role: "status" });
    rows.forEach((r, i) => {
      const x = L + i * step + (step - bw) / 2;
      let acc = 0;
      const segs = series.filter((s) => (r[s.key] || 0) > 0);
      segs.forEach((s, k) => {
        const v = r[s.key] || 0, top = y(acc + v), bottom = y(acc) - (k > 0 ? 2 : 0), h = Math.max(0, bottom - top);
        const rr = Math.min(4, bw / 2, h);
        const d = k === segs.length - 1 ? `M${x},${bottom} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + bw - rr} Q${x + bw},${top} ${x + bw},${top + rr} V${bottom} Z` : `M${x},${bottom} V${top} H${x + bw} V${bottom} Z`;
        put(root, svg("path", { d, fill: cssVar(s.color) }));
        acc += v;
      });
      const hit = svg("rect", { x: L + i * step, y: T, width: step, height: plotH, fill: "transparent", tabindex: "0", "aria-label": `${fmtDate(r.date)}: ${series.map((s) => `${s.label} ${r[s.key] || 0}`).join(", ")}` });
      const show = () => {
        tip.replaceChildren(el("div", { class: "sub" }, fmtDate(r.date)),
          ...series.map((s) => { const k = el("span", { class: "key" }); k.style.background = cssVar(s.color); return el("div", { class: "row" }, k, el("strong", {}, fmtInt(r[s.key] || 0)), " ", s.label); }));
        tip.classList.remove("hidden");
        const bounds = root.getBoundingClientRect();
        tip.style.left = `${Math.min(bounds.width - 140, Math.max(0, (((L + (i + 0.5) * step) / W) * bounds.width) - 60)) + 14}px`;
        tip.style.top = "48px";
      };
      hit.addEventListener("mouseenter", show); hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", () => tip.classList.add("hidden")); hit.addEventListener("blur", () => tip.classList.add("hidden"));
      put(root, hit);
      const tickEvery = Math.max(1, Math.ceil(rows.length / 6));
      if ((rows.length - 1 - i) % tickEvery === 0) { const lab = svg("text", { x: L + (i + 0.5) * step, y: H - 8, "text-anchor": "middle", class: "axis-label" }); lab.textContent = dateFmt ? fmtDate(r.date).split(",")[0] : shortDate(r.date); put(root, lab); }
    });
    if (goal) {
      put(root, svg("line", { x1: L, x2: W - R, y1: y(goal), y2: y(goal), class: "goal-line" }));
      const g = svg("text", { x: W - R, y: y(goal) - 5, "text-anchor": "end", class: "goal-text" }); g.textContent = `goal ${goal}/day`; put(root, g);
    }
    put(box, root, tip);
    return box;
  }
  function donut(title, sub, items, centerLabel) {
    const box = el("div", { class: "chart donut-card" }, el("h3", {}, title), el("div", { class: "sub" }, sub));
    const total = items.reduce((n, i) => n + i.value, 0);
    const R = 78, r = 54, C = 100;
    const root = svg("svg", { viewBox: "0 0 200 200", role: "img", "aria-label": `${title}: ${items.map((i) => `${i.label} ${i.value}`).join(", ")}` });
    if (!total) put(root, svg("circle", { cx: C, cy: C, r: (R + r) / 2, fill: "none", stroke: cssVar("--grid"), "stroke-width": R - r }));
    else {
      let a0 = -Math.PI / 2;
      const shown = items.filter((i) => i.value > 0);
      for (const it of shown) {
        const frac = it.value / total, a1 = a0 + frac * 2 * Math.PI, large = a1 - a0 > Math.PI ? 1 : 0;
        const p = (rad, ang) => `${C + rad * Math.cos(ang)},${C + rad * Math.sin(ang)}`;
        const d = shown.length === 1
          ? `M${C - R},${C} a${R},${R} 0 1,0 ${2 * R},0 a${R},${R} 0 1,0 ${-2 * R},0 M${C - r},${C} a${r},${r} 0 1,1 ${2 * r},0 a${r},${r} 0 1,1 ${-2 * r},0`
          : `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z`;
        put(root, svg("path", { d, fill: cssVar(it.color), stroke: cssVar("--surface"), "stroke-width": 2, "fill-rule": "evenodd", class: "slice", tabindex: "0", "aria-label": `${it.label}: ${it.value}` }));
        a0 = a1;
      }
    }
    const big = svg("text", { x: C, y: C + 4, "text-anchor": "middle", class: "donut-total" }); big.textContent = fmtInt(total);
    const small = svg("text", { x: C, y: C + 22, "text-anchor": "middle", class: "donut-label" }); small.textContent = centerLabel;
    put(root, big, small);
    const legend = el("ul", { class: "donut-legend" }, items.map((it) => {
      const key = el("i"); key.style.background = cssVar(it.color);
      return el("li", {}, key, el("span", { class: "lbl" }, it.label), el("strong", {}, fmtInt(it.value)), el("span", { class: "pct" }, total ? `${Math.round((100 * it.value) / total)}%` : "–"));
    }));
    put(box, el("div", { class: "donut-wrap" }, el("div", { class: "donut-svg" }, root), legend));
    return box;
  }
  function hbars(title, sub, items, fmt, empty = "Not enough data yet.") {
    const box = el("div", { class: "chart" }, el("h3", {}, title), el("div", { class: "sub" }, sub));
    if (!items.length) { put(box, el("div", { class: "empty" }, empty)); return box; }
    const max = Math.max(...items.map((i) => i.value), 1);
    for (const it of items) {
      const fill = el("div", { class: "fill" }); fill.style.width = `${(100 * it.value) / max}%`;
      put(box, el("div", { class: "hbar", title: `${it.label}: ${fmt(it)}` }, el("span", {}, it.label), el("div", { class: "track" }, fill), el("span", { class: "v" }, fmt(it))));
    }
    return box;
  }
  function tableCard(title, sub, head, rows, empty) {
    const box = el("div", { class: "chart" }, el("h3", {}, title), el("div", { class: "sub" }, sub));
    if (!rows.length) { put(box, el("div", { class: "empty" }, empty || "Not enough data yet.")); return box; }
    put(box, el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i ? "num" : "", scope: "col" }, h)))),
      el("tbody", {}, rows.map((r) => el("tr", { onclick: r.onclick }, r.cells.map((c, i) => el("td", { class: i ? "num" : "" }, c))))))));
    return box;
  }
  function renderInsights(root) {
    const an = S.data.analytics || {}, w = an.week || {};
    const since = Date.now() - S.range * DAY;
    const f = funnel(since);
    const days = appliedDays();
    const dayRows = [];
    for (let i = S.range - 1; i >= 0; i--) { const d = new Date(Date.now() - i * DAY); dayRows.push({ date: localDay(d), applied: days.get(localDay(d)) || 0 }); }
    const daily = (an.daily || []).slice(-S.range);
    // Response by source and calibration (does a high fit score get replies?), from your own outcomes.
    const bySource = {}, byScore = {};
    for (const j of f.list) {
      const s = (bySource[j.source] = bySource[j.source] || { applied: 0, replied: 0 });
      s.applied += 1; if (RESPONDED.has(statusOf(j))) s.replied += 1;
      const bucket = j.score == null ? "unscored" : j.score >= 8 ? "8+" : j.score >= 7 ? "7–8" : j.score >= 6 ? "6–7" : "<6";
      const b = (byScore[bucket] = byScore[bucket] || { applied: 0, replied: 0, interviews: 0 });
      b.applied += 1; if (RESPONDED.has(statusOf(j))) b.replied += 1; if (["interview", "final", "offer"].includes(statusOf(j))) b.interviews += 1;
    }
    // Days from applying to the first reply.
    const waits = f.list.map((j) => {
      const a = parse(appliedStamp(j)), r = (j.history || []).find((h) => RESPONDED.has(h.status) && parse(h.at) > a);
      return r ? (parse(r.at) - a) / DAY : null;
    }).filter((x) => x != null).sort((a, b) => a - b);
    const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const j of S.jobs) counts[statusOf(j)] += 1;
    const mq = an.match_quality || {}, reg = an.regions || {};
    const range = el("div", { class: "seg-group", role: "group", "aria-label": "Time range" }, [7, 30, 90].map((d) =>
      el("button", { type: "button", class: "seg", "aria-pressed": String(S.range === d), onclick: () => { S.range = d; render(); } }, `${d} days`)));
    put(root, pageHead("Insights", "Everything counts marks still syncing, so all numbers agree.", range),
      el("div", { class: "tiles" },
        tile("Applications", fmtInt(f.applied), `last ${S.range} days`, null, { count: f.applied, cls: "accent" }),
        tile("Response rate", pct(f.responded, f.applied), `${f.responded} replied (${f.rejected} rejections)`),
        tile("Interview rate", pct(f.interviews, f.applied), `${f.interviews} interviews`),
        tile("Median reply time", median == null ? "–" : `${median.toFixed(1)} d`, "from applying to the first reply"),
        tile("Offers", fmtInt(f.offers), ""),
        tile("New matches this week", fmtInt(w.new), w.prev_new ? `${w.new - w.prev_new >= 0 ? "+" : ""}${fmtInt(w.new - w.prev_new)} vs last week` : "first week of data", null, { count: w.new })),
      el("div", { class: "donuts" },
        donut("Your pipeline", "Every job past New", ["applied", "shortlisted", "assessment", "interview", "final", "offer", "rejected", "ghosted"]
          .map((s) => ({ label: LABEL[s], value: counts[s], color: STAGE_VAR[s] })), "applications"),
        donut("Where this week's jobs are", "New matches, last 7 days", [{ label: "India", value: reg.india || 0, color: "--s1" },
          { label: "Remote", value: reg.remote || 0, color: "--s2" }, { label: "Abroad", value: reg.abroad || 0, color: "--s3" }], "new jobs"),
        donut("Match quality", "Open jobs by resume fit", [{ label: "Strong (8+)", value: mq.strong || 0, color: "--q-strong" },
          { label: "Good (6–8)", value: mq.good || 0, color: "--q-good" }, { label: "Weak (<6)", value: mq.weak || 0, color: "--q-weak" }], "open jobs")),
      el("div", { class: "charts" },
        barChart({ title: "Your applications per day", sub: `Last ${S.range} days, against your daily goal`, rows: dayRows,
          series: [{ key: "applied", label: "Applications", color: "--s1" }], goal: Math.max(1, Number(S.local.goal) || 5) }),
        barChart({ title: "New matching jobs per day", sub: `Last ${Math.min(S.range, daily.length)} days, by region`, rows: daily,
          series: [{ key: "india", label: "India", color: "--s1" }, { key: "remote", label: "Remote", color: "--s2" }, { key: "abroad", label: "Abroad", color: "--s3" }] }),
        hbars("Funnel", `Applications in the last ${S.range} days and how far they got`, [
          { label: "Applied", value: f.applied }, { label: "Screening", value: f.screening }, { label: "Assessment", value: f.assessment },
          { label: "Interview", value: f.interviews }, { label: "Final round", value: f.final }, { label: "Offer", value: f.offers }], (i) => fmtInt(i.value)),
        tableCard("Does a high fit score get replies?", "Your outcomes by AI fit score: if high scores don't reply more, trust the score less",
          ["Fit score", "Applied", "Replied", "Interviews"], ["8+", "7–8", "6–7", "<6", "unscored"].filter((k) => byScore[k])
            .map((k) => ({ cells: [k, fmtInt(byScore[k].applied), pct(byScore[k].replied, byScore[k].applied), fmtInt(byScore[k].interviews)] })),
          "Apply to a few jobs and outcomes will show here."),
        tableCard("Reply rate by source", "Where your applications get answered", ["Source", "Applied", "Replied"],
          Object.entries(bySource).sort((a, b) => b[1].applied - a[1].applied).slice(0, 10)
            .map(([k, v]) => ({ cells: [k, fmtInt(v.applied), pct(v.replied, v.applied)] }))),
        hbars("Skill gaps in jobs you fit", "Share of this week's 6+ fit jobs asking for a skill your resume doesn't show",
          (an.skill_gap || []).map((s) => ({ label: s.skill, value: s.pct })), (i) => `${i.value}%`),
        hbars("Your strongest selling points", "Share of this week's 6+ fit jobs that ask for skills you have",
          (an.strengths || []).map((s) => ({ label: s.skill, value: s.pct })), (i) => `${i.value}%`),
        tableCard("Hiring momentum", "Companies opening the most matching roles this week", ["Company", "This week", "Last week"],
          (an.momentum || []).map((r) => ({ cells: [r.company, fmtInt(r.this_week), fmtInt(r.last_week)],
            onclick: () => { S.filters = { ...S.filters, q: r.company, status: "" }; go("jobs"); } }))),
        runsChart(S.data.runs || []),
        hbars("Where this week's jobs came from", "Matching jobs by source", Object.entries(an.sources || {}).map(([k, v]) => ({ label: k, value: v })), (i) => fmtInt(i.value))));
  }
  function runsChart(runs) {
    const rows = runs.map((r) => ({ date: r.at, added: r.added || 0 }));
    const box = barChart({ title: "Jobs added per scan", sub: "Every scan over the last week. Jobs already on your list are never added twice.", rows,
      series: [{ key: "added", label: "New jobs added", color: "--s1" }], dateFmt: (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" }) });
    if (!runs.length) put(box, el("div", { class: "empty" }, "Run history starts with the next scan."));
    return box;
  }

  // ------------------------------------------------------------------ Learn (sections of recent videos)
  const SECTIONS = ["System Design", "DevOps", "DevSecOps", "Architecture", "AWS", "Azure", "Kubernetes", "Observability & SRE", "AI & MLOps", "Career"];
  // Topic names used before the fixed sections existed: still shown until the next refresh replaces them.
  const OLD_TOPICS = { "Kubernetes & cloud native": "Kubernetes", "IaC & CI/CD": "DevOps", Cloud: "DevOps", "AI & LLMs": "AI & MLOps",
    Security: "DevSecOps", "System design & Linux": "System Design", "Career & interviews": "Career" };
  function renderLearn(root) {
    const vids = (S.data.videos || []).map((v) => (SECTIONS.includes(v.topic) ? v : { ...v, topic: OLD_TOPICS[v.topic] || "DevOps" }));
    const have = SECTIONS.filter((s) => vids.some((v) => v.topic === s));
    if (S.learnTopic !== "all" && !have.includes(S.learnTopic)) S.learnTopic = "all";
    const gaps = (S.data.analytics?.skill_gap || []).slice(0, 5).map((g) => g.skill);
    const views = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n || 0));
    const seg = (key, text) => el("button", { type: "button", class: "seg", "aria-pressed": String(S.learnTopic === key), onclick: () => { S.learnTopic = key; render(); } }, text);
    const card = (v) => el("a", { class: "video", href: `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`, target: "_blank", rel: "noopener noreferrer" },
      el("div", { class: "thumb" }, el("img", { src: `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`, alt: "", loading: "lazy", width: "320", height: "180" }),
        v.gap ? el("span", { class: "gap-badge" }, `fills gap: ${v.gap}`) : null),
      el("div", { class: "v-body" }, el("div", { class: "v-title" }, v.title),
        el("div", { class: "v-meta" }, el("span", {}, v.channel), el("span", {}, `${views(v.views)} views`), el("span", {}, agoLabel(v.published)))));
    const sectionsShown = S.learnTopic === "all" ? have : [S.learnTopic];
    put(root, pageHead("Learn", `What's new in your field, by topic · updated ${agoLabel(S.data.videos_at) || "–"}`),
      gaps.length ? el("div", { class: "chips gaps" }, el("span", { class: "sub" }, "Your skill gaps this week:"), gaps.map((g) => el("span", { class: "chip miss" }, g))) : null,
      el("div", { class: "seg-group wrap", role: "group", "aria-label": "Topic" }, seg("all", "All topics"), have.map((s) => seg(s, s))),
      vids.length ? sectionsShown.map((s) => el("section", { class: "section" }, el("div", { class: "section-head" }, el("h2", {}, s)),
        el("div", { class: "videos" }, vids.filter((v) => v.topic === s).map(card))))
        : el("div", { class: "empty" }, "Videos appear after the next scan (refreshed about twice a day)."));
  }

  // ------------------------------------------------------------------ Companies + Universities & Research (directory)
  const ACADEMIC = /universit|institute of|\biit\b|\biisc\b|\bnit\b|iiit|college|research (institute|centre|center|council|organi[sz]ation|foundation|establishment|laborator)|laborator|\bcern\b|c-dac|\bcdac\b|isro|drdo|\bnic\b|\btifr\b|\bbarc\b|max planck|fraunhofer|national lab|\bembl\b|european space|\besa\b|eumetsat|ecmwf|\bdesy\b|helmholtz|inria|\bcnrs\b|supercomput|sanger|crick|weizmann|\bepfl\b|eth z|forschungs|akademie|hochschule|\btu\b|polytechn/i;
  const COMPANY_SUFFIX = /\b(private limited|pvt|ltd|limited|inc|llc|gmbh|corp|technologies|solutions|services)\b/i; // a company, not an institution
  const normCo = (s) => String(s || "").toLowerCase().replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|gmbh|group|plc|s\.?a\.?|ag|technologies|technology|india|co)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const initialOf = (n) => { const c = String(n || "").normalize("NFD").charAt(0).toUpperCase(); return c >= "A" && c <= "Z" ? c : "#"; };
  const flagOf = (iso2) => (iso2 && /^[A-Z]{2}$/.test(iso2) ? String.fromCodePoint(...[...iso2].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "");
  const people = (n) => (!n ? "" : n >= 100000 ? `${Math.round(n / 1000)}k+ people` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k people` : `${n} people`);
  function logoNode(item) {
    const fallback = () => el("span", { class: "co-logo ph", "aria-hidden": "true" }, initials(item.n));
    if (!item.lg) return fallback();
    const img = el("img", { class: "co-logo", src: item.lg, alt: "", loading: "lazy", width: "44", height: "44", referrerpolicy: "no-referrer" });
    img.addEventListener("error", () => img.replaceWith(fallback()), { once: true });
    return img;
  }
  async function loadDirectory() {
    if (!S.dir) {
      try { S.dir = await decryptBlob(await fetchBlob("data/directory.enc.json"), S.pass); } catch (_) { S.dir = { companies: [], institutions: [], categories: [] }; }
    }
    return S.dir;
  }
  function renderCompanies(root) {
    const host = el("div", {}, el("div", { class: "empty" }, "Loading the company directory…"));
    S.co = S.co || { tab: "companies", q: "", cat: "", country: "", hiring: false, yc: false, tracked: false, li: false, type: "", india: false, letter: "", limit: 60 };
    put(root, host);
    loadDirectory().then((d) => { if (S.view === "companies" && host.isConnected) host.replaceWith(companiesBody(d)); });
  }
  function companiesBody(d) {
    const st = S.co;
    // Your open matching jobs per company, to show "hiring now" and jump to them.
    const open = new Map();
    for (const j of S.jobs) if (statusOf(j) === "new" && isOpen(j)) { const k = normCo(j.company); open.set(k, (open.get(k) || 0) + 1); }
    const box = el("div", { class: "dir" });
    const redraw = () => { st.limit = Math.max(60, st.limit); box.replaceWith(companiesBody(d)); };
    const hiringInst = hiringInstitutions(d);
    const withFounders = d.companies.filter((x) => (x.f || []).length);
    const isCo = st.tab !== "institutions";
    const tabs = el("div", { class: "seg-group", role: "group", "aria-label": "Directory" },
      [["companies", `Companies (${fmtInt(d.companies.length)})`], ["founders", `Founders (${fmtInt(withFounders.length)} profiles)`],
        ["institutions", `Universities & research hiring (${fmtInt(hiringInst.length)})`]].map(([k, t]) =>
        el("button", { type: "button", class: "seg", "aria-pressed": String(st.tab === k), onclick: () => { st.tab = k; st.q = ""; st.country = ""; st.letter = ""; st.limit = 60; redraw(); } }, t)));
    const search = el("input", { type: "search", class: "search", placeholder: isCo ? "Search companies, founders, cities, what they do…" : "Search universities, institutes, cities…", value: st.q, "aria-label": "Search directory" });
    let typing = null;
    search.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { st.q = search.value; st.limit = 60; redraw(); const s = $(".dir .search"); if (s) { s.focus(); s.selectionStart = s.selectionEnd = s.value.length; } }, 180); });
    // Institutions: only the ones with live openings that match you; abroad unless "Include India" is on.
    const list = st.tab === "companies" ? d.companies : st.tab === "founders" ? d.companies : hiringInst.filter((x) => st.india || x.cc !== "IN");
    const countries = [...new Set(list.map((x) => x.cc).filter(Boolean))].sort();
    const terms = st.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = list.filter((x) => {
      if (st.country && x.cc !== st.country) return false;
      if (st.letter && initialOf(x.n) !== st.letter) return false;
      if (terms.length) { const hay = `${x.n} ${x.ct || ""} ${x.b || ""} ${(x.c || []).join(" ")} ${(x.f || []).map((f) => f[0]).join(" ")}`.toLowerCase(); if (!terms.every((t) => hay.includes(t))) return false; }
      if (st.tab === "institutions") return !st.type || x.ty === st.type;
      if (st.cat && !(x.c || []).includes(st.cat)) return false;
      if (st.hiring && !open.get(normCo(x.n)) && !x.h) return false;
      if (st.yc && !x.yc) return false;
      if (st.tracked && !x.t) return false;
      if (st.li && !x.li) return false;
      return true;
    });
    // Hiring for you first; within an industry, companies whose main industry it is before conglomerates tagged with it.
    if (isCo) rows.sort((a, b) => ((open.get(normCo(b.n)) || 0) - (open.get(normCo(a.n)) || 0))
      || (st.tab === "founders" ? !(a.f || []).length - !(b.f || []).length : 0)
      || (st.cat ? ((a.c || [])[0] !== st.cat) - ((b.c || [])[0] !== st.cat) : 0));
    const chip = (label, key, value) => el("button", { type: "button", class: `fpill toggle${st[key] === value || (value === true && st[key]) ? " on" : ""}`,
      onclick: () => { st[key] = st[key] === value ? (value === true ? false : "") : value; st.limit = 60; redraw(); } }, label);
    const catCounts = new Map();
    for (const x of d.companies) for (const c of x.c || []) catCounts.set(c, (catCounts.get(c) || 0) + 1);
    const letters = el("div", { class: "fpills letters", role: "group", "aria-label": "First letter" }, chip("All", "letter", ""),
      [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"].map((c) => chip(c, "letter", c)));
    const filters = isCo
      ? [el("div", { class: "fpills" }, chip(`All (${fmtInt(d.companies.length)})`, "cat", ""), (d.categories || []).filter((c) => catCounts.get(c)).map((c) => chip(`${c} (${fmtInt(catCounts.get(c))})`, "cat", c))),
        el("div", { class: "fpills" }, chip("Hiring now", "hiring", true), chip("YC", "yc", true), chip("Career site tracked", "tracked", true), chip("Has LinkedIn", "li", true), countrySelect(countries, st, redraw)), letters]
      : [el("div", { class: "fpills" }, chip("All", "type", ""), chip("Universities", "type", "university"), chip("Research institutes", "type", "research"), chip("Government & public", "type", "government"), chip("Include India", "india", true), countrySelect(countries, st, redraw)), letters];
    const grid = el("div", { class: "co-grid" }, rows.slice(0, st.limit).map((x) => isCo ? companyCard(x, open.get(normCo(x.n)) || 0) : institutionCard(x)));
    put(box, pageHead({ companies: "Companies", founders: "Founders" }[st.tab] || "Universities & research",
        st.tab === "companies" ? "Employers for DevOps, SRE, cloud and ML infrastructure roles, by industry. Logos and links open the company's own pages."
          : st.tab === "founders" ? "Pick a country: companies with known founder profiles (from Wikidata) come first; for the rest, one click searches LinkedIn for the founders. Links open in your own browser."
          : "Universities, research institutes and public bodies: they hire HPC, GPU cluster, research computing and DevOps engineers.", tabs),
      el("div", { class: "filterbar" }, search, filters),
      el("div", { class: "sub dir-count" }, `${fmtInt(rows.length)} shown`),
      rows.length ? grid : el("div", { class: "empty" }, st.tab === "institutions"
        ? (hiringInst.length && !st.india
          ? `No openings abroad right now; ${hiringInst.length} institution${hiringInst.length > 1 ? "s" : ""} in India ${hiringInst.length > 1 ? "are" : "is"} hiring. Turn on "Include India" to see ${hiringInst.length > 1 ? "them" : "it"}.`
          : "No university or research openings matching your profile right now. The scanner checks every 4 hours (CERN, Leiden and university postings on Indeed's country sites).")
        : st.tab === "founders" && !withFounders.length ? "Founder links appear after the next monthly directory refresh."
        : d.companies.length ? "Nothing matches these filters." : "The directory appears after the next scan."),
      rows.length > st.limit ? el("button", { class: "btn more", type: "button", onclick: () => { st.limit += 120; redraw(); } }, `Show ${fmtInt(Math.min(120, rows.length - st.limit))} more`) : null);
    return box;
  }
  function countrySelect(countries, st, redraw) {
    return el("label", { class: `fpill${st.country ? " on" : ""}` }, el("span", { class: "fl" }, "Country"),
      el("select", { "aria-label": "Country", onchange: (e) => { st.country = e.target.value; st.limit = 60; redraw(); } },
        el("option", { value: "" }, "All"), countries.map((c) => el("option", { value: c, selected: st.country === c }, `${flagOf(c)} ${c}`))));
  }
  function companyCard(x, openRoles) {
    const li = x.li || `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(x.n)}`;
    const careers = x.cr || `https://www.google.com/search?q=${encodeURIComponent(`${x.n} careers DevOps OR SRE OR cloud`)}`;
    const founders = x.f || [];
    return el("article", { class: "co-card" },
      el("div", { class: "co-head" }, logoNode(x),
        el("div", { class: "co-id" }, el("div", { class: "co-title", title: x.n }, x.n),
          el("div", { class: "co-where" }, [flagOf(x.cc), x.ct || x.cc].filter(Boolean).join(" "), x.e ? el("span", {}, people(x.e)) : null))),
      x.b ? el("p", { class: "co-blurb" }, x.b) : null,
      el("div", { class: "co-badges" },
        openRoles ? el("button", { type: "button", class: "chip have", title: "Open matching jobs from this company",
          onclick: () => { S.filters = { ...S.filters, q: x.n, status: "open" }; go("jobs"); } }, `● ${openRoles} open role${openRoles > 1 ? "s" : ""}`) : null,
        x.h && !openRoles ? el("span", { class: "chip" }, "Hiring (YC)") : null,
        x.yc ? el("span", { class: "chip yc" }, `YC ${x.yc}`) : null,
        x.t ? el("span", { class: "chip target" }, "Career site tracked") : null),
      (x.c || []).length ? el("div", { class: "co-domain" }, el("span", { class: "fl" }, "Domain"), x.c.join(" · ")) : null,
      el("div", { class: "co-founders" }, el("span", { class: "fl" }, founders.length > 1 ? "Founders" : "Founder"),
        founders.length ? founders.map(([n, url]) => extLink([icon("ext", 12), n], url, "chip founder"))
          : extLink([icon("search", 12), "Search on LinkedIn"], `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${x.n} founder`)}`, "chip founder")),
      el("div", { class: "co-links" }, x.w ? extLink([icon("globe", 14), "Website"], x.w, "btn small") : null,
        extLink([icon("ext", 14), x.li ? "LinkedIn" : "Find on LinkedIn"], li, "btn small"), extLink([icon("building", 14), "Careers"], careers, "btn small")));
  }
  // Institutions with open matching jobs, enriched with logo/website/LinkedIn from the directory when known.
  function hiringInstitutions(d) {
    const known = new Map((d.institutions || []).map((x) => [normCo(x.n), x]));
    const groups = new Map();
    for (const j of S.jobs) {
      if (!isOpen(j) || statusOf(j) !== "new" || !ACADEMIC.test(j.company) || COMPANY_SUFFIX.test(j.company)) continue;
      const k = normCo(j.company);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(j);
    }
    return [...groups.entries()].map(([k, jobs]) => {
      const x = known.get(k) || {};
      const cc = x.cc || (jobs[0].region === "india" ? "IN" : "");
      const ty = x.ty || (/universit|college|hochschule|polytechn|\biit\b|\bnit\b|iiit/i.test(jobs[0].company) ? "university" : "research");
      return { ...x, n: x.n || jobs[0].company, cc, ty, ct: x.ct || jobs[0].location, roles: jobs.sort((a, b) => (b.prio || 0) - (a.prio || 0)) };
    }).sort((a, b) => b.roles.length - a.roles.length);
  }
  function institutionCard(x) {
    const li = x.li || `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(x.n)}`;
    const domain = (() => { try { return new URL(x.w).hostname.replace(/^www\./, ""); } catch (_) { return ""; } })();
    const jobs = `https://www.google.com/search?q=${encodeURIComponent(`${domain ? `site:${domain} ` : `${x.n} `}(HPC OR "research computing" OR "system administrator" OR DevOps OR "GPU cluster") jobs`)}`;
    return el("article", { class: "co-card" },
      el("div", { class: "co-head" }, logoNode(x),
        el("div", { class: "co-id" }, el("div", { class: "co-title", title: x.n }, x.n),
          el("div", { class: "co-where" }, [flagOf(x.cc), x.ct || x.cc].filter(Boolean).join(" "), x.s ? el("span", {}, `${fmtInt(x.s)} students`) : null))),
      el("div", { class: "co-badges" }, el("span", { class: "chip have" }, `● ${x.roles.length} open role${x.roles.length > 1 ? "s" : ""}`),
        el("span", { class: "chip target" }, { university: "University", research: "Research institute", government: "Government / public" }[x.ty] || "Institution")),
      el("div", { class: "co-roles" }, x.roles.slice(0, 4).map((j) => el("button", { type: "button", class: "btn small ghost", onclick: () => openDrawer(j) },
        `${j.title}${j.score != null ? ` · fit ${Number(j.score).toFixed(1)}` : ""}`))),
      el("div", { class: "co-links" }, x.w ? extLink([icon("globe", 14), "Website"], x.w, "btn small") : null,
        extLink([icon("ext", 14), x.li ? "LinkedIn" : "Find on LinkedIn"], li, "btn small"), extLink([icon("search", 14), "HPC & IT jobs"], jobs, "btn small")));
  }

  // ------------------------------------------------------------------ Map (globe, loaded only when opened)
  const BUILD = document.querySelector('meta[name="jr-build"]')?.content || "";
  function loadScript(src) {
    if (BUILD) src = `${src}?v=${BUILD}`; // same build as this page: never a stale cached copy
    return new Promise((ok, fail) => { if (document.querySelector(`script[src="${src}"]`)) return ok(); const s = el("script", { src }); s.onload = ok; s.onerror = () => fail(new Error(`could not load ${src}`)); document.head.append(s); });
  }
  async function renderMap(root) {
    const host = el("div", { class: "map-host" }, el("div", { class: "empty" }, "Loading the globe…"));
    put(root, pageHead("Map", "Companies for your roles, country by country. Drag to rotate, scroll to zoom, click a country."), host);
    try {
      for (const s of ["vendor/d3-array.min.js", "vendor/d3-geo.min.js", "vendor/topojson-client.min.js", "map.js"]) await loadScript(s);
      let world = S.world;
      if (!world) {
        try { world = S.world = await decryptBlob(await fetchBlob("data/world.enc.json"), S.pass); } catch (_) { world = S.world = { countries: {} }; }
      }
      if (S.view !== "map" || !host.isConnected) return;
      window.JRMap.mount(host, { world, jobs: S.jobs.filter((j) => isOpen(j) || APPLIED.has(statusOf(j))), statusOf, openJob: openDrawer, el, icon, extLink, agoLabel, fmtInt });
    } catch (e) { host.replaceChildren(el("div", { class: "empty" }, `Map unavailable: ${e.message}`)); }
  }

  // ------------------------------------------------------------------ Settings
  function renderSettings(root) {
    const gm = S.data.gmail || {};
    const imp = S.data.resume_import;
    const goal = el("input", { type: "number", min: "1", max: "50", value: String(S.local.goal || 5), "aria-label": "Daily application goal" });
    const repo = el("input", { type: "text", value: S.local.repo || "", placeholder: "owner/job-radar", "aria-label": "Private repository" });
    const token = el("input", { type: "password", value: S.local.token ? "••••••••" : "", placeholder: "github_pat_…", autocomplete: "off", "aria-label": "GitHub token" });
    const status = el("p", { role: "status", class: "sub" }, S.local.lastSync ? `Last sync ${agoLabel(S.local.lastSync)}.` : "Not synced yet.");
    const saveSettings = async () => {
      S.local.goal = Math.max(1, Math.min(50, Number(goal.value) || 5));
      S.local.repo = repo.value.trim();
      if (token.value && !token.value.startsWith("•")) S.local.token = token.value.trim();
      S.local.lastSyncError = "";
      await saveLocal(); toast("Saved (encrypted on this device)");
      readInbox(); render();
    };
    const test = async () => {
      status.textContent = "Testing…";
      try {
        const files = await gh("contents/README.md");
        const flow = await gh("actions/workflows/update-status.yml");
        if (files.ok) { S.local.mode = "files"; status.textContent = "Works: free sync (0 Actions minutes). Marks are saved within ~20 seconds; other devices see them after Refresh."; }
        else if (flow.ok) { S.local.mode = "actions"; status.textContent = "Works, using Actions: about 1-2 minutes per sync, batched to at most one run every 5 minutes. To make it free, add one permission to this token (see below)."; }
        else status.textContent = `GitHub said ${flow.status}. Check the repository name (${S.local.repo}) and that the token is for that repo.`;
        await saveLocal(); renderSyncPill();
      } catch (_) { status.textContent = "Network error."; }
    };
    const upStatus = el("div", { class: "sub", role: "status" });
    const upload = el("input", { type: "file", accept: "application/pdf,.pdf", "aria-label": "Upload resume PDF", onchange: (e) => handleUpload(e.target.files[0], upStatus) });
    const box = (title, ...kids) => el("div", { class: "box" }, el("h3", {}, title), ...kids);
    const scriptUrl = new URL("autofill.user.js", location.href).href;
    const exportMine = () => {
      const rows = S.jobs.filter((j) => statusOf(j) !== "new").map((j) => ({ title: j.title, company: j.company, status: statusOf(j), url: j.url }));
      const a = el("a", { download: "job-radar-statuses.json" }); a.href = URL.createObjectURL(new Blob([JSON.stringify(rows, null, 1)], { type: "application/json" })); a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    put(root, pageHead("Settings", "Everything here is stored encrypted in this browser."), el("div", { class: "settings" },
      box("Sync across devices",
        el("p", {}, `Your marks (Applied, stages, notes) are sent to your private job-radar repo so every browser and phone shows the same thing. Current mode: ${S.local.mode === "files" ? "free (0 Actions minutes)" : S.local.mode === "actions" ? "via Actions (batched, ~1-2 minutes per sync)" : "detected on the first sync"}.`),
        el("p", {}, "Make it free (1 minute, same token): GitHub → your photo → Settings → Developer settings → Personal access tokens → Fine-grained tokens → click your job-radar token → Edit → Repository permissions → Contents: Read and write → Update. Then press Test here."),
        el("label", {}, "Repository", repo), el("label", {}, "Token", token),
        el("div", { class: "row" }, el("button", { class: "btn primary", type: "button", onclick: saveSettings }, "Save"),
          el("button", { class: "btn", type: "button", onclick: test, disabled: !S.local.token }, "Test"),
          el("button", { class: "btn", type: "button", onclick: () => sync(), disabled: !S.local.token }, `Sync now (${pendingChanges().length})`),
          S.local.token ? el("button", { class: "btn ghost", type: "button", onclick: async () => { S.local.token = ""; await saveLocal(); render(); } }, "Remove token") : null),
        status),
      box("Your resume",
        el("p", {}, "Upload any resume PDF: the text is read in this browser, saved to your private repo, and the next scan re-centres everything on it (scoring, tailored PDFs, referral messages, cover letters). The AI only structures it: every bullet must appear word for word in your PDF, or it's dropped."),
        imp ? el("p", { class: imp.status === "applied" ? "ok-text" : "warn-text" }, `Last upload (${imp.file || "resume"}, ${agoLabel(imp.at)}): ${imp.status}${imp.kept != null ? ` · kept ${imp.kept}, dropped ${imp.dropped}` : ""}`) : null,
        el("div", { class: "row" }, el("label", { class: "btn" }, icon("down", 14), "Upload resume PDF", upload),
          el("button", { class: "btn", type: "button", onclick: () => printDoc(null) }, "Download standard resume (PDF)")), upStatus),
      box("Gmail status sync (read-only)",
        el("p", {}, gm.last_sync ? `Last checked ${agoLabel(gm.last_sync)}: ${gm.stats?.hiring ?? 0} hiring emails, ${gm.stats?.updated ?? 0} jobs updated, ${gm.stats?.review ?? 0} waiting for you.` : "Not connected yet. See README, \"Gmail status sync\"."),
        el("p", {}, "Only jobs you already applied to can change. The AI must be at least 90% sure to change a status on its own; 60–90% waits for you on Today. The token is read-only: it cannot delete, move, label or send anything.")),
      box("Autofill for Greenhouse, Lever and Ashby",
        el("p", {}, "Install Tampermonkey, open the link below and click Install. On an application form click \"⚡ Fill my details\". It never submits, never uploads, never runs on LinkedIn or job boards."),
        el("div", { class: "row" }, extLink("Install autofill script ↗", scriptUrl, "btn primary"))),
      box("Theme", el("div", { class: "theme-grid" }, Object.entries(THEMES).map(([k, label]) =>
        el("button", { type: "button", class: "theme-card", "aria-pressed": String(currentTheme() === k), onclick: () => setTheme(k) },
          el("span", { class: `swatch ${k}` }), label)))),
      box("Daily goal", el("p", {}, "Applications per day for the Today progress bar, streak and charts."), goal,
        el("div", { class: "row" }, el("button", { class: "btn primary", type: "button", onclick: saveSettings }, "Save"))),
      box("Privacy",
        el("p", {}, "Your passphrase never leaves this browser and is forgotten when you lock, close the tab, or after 15 minutes idle. The published data is AES-256 encrypted; only someone with the passphrase can read it. The token is stored here encrypted with your passphrase."),
        el("div", { class: "row" }, el("button", { class: "btn", type: "button", onclick: exportMine }, "Export my statuses"),
          el("button", { class: "btn ghost", type: "button", onclick: () => { if (confirm("Delete saved settings, token and unsynced marks from this device?")) { try { localStorage.removeItem(LS.local); localStorage.removeItem(LS.salt); } catch (_) { /* fine */ } lock(); } } }, "Clear this device")))));
  }
  // PDF -> text in this browser (pdf.js, loaded on demand), then saved to the repo inbox for the next scan.
  async function handleUpload(file, out) {
    if (!file) return;
    if (file.size > 8e6) { out.textContent = "That file is over 8 MB."; return; }
    out.textContent = "Reading your PDF…";
    try {
      const pdfjs = await import("./vendor/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.mjs";
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
      const lines = [], links = [];
      for (let p = 1; p <= Math.min(doc.numPages, 4); p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        lines.push(content.items.map((i) => i.str + (i.hasEOL ? "\n" : "")).join(""));
        for (const a of await page.getAnnotations()) if (a.url) links.push(a.url);
      }
      const text = `${lines.join("\n")}\n\nLINKS:\n${[...new Set(links)].join("\n")}`.trim();
      if (text.length < 400) { out.textContent = "Couldn't read enough text (is it a scanned image?). Use a text-based PDF."; return; }
      const words = text.split(/\s+/).length;
      out.replaceChildren(el("p", {}, `Read ${fmtInt(words)} words from ${doc.numPages} page${doc.numPages > 1 ? "s" : ""}. Preview:`),
        el("pre", { class: "preview" }, text.slice(0, 1200) + (text.length > 1200 ? "\n…" : "")),
        el("div", { class: "row" }, el("button", { class: "btn primary", type: "button", onclick: async (e) => {
          e.target.disabled = true;
          try { await pushInbox("resume", { name: file.name.slice(0, 80), text: text.slice(0, 60000) }); out.textContent = "Saved. The next scan applies it (check here after it runs)."; }
          catch (err) { out.textContent = err.message; e.target.disabled = false; }
        } }, "Use this resume")));
    } catch (e) { out.textContent = `Couldn't read that PDF: ${e.message}`; }
  }

  // ------------------------------------------------------------------ command palette + keyboard
  function openPalette() {
    if (!S.data) return;
    const rootEl = $("#modal-root");
    const input = el("input", { type: "search", class: "palette-input", placeholder: "Search jobs, companies, or type a command…", "aria-label": "Search" });
    const list = el("ul", { class: "palette-list", role: "listbox" });
    const cmds = [...VIEWS.map((v) => ({ label: `Go to ${v[0].toUpperCase()}${v.slice(1)}`, run: () => go(v), kind: "nav" })),
      { label: "Refresh data", run: refresh, kind: "cmd" },
      ...Object.entries(THEMES).map(([k, label]) => ({ label: `Theme: ${label}`, run: () => setTheme(k), kind: "cmd" })),
      { label: "Lock", run: lock, kind: "cmd" }, { label: "Download standard resume (PDF)", run: () => printDoc(null), kind: "cmd" },
      { label: "Keyboard shortcuts", run: showHelp, kind: "cmd" }];
    let idx = 0, items = [];
    const close = () => rootEl.replaceChildren();
    const draw = () => {
      const q = input.value.trim().toLowerCase(), terms = q.split(/\s+/).filter(Boolean);
      const match = (s) => terms.every((t) => s.toLowerCase().includes(t));
      const jobs = q ? S.jobs.filter((j) => match(`${j.title} ${j.company} ${j.location}`)).sort((a, b) => (b.prio || 0) - (a.prio || 0)).slice(0, 8) : [];
      items = [...cmds.filter((c) => !q || match(c.label)).slice(0, q ? 4 : 8), ...jobs.map((j) => ({ label: j.title, sub: `${j.company} · ${LABEL[statusOf(j)]}`, run: () => openDrawer(j), kind: "job" }))];
      idx = Math.min(idx, Math.max(0, items.length - 1));
      list.replaceChildren(...items.map((it, i) => el("li", { role: "option", class: i === idx ? "on" : "", "aria-selected": String(i === idx), onclick: () => { close(); it.run(); } },
        el("span", { class: `pk ${it.kind}` }, it.kind === "job" ? "Job" : it.kind === "nav" ? "Go" : "Cmd"), el("span", {}, it.label), it.sub ? el("span", { class: "sub" }, it.sub) : null)));
      if (!items.length) list.append(el("li", { class: "sub" }, "No matches"));
    };
    input.addEventListener("input", () => { idx = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { idx = Math.min(items.length - 1, idx + 1); draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { idx = Math.max(0, idx - 1); draw(); e.preventDefault(); }
      else if (e.key === "Enter" && items[idx]) { close(); items[idx].run(); }
      else if (e.key === "Escape") close();
    });
    rootEl.replaceChildren(el("div", { class: "backdrop", onclick: close }),
      el("div", { class: "palette", role: "dialog", "aria-modal": "true", "aria-label": "Search" }, input, list, el("div", { class: "palette-foot" }, "↑↓ to move · Enter to open · Esc to close")));
    draw();
    input.focus();
  }
  function showHelp() {
    const rootEl = $("#modal-root");
    const close = () => rootEl.replaceChildren();
    const rows = [["Ctrl K or /", "Search jobs and commands"], ["g then t / j / p / m / l / i / s", "Go to Today, Jobs, Pipeline, Map, Learn, Insights, Settings"],
      ["j / k", "Next / previous job (Jobs)"], ["a", "Mark selected job applied"], ["x", "Hide selected job"], ["o", "Open the posting"],
      ["Space", "Select for bulk actions"], ["?", "This help"], ["Esc", "Close dialogs"]];
    rootEl.replaceChildren(el("div", { class: "backdrop", onclick: close }), el("div", { class: "palette help", role: "dialog", "aria-modal": "true", "aria-label": "Keyboard shortcuts" },
      el("h2", {}, "Keyboard shortcuts"), el("table", {}, el("tbody", {}, rows.map(([k, v]) => el("tr", {}, el("td", {}, el("kbd", {}, k)), el("td", {}, v))))),
      el("div", { class: "row" }, el("button", { class: "btn", type: "button", onclick: close }, "Close"))));
  }
  let gPrefix = 0;
  document.addEventListener("keydown", (e) => {
    if (!S.data) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || $("#modal-root").children.length) return;
    if (e.key === "/") { e.preventDefault(); openPalette(); return; }
    if (e.key === "?") { showHelp(); return; }
    if (e.key === "Escape") { $("#drawer-root").replaceChildren(); return; }
    if (e.key === "g") { gPrefix = Date.now(); return; }
    if (Date.now() - gPrefix < 900) {
      const to = { t: "today", j: "jobs", p: "board", c: "companies", m: "map", l: "learn", i: "insights", s: "settings" }[e.key];
      gPrefix = 0;
      if (to) { go(to); return; }
    }
    if (S.view !== "jobs") return;
    // Enter/Space on a focused button or link must still activate that control, not the shortcut.
    if ((e.key === "Enter" || e.key === " ") && document.activeElement?.closest("button, a, label")) return;
    const rows = filtered().slice(0, S.listLimit), i = rows.findIndex((j) => j.id === S.selectedId), cur = rows[i];
    if (e.key === "j" || e.key === "ArrowDown") { if (rows[i + 1]) selectJob(rows[i + 1].id); e.preventDefault(); }
    else if (e.key === "k" || e.key === "ArrowUp") { if (rows[i - 1]) selectJob(rows[i - 1].id); e.preventDefault(); }
    else if (cur && e.key === "a") setStatus(cur, "applied");
    else if (cur && e.key === "x") setStatus(cur, "ignored");
    else if (cur && e.key === "o") window.open(safeUrl(cur.url), "_blank", "noopener,noreferrer");
    else if (cur && e.key === "Enter") { e.preventDefault(); openDrawer(cur); } // else the press would also "click" the drawer's Close button
    else if (cur && e.key === " ") { e.preventDefault(); toggleBulk(cur.id); }
  });

  // ------------------------------------------------------------------ service worker (offline shell)
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
