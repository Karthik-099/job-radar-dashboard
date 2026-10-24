// Job Radar dashboard. Plain JS, no dependencies. All job text is untrusted: it is only ever set via
// textContent, and links are allowed only for http(s) URLs.
"use strict";
(() => {
  const { deriveKey, decryptBlob, encryptWithKey, decryptWithKey } = window.JRCrypto;

  // ------------------------------------------------------------------ constants and state
  // Your pipeline, in order. "Shortlisted" = the company shortlisted you after you applied.
  const STATUSES = ["new", "applied", "shortlisted", "interview", "offer", "rejected", "ignored"];
  const LABEL = { new: "New", applied: "Applied", shortlisted: "Shortlisted", interview: "Interview",
    offer: "Offer", rejected: "Rejected", ignored: "Hidden" };
  // "You already applied" (any outcome): such a role is never shown again as a new job, under any city or board.
  const APPLIED = new Set(["applied", "shortlisted", "interview", "offer", "rejected"]);
  const STAGE_VAR = { new: "--st-new", applied: "--st-applied", shortlisted: "--st-shortlisted", interview: "--st-interview",
    offer: "--st-offer", rejected: "--st-rejected", ignored: "--st-new" };
  const REGION = { india: "India", remote: "Remote", abroad: "Abroad", unknown: "Unclear" };
  const LOCK_AFTER_MS = 15 * 60 * 1000;
  const SYNC_DEBOUNCE_MS = 60 * 1000;
  const RESEND_MS = 10 * 60 * 1000; // a change GitHub hasn't applied yet is sent again after this
  const LS = { local: "jr.local.v1", salt: "jr.salt.v1", theme: "jr.theme" };
  const DAY = 86400000;

  const S = {
    pass: null, localKey: null, data: null, jobs: [], byId: new Map(),
    local: { overrides: {}, token: "", repo: "", goal: 5, lastSync: null, lastSyncError: "" },
    view: "today", tableLimit: 100, sort: { key: "prio", dir: -1 }, showIgnored: false,
    filters: { q: "", status: "open", region: "", posted: "", minScore: "", source: "", hideClosed: true, target: false },
    lastActive: Date.now(), syncTimer: null, failed: 0, appliedRk: new Set(),
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
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      if (typeof kid === "string" && /^(null|undefined|none|nan)+$/i.test(kid.trim())) continue; // never show "nullnull"
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
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
    toast.timer = setTimeout(() => t.classList.add("hidden"), 2600);
  }
  const fmtInt = (n) => new Intl.NumberFormat().format(n || 0);
  const localDay = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };

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
    const d = Math.floor((t - Date.now()) / DAY); // same rounding as the backend reasons
    if (d < 0) return "closed";
    return d === 0 ? "closes today" : `closes in ${d}d`;
  }
  const postedAt = (j) => parse(j.posted) ?? parse(j.seen) ?? 0;

  // ------------------------------------------------------------------ status model (server + local overrides)
  function lastServerChange(job) {
    const h = (job.history || []).filter((x) => x.status);
    return h.length ? h[h.length - 1].at : "";
  }
  function statusOf(job) {
    const o = S.local.overrides[job.id];
    if (o && o.at > lastServerChange(job)) return o.status;
    return job.status;
  }
  function setStatus(job, status, note) {
    const prev = S.local.overrides[job.id];
    S.local.overrides[job.id] = { status, at: new Date().toISOString(), note: note ?? prev?.note ?? "", sent: false };
    saveLocal();
    scheduleSync();
    render();
    toast(`${LABEL[status]}: ${job.title}`);
  }
  // A local change stays here until the published data shows it (or something newer), then it is dropped.
  function pruneSyncedOverrides() {
    for (const [id, o] of Object.entries(S.local.overrides)) {
      const job = S.byId.get(id);
      if (!job) { if (Date.now() - (parse(o.at) || 0) > 3 * DAY) delete S.local.overrides[id]; continue; }
      const stamp = o.at.slice(0, 19);
      const h = job.history || [];
      const applied = h.some((x) => x.status === o.status && x.at.slice(0, 19) >= stamp);
      const newer = lastServerChange(job).slice(0, 19) > stamp;
      // Already in that state on the server (e.g. you changed it and back before it synced): nothing left to send.
      const lastNote = (h.filter((x) => x.note).slice(-1)[0] || {}).note || "";
      const same = job.status === o.status && (o.note || "") === lastNote;
      if (applied || newer || same) delete S.local.overrides[id];
    }
  }
  const unconfirmed = () => Object.entries(S.local.overrides);
  // Due to send: never sent, or sent a while ago and still not in the published data (the run was dropped).
  const pendingChanges = () => unconfirmed().filter(([, o]) => !o.sent || Date.now() - (o.sentAt || 0) > RESEND_MS);

  // Applications per local day: server history plus unsynced local changes.
  function appliedDays() {
    const days = new Map();
    for (const job of S.jobs) {
      const o = S.local.overrides[job.id];
      const stamps = (job.history || []).filter((h) => h.status === "applied").map((h) => h.at);
      if (o && o.status === "applied" && o.at > lastServerChange(job)) stamps.push(o.at);
      if (stamps.length) {
        const first = stamps.sort()[0];
        const key = localDay(first);
        days.set(key, (days.get(key) || 0) + 1);
      }
    }
    return days;
  }
  // Funnel from what this browser knows (server history + unsynced marks), so every tile agrees with "Applied today".
  function funnel() {
    const ever = (j, st) => statusOf(j) === st || (j.history || []).some((h) => h.status === st);
    const appliedJobs = S.jobs.filter((j) => APPLIED.has(statusOf(j)) || ever(j, "applied"));
    const f = { tracked: S.jobs.length, applied: appliedJobs.length, responded: 0, shortlisted: 0, interviews: 0, offers: 0, rejected: 0 };
    for (const j of appliedJobs) {
      const st = statusOf(j);
      if (["shortlisted", "interview", "offer", "rejected"].includes(st)) f.responded += 1;
      if (["shortlisted", "interview", "offer"].includes(st) || ever(j, "shortlisted")) f.shortlisted += 1;
      if (["interview", "offer"].includes(st) || ever(j, "interview")) f.interviews += 1;
      if (st === "offer") f.offers += 1;
      if (st === "rejected") f.rejected += 1;
    }
    return f;
  }
  function streak(days) {
    let n = 0;
    const d = new Date();
    if (!days.get(localDay(d))) d.setDate(d.getDate() - 1); // today not done yet: count from yesterday
    while (days.get(localDay(d))) { n += 1; d.setDate(d.getDate() - 1); }
    return n;
  }

  // ------------------------------------------------------------------ local encrypted storage
  async function localKeyFor(pass) {
    let salt = null;
    try { salt = localStorage.getItem(LS.salt); } catch (_) { /* storage blocked */ }
    if (!salt) {
      const fresh = crypto.getRandomValues(new Uint8Array(16));
      salt = window.JRCrypto.b64e(fresh);
      try { localStorage.setItem(LS.salt, salt); } catch (_) { /* fine */ }
    }
    return deriveKey(pass, window.JRCrypto.b64d(salt), 600000);
  }
  async function loadLocal() {
    try {
      const raw = localStorage.getItem(LS.local);
      if (!raw) return;
      Object.assign(S.local, await decryptWithKey(S.localKey, JSON.parse(raw)));
    } catch (_) {
      toast("Saved settings were made with another passphrase and were reset");
    }
  }
  async function saveLocal() {
    if (!S.localKey) return;
    try { localStorage.setItem(LS.local, JSON.stringify(await encryptWithKey(S.localKey, S.local))); } catch (_) { /* storage blocked */ }
  }

  // ------------------------------------------------------------------ unlock / lock / refresh
  async function fetchBlob() {
    const resp = await fetch("data/jobs.enc.json", { cache: "no-store" });
    if (!resp.ok) throw new Error(resp.status === 404 ? "No data published yet. Run the scan workflow once." : `Could not load data (${resp.status})`);
    return resp.json();
  }
  async function unlock(pass) {
    const blob = await fetchBlob();
    const [data, localKey] = await Promise.all([decryptBlob(blob, pass), localKeyFor(pass)]);
    S.pass = pass;
    S.localKey = localKey;
    await loadLocal();
    setData(data);
  }
  function setData(data) {
    S.data = data;
    S.jobs = data.jobs || [];
    S.byId = new Map(S.jobs.map((j) => [j.id, j]));
    pruneSyncedOverrides();
    if (!S.local.repo) S.local.repo = guessRepo();
    if (S.localKey) saveLocal();
    if (pendingChanges().length) scheduleSync(); // e.g. marks a cancelled run dropped: send them again
  }
  async function refresh() {
    try {
      setData(await decryptBlob(await fetchBlob(), S.pass));
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
    const input = $("#pass");
    const btn = $("#unlock-btn");
    const err = $("#lock-error");
    btn.disabled = true;
    btn.textContent = "Unlocking...";
    err.textContent = "";
    try {
      await unlock(input.value);
      input.value = "";
      $("#lock").classList.add("hidden");
      $("#app").classList.remove("hidden");
      S.failed = 0;
      render();
      $("#view").focus();
    } catch (ex) {
      S.failed += 1;
      const wait = Math.min(8000, 900 * S.failed);  // slow down guessing
      await new Promise((r) => setTimeout(r, wait));
      err.textContent = ex instanceof DOMException || ex?.name === "OperationError" ? "Wrong passphrase." : (ex.message || "Could not unlock.");
      input.select();
    } finally {
      btn.disabled = false;
      btn.textContent = "Unlock";
    }
  });
  $("#lock-btn").addEventListener("click", lock);
  $("#refresh-btn").addEventListener("click", refresh);
  for (const ev of ["pointerdown", "keydown", "scroll", "touchstart"]) addEventListener(ev, () => { S.lastActive = Date.now(); }, { passive: true });
  setInterval(() => { if (S.pass && Date.now() - S.lastActive > LOCK_AFTER_MS) lock(); }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSync();
    else if (S.pass && Date.now() - S.lastActive > LOCK_AFTER_MS) lock();
  });

  // ------------------------------------------------------------------ theme
  function applyTheme() {
    let t = null;
    try { t = localStorage.getItem(LS.theme); } catch (_) { /* default */ }
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  }
  $("#theme-btn").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    try { localStorage.setItem(LS.theme, dark ? "light" : "dark"); } catch (_) { /* fine */ }
    applyTheme();
    if (S.view === "insights") render();
  });
  applyTheme();

  // ------------------------------------------------------------------ sync to the private repo (optional)
  function scheduleSync() {
    if (!S.local.token) return;
    clearTimeout(S.syncTimer);
    S.syncTimer = setTimeout(() => sync(false), SYNC_DEBOUNCE_MS);
    renderSyncPill();
  }
  function flushSync() { if (S.local.token && pendingChanges().length) sync(true); }
  async function sync(keepalive) {
    clearTimeout(S.syncTimer);
    if (!pendingChanges().length || !S.local.token) return renderSyncPill();
    if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(S.local.repo)) { S.local.lastSyncError = "Set the repository in Settings"; return renderSyncPill(); }
    // Send every unconfirmed change, not only new ones: GitHub cancels a queued run when a newer one arrives,
    // so the newest dispatch must carry everything. The server ignores repeats and stale changes.
    const changes = unconfirmed().sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, 150)
      .map(([id, o]) => ({ id, status: o.status, at: o.at, note: o.note || undefined }));
    while (changes.length > 1 && JSON.stringify(changes).length > 60000) changes.pop(); // GitHub input limit ~65 KB
    try {
      const resp = await fetch(`https://api.github.com/repos/${S.local.repo}/actions/workflows/update-status.yml/dispatches`, {
        method: "POST", keepalive,
        headers: { Authorization: `Bearer ${S.local.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        body: JSON.stringify({ ref: "prod", inputs: { changes: JSON.stringify(changes) } }),
      });
      if (resp.status !== 204) throw new Error(resp.status === 401 || resp.status === 403 ? "Token rejected" : `GitHub said ${resp.status}`);
      const now = Date.now();
      for (const c of changes) if (S.local.overrides[c.id]) Object.assign(S.local.overrides[c.id], { sent: true, sentAt: now });
      S.local.lastSync = new Date().toISOString();
      S.local.lastSyncError = "";
      if (!keepalive) toast("Saved to GitHub. Other devices show it in about 2-3 minutes (press Refresh there).");
    } catch (e) {
      S.local.lastSyncError = e.message || "Sync failed";
    }
    await saveLocal();
    renderSyncPill();
  }
  function renderSyncPill() {
    const pill = $("#sync-pill");
    const n = unconfirmed().length;
    const due = pendingChanges().length;
    pill.className = "pill";
    if (!S.local.token) { pill.textContent = n ? `${n} saved on this device only` : "Saved on this device"; if (n) pill.classList.add("pending"); return; }
    if (S.local.lastSyncError) { pill.textContent = `Sync: ${S.local.lastSyncError}`; pill.classList.add("pending"); return; }
    if (due) { pill.textContent = `${due} change${due > 1 ? "s" : ""} to sync`; pill.classList.add("pending"); return; }
    if (n) { pill.textContent = `${n} saving to GitHub…`; pill.classList.add("busy"); pill.title = "Sent; appears in the data after the next rebuild (2-3 min). Re-sent automatically if it doesn't."; return; }
    pill.textContent = "Synced";
    pill.classList.add("ok");
  }

  // ------------------------------------------------------------------ routing
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    S.view = b.dataset.view;
    S.tableLimit = 100;
    render();
    scrollTo(0, 0);
  }));
  function render() {
    if (!S.data) return;
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === S.view)));
    const gen = S.data.generated_at;
    $("#updated").textContent = `Updated ${agoLabel(gen) || "-"} · ${fmtInt(S.jobs.length)} jobs`;
    S.appliedRk = new Set(S.jobs.filter((j) => APPLIED.has(statusOf(j)) && j.rk).map((j) => j.rk));
    renderSyncPill();
    const view = $("#view");
    view.replaceChildren();
    // Animate only when the tab changes, never on re-renders after a click (that would flicker).
    view.classList.remove("enter");
    if (S.renderedView !== S.view) { void view.offsetWidth; view.classList.add("enter"); S.renderedView = S.view; }
    ({ today: renderToday, board: renderBoard, jobs: renderTable, learn: renderLearn, insights: renderInsights, settings: renderSettings })[S.view](view);
  }

  // ------------------------------------------------------------------ shared job bits
  // Same role (company + title, any city/board) as one you already applied to.
  const sameRoleApplied = (j) => statusOf(j) === "new" && !!j.rk && S.appliedRk.has(j.rk);
  const isOpen = (j) => !["ignored", "rejected", "offer"].includes(statusOf(j)) && !(j.flags || []).includes("closed") && !sameRoleApplied(j);
  function scoreBadge(j) {
    const s = j.score;
    const cls = s == null ? "lo" : s >= 7.5 ? "hi" : s >= 5 ? "mid" : "lo";
    return el("div", { class: `score ${cls}`, title: `Resume fit ${s ?? "?"}/10 · priority ${Math.round(j.prio || 0)}`,
      "aria-label": `Fit ${s ?? "unknown"} out of 10` }, s == null ? "–" : Number(s).toFixed(1));
  }
  function flagChips(j) {
    const out = [];
    const f = j.flags || [];
    if (j.target) out.push(el("span", { class: "chip target" }, "Target company"));
    if (j.yc) out.push(el("span", { class: "chip yc", title: "Y Combinator company" }, "YC"));
    if (sameRoleApplied(j)) out.push(el("span", { class: "chip have", title: "You applied to this same role (another city or job board)" }, "Already applied (same role)"));
    const viaGmail = (j.history || []).filter((h) => h.status).slice(-1)[0];
    if (viaGmail && viaGmail.via === "gmail" && viaGmail.status === j.status) out.push(el("span", { class: "chip mail", title: viaGmail.note || "" }, "✉ Updated from Gmail"));
    if (f.includes("closed")) out.push(el("span", { class: "chip flag" }, "Closed"));
    if (f.includes("reposted")) out.push(el("span", { class: "chip warn", title: "Re-posted several times: may be an evergreen or ghost listing" }, "Re-posted often"));
    if (f.includes("no_visa_info")) out.push(el("span", { class: "chip warn" }, "Visa not mentioned"));
    if (j.visa === true) out.push(el("span", { class: "chip have" }, "Visa / relocation"));
    if (j.ai?.level_fit === "too_senior") out.push(el("span", { class: "chip flag" }, "Likely too senior"));
    return out;
  }
  function metaLine(j) {
    const posted = agoLabel(j.posted) || (j.seen ? `seen ${agoLabel(j.seen)}` : "");
    const closes = closesLabel(j.expires);
    const fresh = postedAt(j) > Date.now() - DAY;
    return el("div", { class: "meta" },
      posted && el("span", { class: fresh ? "chip fresh" : "" }, posted.startsWith("seen") ? posted : `Posted ${posted}`),
      closes && el("span", { class: "chip warn" }, closes),
      el("span", {}, REGION[j.region] || j.region),
      j.years != null && el("span", {}, `${j.years}+ yrs`),
      j.salary && el("span", {}, j.salary),
      el("span", {}, j.source));
  }
  function statusButtons(j, compact) {
    const st = statusOf(j);
    const mk = (status, text, cls = "btn small") => el("button", {
      class: cls, type: "button", "aria-pressed": String(st === status),
      onclick: (e) => { e.stopPropagation(); setStatus(j, st === status && status !== "new" ? "new" : status); },
    }, text);
    if (compact) {
      if (st === "new" || st === "ignored") return [mk("applied", "✓ Mark applied", "btn small good"), mk("ignored", st === "ignored" ? "Unhide" : "Hide")];
      return [stageSelect(j)];
    }
    return STATUSES.map((s) => mk(s, LABEL[s], `btn small stage-btn st-${s}`));
  }
  function stageSelect(j) {
    const st = statusOf(j);
    return el("label", { class: "stage-select" }, el("span", { class: "sr-only" }, "Stage"),
      el("select", { class: `st-${st}`, "aria-label": `Stage for ${j.title}`, onclick: (e) => e.stopPropagation(),
        onchange: (e) => setStatus(j, e.target.value) },
        STATUSES.map((s) => el("option", { value: s, selected: s === st }, LABEL[s]))));
  }
  function stageChip(st) { return el("span", { class: `chip stage st-${st}` }, el("i", { class: "dot" }), LABEL[st]); }
  function jobCard(j) {
    const st = statusOf(j);
    return el("article", { class: `card st-${st}${(j.flags || []).includes("closed") ? " closed" : ""}` },
      el("div", { class: "card-head" },
        el("div", {},
          el("button", { class: "card-title", type: "button", onclick: () => openDrawer(j) }, j.title),
          el("div", { class: "card-co" }, `${j.company} · ${j.location || REGION[j.region] || ""}`)),
        scoreBadge(j)),
      metaLine(j),
      (j.reasons || []).length ? el("div", { class: "reasons" }, j.reasons.join(" · ")) : null,
      el("div", { class: "chips" }, st !== "new" ? stageChip(st) : null, flagChips(j)),
      el("div", { class: "card-actions" }, extLink("Open job ↗", j.url, "btn primary small"), statusButtons(j, true),
        el("button", { class: "btn small", type: "button", onclick: () => openDrawer(j) }, "Details")));
  }
  function cardsOrEmpty(list, emptyText) {
    return list.length ? el("div", { class: "cards" }, list.map(jobCard)) : el("div", { class: "empty" }, emptyText);
  }
  function section(title, sub, body) {
    return el("section", { class: "section" }, el("h2", {}, title, sub && el("span", { class: "sub" }, sub)), body);
  }
  function tile(label, value, note, extra) {
    return el("div", { class: "tile" }, el("div", { class: "label" }, label), el("div", { class: "value" }, value),
      note && el("div", { class: "note" }, note), extra);
  }

  // ------------------------------------------------------------------ scanner status
  function nextRunAt(schedule) {
    const every = schedule?.every_hours || 3, minute = schedule?.minute_utc ?? 17;
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
    const runs = S.data.runs || [];
    const last = runs[runs.length - 1];
    const lr = S.data.last_run || {};
    const next = nextRunAt(S.data.schedule);
    const ok = last ? last.sources_ok === last.sources_total : !lr.sources_failed;
    const today = runs.filter((r) => localDay(r.at) === localDay(Date.now()));
    const addedToday = today.reduce((n, r) => n + (r.added || 0), 0);
    const cell = (label, value, note, cls) => el("div", { class: `scan-cell ${cls || ""}` },
      el("div", { class: "label" }, label), el("div", { class: "value" }, value), note && el("div", { class: "note" }, note));
    return el("section", { class: "scanner", "aria-label": "Scanner status" },
      cell("Last scan", last ? agoLabel(last.at) : agoLabel(S.data.generated_at),
        last ? `${ok ? "✓ all sources OK" : `⚠ ${last.sources_total - last.sources_ok} of ${last.sources_total} sources failed`}` : "", ok ? "ok" : "warn"),
      cell("Added last scan", last ? `+${fmtInt(last.added)}` : "–", last ? `${fmtInt(last.already_tracked)} already tracked, skipped` : ""),
      cell("Added today", `+${fmtInt(addedToday)}`, `${today.length} scan${today.length === 1 ? "" : "s"} today`),
      cell("Next scan", next ? `in ${inLabel(next - Date.now())}` : "–",
        next ? `about ${next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, every 3 hours` : ""),
      cell("AI scored last scan", last ? fmtInt(last.scored) : "–", last ? `run took ${Math.round(last.seconds)}s` : ""));
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
    const closing = open.filter((j) => { const t = parse(j.expires); return t && t > Date.now() && t - Date.now() < 5 * DAY; })
      .sort((a, b) => parse(a.expires) - parse(b.expires));
    const follow = (S.data.follow_ups || []).map((f) => S.byId.get(f.id)).filter((j) => j && statusOf(j) === "applied");
    const a = funnel();
    const review = (S.data.gmail?.review || []).filter((r) => Date.now() - (parse(r.at) || 0) < 14 * DAY);

    root.append(scannerPanel(),
      el("div", { class: "tiles" },
        tile("Applied today", `${today} / ${goal}`, today >= goal ? "Goal met. Nice work." : `${goal - today} to go`, bar),
        tile("Streak", `${st} day${st === 1 ? "" : "s"}`, "days in a row with an application"),
        tile("New in last 24h", fmtInt(fresh.length), "matching, not yet actioned"),
        tile("Follow-ups due", fmtInt(follow.length), "applied 7+ days ago"),
        tile("Interview rate", a.applied ? `${Math.round((100 * (a.interviews || 0)) / a.applied)}%` : "–", `${a.interviews || 0} of ${a.applied || 0} applications`)),
      section("Apply next", "best fit × location × freshness, max 3 per company", cardsOrEmpty(picks.slice(0, 12), "Nothing waiting. New jobs arrive every 3 hours.")),
      section("Fresh: posted in the last 24 hours", "newest first", cardsOrEmpty(fresh.slice(0, 24), "No new postings in the last 24 hours yet.")),
      closing.length ? section("Closing soon", "apply before the deadline", cardsOrEmpty(closing.slice(0, 12), "")) : null,
      follow.length ? section("Follow up", "applied a week ago, no update: ping the recruiter or a referrer", cardsOrEmpty(follow.slice(0, 12), "")) : null,
      review.length ? section("Check by hand", "a company you applied to emailed you, but it wasn't clear which job: nothing was changed",
        el("div", { class: "review-list" }, review.slice().reverse().map((r) => el("div", { class: "review" },
          el("div", {}, el("strong", {}, r.company), el("span", { class: `chip stage st-${r.outcome}` }, el("i", { class: "dot" }), LABEL[r.outcome] || r.outcome), el("span", { class: "sub" }, agoLabel(r.at))),
          el("div", { class: "subject" }, r.subject), el("div", { class: "sub" }, r.why),
          el("div", { class: "card-actions" }, (r.jobs || []).map((id) => S.byId.get(id)).filter(Boolean)
            .map((j) => el("button", { class: "btn small", type: "button", onclick: () => openDrawer(j) }, `${j.title} ↗`))))))) : null);
  }

  // ------------------------------------------------------------------ Board (kanban)
  function renderBoard(root) {
    const cols = STATUSES.filter((s) => s !== "ignored" || S.showIgnored);
    const groups = Object.fromEntries(cols.map((s) => [s, []]));
    for (const j of S.jobs) { const s = statusOf(j); if (groups[s]) groups[s].push(j); }
    groups.new = groups.new.filter((j) => !(j.flags || []).includes("closed") && !sameRoleApplied(j)).sort((a, b) => (b.prio || 0) - (a.prio || 0)).slice(0, 60);
    const toggle = el("label", {}, el("input", { type: "checkbox", checked: S.showIgnored, onchange: (e) => { S.showIgnored = e.target.checked; render(); } }), " Show hidden");
    const board = el("div", { class: "board" }, cols.map((s) => {
      const col = el("div", { class: `col st-${s}`, dataset: { status: s }, "aria-label": `${LABEL[s]} column` },
        el("h3", {}, el("span", { class: "col-title" }, el("i", { class: "dot" }), LABEL[s]),
          el("span", { class: "count-pill" }, s === "new" ? "top 60" : String(groups[s].length))),
        groups[s].length ? null : el("div", { class: "col-empty" }, s === "applied" ? "Mark jobs applied from Today" : "Drop cards here"),
        groups[s].map((j) => el("div", {
          class: `mini st-${s}`, draggable: "true", tabindex: "0", role: "button", "aria-label": `${j.title} at ${j.company}`,
          ondragstart: (e) => e.dataTransfer.setData("text/plain", j.id),
          onclick: () => openDrawer(j), onkeydown: (e) => { if (e.key === "Enter") openDrawer(j); },
        }, el("div", { class: "t" }, j.title), el("div", { class: "c" }, j.company),
        el("div", { class: "m" }, el("span", {}, j.score != null ? `fit ${Number(j.score).toFixed(1)}` : ""), el("span", {}, agoLabel(j.posted)), el("span", {}, REGION[j.region] || "")))));
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drop"); });
      col.addEventListener("dragleave", () => col.classList.remove("drop"));
      col.addEventListener("drop", (e) => {
        e.preventDefault();
        col.classList.remove("drop");
        const job = S.byId.get(e.dataTransfer.getData("text/plain"));
        if (job && statusOf(job) !== s) setStatus(job, s);
      });
      return col;
    }));
    root.append(el("div", { class: "filters" }, el("span", { class: "sub" }, "Drag cards between columns, or open a card to change its status."), toggle), board);
  }

  // ------------------------------------------------------------------ All jobs (table)
  const COLUMNS = [
    ["posted", "Posted", (j) => postedAt(j), (j) => agoLabel(j.posted) || "–"],
    ["prio", "Priority", (j) => j.prio || 0, (j) => Math.round(j.prio || 0), "num"],
    ["score", "Fit", (j) => j.score ?? -1, (j) => (j.score == null ? "–" : Number(j.score).toFixed(1)), "num"],
    ["title", "Title", (j) => j.title.toLowerCase(), (j) => j.title, "wrap"],
    ["company", "Company", (j) => j.company.toLowerCase(), (j) => j.company],
    ["location", "Location", (j) => (j.location || "").toLowerCase(), (j) => (j.location || "").slice(0, 34)],
    ["region", "Region", (j) => j.region, (j) => REGION[j.region] || j.region],
    ["level", "Level", (j) => j.ai?.level_fit || "", (j) => ({ ok: "OK", too_senior: "Too senior", too_junior: "Junior" })[j.ai?.level_fit] || (j.years != null ? `${j.years}+ yrs` : "–")],
    ["status", "Status", (j) => STATUSES.indexOf(statusOf(j)), (j) => LABEL[statusOf(j)]],
    ["source", "Source", (j) => j.source, (j) => j.source],
  ];
  function filtered() {
    const f = S.filters;
    const q = f.q.trim().toLowerCase();
    const horizon = { "24h": DAY, "3d": 3 * DAY, "7d": 7 * DAY, "30d": 30 * DAY }[f.posted];
    return S.jobs.filter((j) => {
      const st = statusOf(j);
      if (f.status === "open" && (!isOpen(j) || st !== "new")) return false;
      if (f.status && f.status !== "open" && st !== f.status) return false;
      if (f.region && j.region !== f.region) return false;
      if (horizon && postedAt(j) < Date.now() - horizon) return false;
      if (f.minScore && (j.score ?? 0) < Number(f.minScore)) return false;
      if (f.source && j.source !== f.source) return false;
      if (f.hideClosed && (j.flags || []).includes("closed")) return false;
      if (f.target && !j.target) return false;
      if (f.yc && !j.yc) return false;
      if (q && !`${j.title} ${j.company} ${j.location}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }
  function renderTable(root) {
    const f = S.filters;
    const sources = [...new Set(S.jobs.map((j) => j.source))].sort();
    const sel = (key, label, options) => el("label", {}, el("span", { class: "sr-only" }, label),
      el("select", { "aria-label": label, onchange: (e) => { f[key] = e.target.value; S.tableLimit = 100; render(); } },
        options.map(([v, t]) => el("option", { value: v, selected: f[key] === v }, t))));
    const search = el("input", { type: "search", placeholder: "Search title, company, city", value: f.q, "aria-label": "Search jobs" });
    let typing = null;
    search.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { f.q = search.value; S.tableLimit = 100; drawRows(); }, 120); });
    const filters = el("div", { class: "filters" }, search,
      sel("status", "Status", [["open", "Not applied yet"], ["", "Any status"], ...STATUSES.map((s) => [s, LABEL[s]])]),
      sel("region", "Region", [["", "All regions"], ["india", "India"], ["remote", "Remote"], ["abroad", "Abroad"]]),
      sel("posted", "Posted", [["", "Any time"], ["24h", "Last 24h"], ["3d", "Last 3 days"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]]),
      sel("minScore", "Minimum fit", [["", "Any fit"], ["5", "Fit 5+"], ["6", "Fit 6+"], ["7", "Fit 7+"], ["8", "Fit 8+"]]),
      sel("source", "Source", [["", "All sources"], ...sources.map((s) => [s, s])]),
      el("label", {}, el("input", { type: "checkbox", checked: f.yc, onchange: (e) => { f.yc = e.target.checked; render(); } }), "YC only"),
      el("label", {}, el("input", { type: "checkbox", checked: f.hideClosed, onchange: (e) => { f.hideClosed = e.target.checked; render(); } }), "Hide closed"),
      el("label", {}, el("input", { type: "checkbox", checked: f.target, onchange: (e) => { f.target = e.target.checked; render(); } }), "Target companies"));
    const thead = el("thead", {}, el("tr", {}, COLUMNS.map(([key, label, , , cls]) => {
      const th = el("th", { class: cls === "num" ? "num" : "", scope: "col", tabindex: "0",
        "aria-sort": S.sort.key === key ? (S.sort.dir > 0 ? "ascending" : "descending") : "none" }, label);
      const go = () => { S.sort = { key, dir: S.sort.key === key ? -S.sort.dir : (key === "title" || key === "company" ? 1 : -1) }; render(); };
      th.addEventListener("click", go);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      return th;
    })));
    const tbody = el("tbody");
    const count = el("div", { class: "sub" });
    const more = el("div", { class: "more" });
    function drawRows() {
      const col = COLUMNS.find((c) => c[0] === S.sort.key) || COLUMNS[1];
      const rows = filtered().sort((a, b) => { const x = col[2](a), y = col[2](b); return (x > y ? 1 : x < y ? -1 : 0) * S.sort.dir; });
      count.textContent = `${fmtInt(rows.length)} jobs`;
      tbody.replaceChildren(...rows.slice(0, S.tableLimit).map((j) => {
        const tr = el("tr", { tabindex: "0", onclick: () => openDrawer(j), onkeydown: (e) => { if (e.key === "Enter") openDrawer(j); } },
          COLUMNS.map(([, , , show, cls]) => el("td", { class: cls || "" }, show(j))));
        return tr;
      }));
      more.replaceChildren(rows.length > S.tableLimit
        ? el("button", { class: "btn", type: "button", onclick: () => { S.tableLimit += 200; drawRows(); } }, `Show more (${fmtInt(rows.length - S.tableLimit)} left)`)
        : "");
    }
    drawRows();
    root.append(filters, count, el("div", { class: "table-wrap" }, el("table", {}, thead, tbody)), more);
  }

  // ------------------------------------------------------------------ referral message (your format, max 5 lines)
  const GENERIC_SKILLS = new Set(["Containerization", "Container Orchestration", "Microservices", "Machine Learning",
    "Infrastructure as Code", "Continuous Integration", "Continuous Delivery", "Cost Optimization", "Capacity Planning", "Monitoring", "Automation", "Dashboards", "Compliance", "Encryption", "Alerting", "Linux",
    "Git", "YAML", "Bash", "DNS", "SSH", "TCP/IP", "SSL/TLS", "Troubleshooting", "Networking", "SQL", "NoSQL", "IaC", "CI/CD Pipelines"]);
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
    return [
      "Hello [Name],",
      `I am ${me.first_name || "Karthik"} from ${me.city || "Bangalore, India"}, currently working as a ${me.title || "DevOps Engineer"} at ${me.company || "InCruiter"}.`,
      `I came across ${role} and would be grateful if you could refer me${j.ref ? "." : `: ${j.url}`}`,
      `I have hands-on experience with ${topSkills(j)}${hl ? `, and I ${hl}` : ""}.`,
      "I have attached my resume for your reference. Thank you for your time.",
    ].join("\n");
  }
  // LinkedIn connection notes are capped at 300 characters.
  function referralShort(j) {
    const me = S.data.resume?.intro || {};
    const id = j.ref ? ` (Job ID: ${j.ref})` : "";
    let msg = `Hi [Name], I'm ${me.first_name || "Karthik"}, a ${me.title || "DevOps Engineer"} at ${me.company || "InCruiter"} in Bangalore. I'm applying for the ${j.title} role at ${j.company}${id} and would really appreciate a referral. Happy to share my resume. Thank you.`;
    if (msg.length > 300) msg = msg.replace(` the ${j.title} role`, " this role");
    return msg.slice(0, 300);
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch (_) { toast("Copy failed: select the text instead"); }
  }

  // ------------------------------------------------------------------ tailored resume (printed to PDF in your layout)
  // **bold** markers -> <strong>, built with text nodes only (resume text is data, never HTML).
  function rich(text) {
    return String(text || "").split(/(\*\*[^*]+\*\*)/).filter(Boolean)
      .map((part) => (part.startsWith("**") ? el("strong", {}, part.slice(2, -2)) : document.createTextNode(part)));
  }
  const ordered = (items, order) => (order && order.length === items.length ? order.map((i) => items[i]) : items);
  function resumeNode(j) {
    const r = S.data.resume || {};
    const t = (j && j.tl) || {};
    const c = r.contact || {};
    const bits = [c.email, c.phone, c.location].filter(Boolean).map((x) => document.createTextNode(x));
    for (const l of c.links || []) bits.push(el("a", { href: l.url }, l.label));
    const contact = el("div", { class: "r-contact" }, bits.flatMap((b, i) => (i ? [document.createTextNode(" | "), b] : [b])));
    const sec = (title, ...kids) => el("section", {}, el("h2", {}, title), ...kids);
    const profile = (r.profile || {})[t.fam] || (r.profile || {}).default || "";
    const skills = (r.skills || []).map((line, i) => {
      const items = [...ordered(line.items || [], (t.skills || [])[i]), ...((t.add || {})[i] || [])];
      return el("p", { class: "r-skill" }, el("strong", {}, `${line.label}: `), items.join(", "));
    });
    const exp = (r.experience || []).map((x, i) => el("div", { class: "r-role" },
      el("div", { class: "r-row" }, el("strong", {}, [x.title, x.company, x.location].filter(Boolean).join(", ")), el("strong", {}, x.dates)),
      x.subtitle ? el("div", { class: "r-sub" }, x.subtitle) : null,
      el("ul", {}, ordered(x.bullets || [], (t.exp || [])[i]).map((b) => el("li", {}, rich(b))))));
    const gh = (c.links || []).find((l) => /github/i.test(l.label))?.url;
    const projects = el("ul", {}, ordered(r.projects || [], t.proj).map((pr) => el("li", {},
      el("strong", {}, `${pr.name} (${pr.year})`), " ", pr.link || gh ? el("a", { href: pr.link || gh }, "[GitHub]") : null, ": ", rich(pr.text))));
    const edu = (r.education || []).map((e) => el("div", { class: "r-role" },
      el("div", { class: "r-row" }, el("strong", {}, e.school), el("strong", {}, e.dates)), el("div", {}, e.degree)));
    return el("article", { class: "resume" },
      el("h1", {}, r.name || ""), contact, c.tagline ? el("div", { class: "r-tag" }, c.tagline) : null,
      sec("Profile", el("p", {}, profile)), sec("Skills", ...skills), sec("Work Experience", ...exp),
      sec("Projects", projects), sec("Awards & Certifications", el("ul", {}, (r.awards || []).map((a) => el("li", {}, rich(a))))),
      sec("Education", ...edu));
  }
  // Fit on one A4 page: shrink the font in small steps until it fits (measured off-screen at print width).
  // Starts at your PDF's size (about 10pt) and steps down only if needed; never below ~8pt.
  function fitOnePage(node) {
    const pagePx = ((297 - 2 * 9) * 96) / 25.4 - 4;
    let size = 13.4;
    node.style.fontSize = `${size}px`;
    while (node.scrollHeight > pagePx && size > 10.6) { size -= 0.2; node.style.fontSize = `${size.toFixed(1)}px`; }
  }
  async function printResume(j) {
    const r = S.data.resume;
    if (!r || !r.name) { toast("No resume data yet: it appears after the next scan."); return; }
    const root = $("#print-root");
    const node = resumeNode(j);
    root.replaceChildren(node);
    root.classList.add("measuring");
    try { await Promise.all(["400", "700", "italic 400"].map((w) => document.fonts.load(`${w} 13px "Lato JR"`))); } catch (_) { /* fallback font */ }
    fitOnePage(node);
    root.classList.remove("measuring");
    const prevTitle = document.title;
    const company = j ? `_${j.company.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}` : "";
    document.title = `${(r.name || "Resume").replace(/\s+/g, "_")}_Resume${company}`; // the PDF's file name
    const done = () => { document.title = prevTitle; root.replaceChildren(); removeEventListener("afterprint", done); };
    addEventListener("afterprint", done);
    setTimeout(() => window.print(), 50);
  }
  function tailorPanel(j) {
    const t = j.tl || {};
    if (!S.data.resume?.name) return el("p", { class: "reasons" }, "Tailored resume appears after the next scan.");
    const meter = (label, v, cls) => {
      const bar = el("div", { class: `meter ${cls}` }, el("div"));
      bar.firstChild.style.width = `${v ?? 0}%`;
      return el("div", { class: "meter-row" }, el("span", {}, label), bar, el("strong", {}, v == null ? "–" : `${v}%`));
    };
    const fam = { default: "your standard profile", sre: "SRE wording", platform: "platform wording", cloud: "cloud wording", mlops: "MLOps wording", devsecops: "DevSecOps wording" }[t.fam] || "your standard profile";
    return el("div", { class: "tailor" },
      t.before != null ? el("div", { class: "meters" }, meter("Your resume", t.before, "before"), meter("Tailored", t.after, "after")) :
        el("p", { class: "reasons" }, "This posting lists few keywords, so the resume is reordered only."),
      el("p", { class: "reasons" }, `Keyword match with this job (what online ATS checkers measure). Bullets most relevant to this job come first, profile uses ${fam}. Same layout, one page, nothing invented.`),
      t.added?.length ? [el("div", { class: "sub" }, "Added to skills (your resume already proves these):"), el("div", { class: "chips" }, t.added.map((x) => el("span", { class: "chip have" }, `+ ${x}`)))] : null,
      t.missing?.length ? [el("div", { class: "sub" }, "Asked for but not on your resume (not added):"), el("div", { class: "chips" }, t.missing.map((x) => el("span", { class: "chip miss" }, x)))] : null,
      el("div", { class: "status-row" }, el("button", { class: "btn primary", type: "button", onclick: () => printResume(j) }, "⬇ Download tailored resume (PDF)")),
      el("p", { class: "reasons" }, "In the print window choose \"Save as PDF\", paper A4, margins Default, and turn off \"Headers and footers\"."));
  }

  // ------------------------------------------------------------------ drawer (job detail + apply kit)
  function openDrawer(j) {
    const rootEl = $("#drawer-root");
    const prevFocus = document.activeElement;
    const close = () => { rootEl.replaceChildren(); document.removeEventListener("keydown", onKey); prevFocus?.focus?.(); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    const ai = j.ai || {};
    const list = (items, ordered) => el(ordered ? "ol" : "ul", {}, (items || []).map((t) => el("li", {}, t)));
    const people = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${j.company} engineer`)}`;
    const note = el("textarea", { "aria-label": "Your notes", placeholder: "Notes: referral contact, recruiter name, salary discussed..." });
    note.value = S.local.overrides[j.id]?.note || (j.history || []).filter((h) => h.note).slice(-1)[0]?.note || "";
    const saveNote = () => {
      const o = S.local.overrides[j.id] || { status: statusOf(j), at: new Date().toISOString(), note: "", sent: false };
      if (o.note === note.value) return;
      S.local.overrides[j.id] = { ...o, note: note.value.slice(0, 500), at: new Date().toISOString(), sent: false };
      saveLocal(); scheduleSync(); toast("Note saved");
    };
    note.addEventListener("change", saveNote);
    const message = referralMessage(j);
    const short = referralShort(j);
    const drawer = el("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": `${j.title} at ${j.company}` },
      el("button", { class: "btn small close", type: "button", onclick: close, "aria-label": "Close" }, "✕"),
      el("h2", {}, j.title),
      el("div", { class: "card-co" }, `${j.company} · ${j.location || ""}`),
      el("div", { class: "status-row" }, extLink("Open job ↗", j.url, "btn primary"), extLink("Find people ↗", people),
        (j.alt || []).map((u, i) => extLink(`Alt link ${i + 1} ↗`, u))),
      metaLine(j),
      el("div", { class: "chips" }, scoreBadge(j), flagChips(j)),
      (j.reasons || []).length ? el("p", { class: "reasons" }, j.reasons.join(" · ")) : null,
      el("h3", {}, "Status"), el("div", { class: "status-row" }, statusButtons(j, false)),
      ai.matched_skills?.length ? [el("h3", {}, "You match"), el("div", { class: "chips" }, ai.matched_skills.map((s) => el("span", { class: "chip have" }, s)))] : null,
      ai.missing_skills?.length ? [el("h3", {}, "Gaps to address"), el("div", { class: "chips" }, ai.missing_skills.map((s) => el("span", { class: "chip miss" }, s)))] : null,
      ai.red_flags?.length ? [el("h3", {}, "Watch out"), list(ai.red_flags)] : null,
      el("h3", {}, "Tailored resume"), tailorPanel(j),
      ai.tailoring_tips?.length ? [el("h3", {}, "Tips to mention in interviews"), list(ai.tailoring_tips, true)] : null,
      el("h3", {}, "Referral message"), el("div", { class: "referral" }, message),
      el("div", { class: "status-row" }, el("button", { class: "btn small primary", type: "button", onclick: () => copy(message, "Referral message") }, "Copy message"),
        el("button", { class: "btn small", type: "button", title: short, onclick: () => copy(short, "Short note (fits LinkedIn's 300 characters)") }, "Copy short note"),
        extLink("Find a referrer ↗", people, "btn small")),
      el("p", { class: "reasons" }, "Replace [Name], attach the PDF above, and send it yourself. Nothing is ever sent or automated on LinkedIn."),
      ai.interview_topics?.length ? [el("h3", {}, "Interview prep"), list(ai.interview_topics, true)] : null,
      ai.method !== "llm" ? el("p", { class: "reasons" }, "AI apply kit appears after this job is scored by the AI (usually within a few runs).") : null,
      el("h3", {}, "Notes"), note,
      j.desc ? [el("h3", {}, "From the posting"), el("div", { class: "desc" }, j.desc)] : null);
    rootEl.replaceChildren(el("div", { class: "backdrop", onclick: close }), drawer);
    drawer.querySelector(".close").focus();
  }

  // ------------------------------------------------------------------ Insights (analytics)
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function niceMax(v) { if (v <= 5) return 5; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p) * p; }
  function shortDate(iso) { const d = new Date(`${iso}T00:00:00`); return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); }

  // Vertical bars over days; one or more stacked series; optional dashed goal line. Hover/focus tooltip per day.
  function barChart({ title, sub, rows, series, goal, dateFmt }) {
    const fmtDate = dateFmt || shortDate;
    const W = 640, H = 220, L = 34, R = 8, T = 10, B = 26;
    const box = el("div", { class: "chart" }, el("h3", {}, title), el("div", { class: "sub" }, sub));
    if (series.length > 1) box.append(el("div", { class: "legend" }, series.map((s) => { const i = el("i"); i.style.background = cssVar(s.color); return el("span", {}, i, s.label); })));
    const totals = rows.map((r) => series.reduce((a, s) => a + (r[s.key] || 0), 0));
    const max = niceMax(Math.max(1, goal || 0, ...totals));
    const plotW = W - L - R, plotH = H - T - B, step = plotW / rows.length, bw = Math.min(28, Math.max(3, step - 2));
    const y = (v) => T + plotH - (v / max) * plotH;
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title}. ${sub}` });
    for (const t of [0, max / 2, max]) {
      root.append(svg("line", { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 ? "base" : "grid" }));
      const lab = svg("text", { x: L - 6, y: y(t) + 4, "text-anchor": "end", class: "axis-label" }); lab.textContent = fmtInt(t); root.append(lab);
    }
    const tip = el("div", { class: "tooltip hidden", role: "status" });
    rows.forEach((r, i) => {
      const x = L + i * step + (step - bw) / 2;
      let acc = 0;
      const segs = series.filter((s) => (r[s.key] || 0) > 0);
      segs.forEach((s, k) => {
        const v = r[s.key] || 0;
        const top = y(acc + v), bottom = y(acc) - (k > 0 ? 2 : 0); // 2px surface gap between stacked segments
        const h = Math.max(0, bottom - top);
        const isTop = k === segs.length - 1;
        const rr = Math.min(4, bw / 2, h);
        const d = isTop
          ? `M${x},${bottom} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + bw - rr} Q${x + bw},${top} ${x + bw},${top + rr} V${bottom} Z`
          : `M${x},${bottom} V${top} H${x + bw} V${bottom} Z`;
        root.append(svg("path", { d, fill: cssVar(s.color) }));
        acc += v;
      });
      const hit = svg("rect", { x: L + i * step, y: T, width: step, height: plotH, fill: "transparent", tabindex: "0",
        "aria-label": `${fmtDate(r.date)}: ${series.map((s) => `${s.label} ${r[s.key] || 0}`).join(", ")}` });
      const show = () => {
        tip.replaceChildren(el("div", { class: "sub" }, fmtDate(r.date)),
          ...series.map((s) => { const k = el("span", { class: "key" }); k.style.background = cssVar(s.color); return el("div", { class: "row" }, k, el("strong", {}, fmtInt(r[s.key] || 0)), " ", s.label); }),
          series.length > 1 ? el("div", { class: "row" }, el("strong", {}, fmtInt(totals[i])), " total") : "");
        tip.classList.remove("hidden");
        const bounds = root.getBoundingClientRect();
        const px = ((L + (i + 0.5) * step) / W) * bounds.width;
        tip.style.left = `${Math.min(bounds.width - 140, Math.max(0, px - 60)) + 14}px`;
        tip.style.top = "48px";
      };
      hit.addEventListener("mouseenter", show); hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", () => tip.classList.add("hidden")); hit.addEventListener("blur", () => tip.classList.add("hidden"));
      root.append(hit);
      const tickEvery = Math.max(1, Math.ceil(rows.length / 5));
      if ((rows.length - 1 - i) % tickEvery === 0) { // ticks anchored on the latest bar: never collide
        const lab = svg("text", { x: L + (i + 0.5) * step, y: H - 8, "text-anchor": "middle", class: "axis-label" }); lab.textContent = dateFmt ? fmtDate(r.date).split(",")[0] : shortDate(r.date); root.append(lab);
      }
    });
    if (goal) {
      root.append(svg("line", { x1: L, x2: W - R, y1: y(goal), y2: y(goal), class: "goal-line" }));
      const g = svg("text", { x: W - R, y: y(goal) - 5, "text-anchor": "end", class: "goal-text" }); g.textContent = `goal ${goal}/day`; root.append(g);
    }
    box.append(root, tip);
    return box;
  }
  // Donut: identity by color AND by labelled legend rows with counts and %, 2px surface gaps between slices.
  function donut(title, sub, items, centerLabel) {
    const box = el("div", { class: "chart donut-card" }, el("h3", {}, title), el("div", { class: "sub" }, sub));
    const total = items.reduce((n, i) => n + i.value, 0);
    const R = 78, r = 52, C = 100;
    const root = svg("svg", { viewBox: "0 0 200 200", role: "img", "aria-label": `${title}: ${items.map((i) => `${i.label} ${i.value}`).join(", ")}` });
    const tip = el("div", { class: "tooltip hidden", role: "status" });
    if (!total) {
      root.append(svg("circle", { cx: C, cy: C, r: (R + r) / 2, fill: "none", stroke: cssVar("--grid"), "stroke-width": R - r }));
    } else {
      let a0 = -Math.PI / 2;
      const shown = items.filter((i) => i.value > 0);
      for (const it of shown) {
        const frac = it.value / total;
        const a1 = a0 + frac * 2 * Math.PI;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const p = (rad, ang) => `${C + rad * Math.cos(ang)},${C + rad * Math.sin(ang)}`;
        const d = shown.length === 1
          ? `M${C - R},${C} a${R},${R} 0 1,0 ${2 * R},0 a${R},${R} 0 1,0 ${-2 * R},0 M${C - r},${C} a${r},${r} 0 1,1 ${2 * r},0 a${r},${r} 0 1,1 ${-2 * r},0`
          : `M${p(R, a0)} A${R},${R} 0 ${large} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${large} 0 ${p(r, a0)} Z`;
        const slice = svg("path", { d, fill: cssVar(it.color), stroke: cssVar("--surface"), "stroke-width": 2, "fill-rule": "evenodd",
          tabindex: "0", class: "slice", "aria-label": `${it.label}: ${it.value} (${Math.round(100 * frac)}%)` });
        const show = () => {
          tip.replaceChildren(el("div", { class: "row" }, el("strong", {}, fmtInt(it.value)), ` ${it.label} · ${Math.round(100 * frac)}%`));
          tip.classList.remove("hidden");
          tip.style.left = "50%"; tip.style.top = "56px"; tip.style.transform = "translateX(-50%)";
        };
        slice.addEventListener("mouseenter", show); slice.addEventListener("focus", show);
        slice.addEventListener("mouseleave", () => tip.classList.add("hidden")); slice.addEventListener("blur", () => tip.classList.add("hidden"));
        root.append(slice);
        a0 = a1;
      }
    }
    const big = svg("text", { x: C, y: C + 4, "text-anchor": "middle", class: "donut-total" }); big.textContent = fmtInt(total);
    const small = svg("text", { x: C, y: C + 22, "text-anchor": "middle", class: "donut-label" }); small.textContent = centerLabel;
    root.append(big, small);
    const legend = el("ul", { class: "donut-legend" }, items.map((it) => {
      const key = el("i"); key.style.background = cssVar(it.color);
      return el("li", {}, key, el("span", { class: "lbl" }, it.label), el("strong", {}, fmtInt(it.value)),
        el("span", { class: "pct" }, total ? `${Math.round((100 * it.value) / total)}%` : "–"));
    }));
    box.append(el("div", { class: "donut-wrap" }, el("div", { class: "donut-svg" }, root, tip), legend));
    return box;
  }
  function runsChart(runs) {
    const box = el("div", { class: "chart" }, el("h3", {}, "Jobs added per scan"),
      el("div", { class: "sub" }, "Every scan over the last 7 days. Jobs already on your list are never added twice."));
    if (!runs.length) { box.append(el("div", { class: "empty" }, "Run history starts with the next scan.")); return box; }
    const rows = runs.map((r) => ({ date: r.at, added: r.added || 0 }));
    const chart = barChart({ title: "", sub: "", rows, series: [{ key: "added", label: "New jobs added", color: "--s1" }], dateFmt: (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" }) });
    chart.querySelector("h3")?.remove(); chart.querySelector(".sub")?.remove();
    chart.classList.remove("chart"); chart.classList.add("chart-inner");
    const recent = runs.slice(-8).reverse();
    box.append(chart, el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["When", "Added", "Already tracked", "AI scored", "Sources OK", "Took"].map((h, i) => el("th", { class: i ? "num" : "", scope: "col" }, h)))),
      el("tbody", {}, recent.map((r) => el("tr", {},
        el("td", {}, new Date(r.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }), r.trigger === "manual" ? el("span", { class: "chip" }, "manual") : null),
        el("td", { class: "num" }, el("strong", {}, `+${fmtInt(r.added)}`)), el("td", { class: "num" }, fmtInt(r.already_tracked)),
        el("td", { class: "num" }, fmtInt(r.scored)), el("td", { class: "num" }, `${r.sources_ok}/${r.sources_total}`),
        el("td", { class: "num" }, `${Math.round(r.seconds)}s`)))))));
    return box;
  }
  function hbars(title, sub, items, fmt) {
    const box = el("div", { class: "chart" }, el("h3", {}, title), el("div", { class: "sub" }, sub));
    if (!items.length) { box.append(el("div", { class: "empty" }, "Not enough scored jobs yet.")); return box; }
    const max = Math.max(...items.map((i) => i.value), 1);
    for (const it of items) {
      const fill = el("div", { class: "fill" }); fill.style.width = `${(100 * it.value) / max}%`;
      box.append(el("div", { class: "hbar", title: `${it.label}: ${fmt(it)}` }, el("span", {}, it.label), el("div", { class: "track" }, fill), el("span", { class: "v" }, fmt(it))));
    }
    return box;
  }
  function renderInsights(root) {
    const an = S.data.analytics || {};
    const w = an.week || {};
    const fu = funnel();
    const delta = (w.new || 0) - (w.prev_new || 0);
    root.append(el("div", { class: "tiles" },
      tile("New matches this week", fmtInt(w.new), w.prev_new ? `${delta >= 0 ? "+" : ""}${fmtInt(delta)} vs last week` : "first week of data: no comparison yet"),
      tile("Strong fits this week", fmtInt(w.good), "fit 6+ of 10"),
      tile("Applications", fmtInt(fu.applied), "all time"),
      tile("Response rate", fu.applied ? `${Math.round((100 * (fu.responded || 0)) / fu.applied)}%` : "–", `${fmtInt(fu.responded)} replied (incl. ${fmtInt(fu.rejected)} rejections)`),
      tile("Interviews", fmtInt(fu.interviews), fu.applied ? `${Math.round((100 * (fu.interviews || 0)) / fu.applied)}% of applications` : ""),
      tile("Offers", fmtInt(fu.offers), "")));

    const days = appliedDays();
    const appliedRows = (an.daily || []).map((d) => ({ date: d.date, applied: days.get(d.date) || 0 }));
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const j of S.jobs) counts[statusOf(j)] += 1;
    const mq = an.match_quality || {};
    const reg = an.regions || {};
    root.append(el("div", { class: "donuts" },
      donut("Your pipeline", "Every job you have moved past New", ["applied", "shortlisted", "interview", "offer", "rejected"]
        .map((s) => ({ label: LABEL[s], value: counts[s], color: STAGE_VAR[s] })), "in progress"),
      donut("Where this week's jobs are", "New matching jobs, last 7 days", [
        { label: "India", value: reg.india || 0, color: "--s1" }, { label: "Remote", value: reg.remote || 0, color: "--s2" },
        { label: "Abroad", value: reg.abroad || 0, color: "--s3" }], "new jobs"),
      donut("Match quality", "Open jobs by resume fit", [
        { label: "Strong (8+)", value: mq.strong || 0, color: "--q-strong" }, { label: "Good (6-8)", value: mq.good || 0, color: "--q-good" },
        { label: "Weak (<6)", value: mq.weak || 0, color: "--q-weak" }], "open jobs")));
    const charts = el("div", { class: "charts" },
      runsChart(S.data.runs || []),
      barChart({ title: "New matching jobs per day", sub: "Last 30 days, by region", rows: an.daily || [],
        series: [{ key: "india", label: "India", color: "--s1" }, { key: "remote", label: "Remote", color: "--s2" }, { key: "abroad", label: "Abroad", color: "--s3" }] }),
      barChart({ title: "Your applications per day", sub: "Last 30 days, against your daily goal", rows: appliedRows,
        series: [{ key: "applied", label: "Applications", color: "--s1" }], goal: Math.max(1, Number(S.local.goal) || 5) }),
      hbars("Skill gaps in jobs you fit", "Share of this week's 6+ fit jobs asking for a skill your resume doesn't show. Learn the top ones.",
        (an.skill_gap || []).map((s) => ({ label: s.skill, value: s.pct })), (i) => `${i.value}%`),
      hbars("Your strongest selling points", "Share of this week's 6+ fit jobs that ask for skills you have",
        (an.strengths || []).map((s) => ({ label: s.skill, value: s.pct })), (i) => `${i.value}%`),
      momentumTable(an.momentum || []),
      hbars("Application funnel", "All time, including marks still syncing", [
        { label: "Tracked", value: fu.tracked || 0 }, { label: "Applied", value: fu.applied || 0 },
        { label: "Shortlisted", value: fu.shortlisted || 0 }, { label: "Interviews", value: fu.interviews || 0 }, { label: "Offers", value: fu.offers || 0 },
      ], (i) => fmtInt(i.value)),
      hbars("Where this week's jobs came from", "Matching jobs by source", Object.entries(an.sources || {}).map(([k, v]) => ({ label: k, value: v })), (i) => fmtInt(i.value)));
    root.append(charts);
  }
  function momentumTable(rows) {
    const box = el("div", { class: "chart" }, el("h3", {}, "Hiring momentum"), el("div", { class: "sub" }, "Companies opening the most matching roles this week. Good places to ask for referrals."));
    if (!rows.length) { box.append(el("div", { class: "empty" }, "No data yet.")); return box; }
    box.append(el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Company"), el("th", { class: "num", scope: "col" }, "This week"), el("th", { class: "num", scope: "col" }, "Last week"), el("th", { scope: "col" }, ""))),
      el("tbody", {}, rows.map((r) => el("tr", { onclick: () => { S.filters = { ...S.filters, q: r.company, status: "" }; S.view = "jobs"; render(); } },
        el("td", {}, r.company), el("td", { class: "num" }, fmtInt(r.this_week)), el("td", { class: "num" }, fmtInt(r.last_week)),
        el("td", {}, r.this_week > r.last_week ? "↑ hiring more" : r.this_week < r.last_week ? "↓ slower" : "steady")))))));
    return box;
  }

  // ------------------------------------------------------------------ Learn (recent videos)
  function renderLearn(root) {
    const vids = S.data.videos || [];
    const topics = [...new Set(vids.map((v) => v.topic))];
    if (!S.learnTopic || (S.learnTopic !== "all" && !topics.includes(S.learnTopic))) S.learnTopic = "all";
    const gaps = (S.data.analytics?.skill_gap || []).slice(0, 5).map((g) => g.skill);
    const shown = vids.filter((v) => S.learnTopic === "all" || v.topic === S.learnTopic);
    const views = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n || 0));
    const pill = (key, text) => el("button", { type: "button", class: "seg", "aria-pressed": String(S.learnTopic === key),
      onclick: () => { S.learnTopic = key; render(); } }, text);
    root.append(
      el("div", { class: "learn-head" },
        el("div", {}, el("h2", {}, "Learn: what's new in your field"),
          el("p", { class: "sub" }, `Recent videos from ${new Set(vids.map((v) => v.channel)).size || "top"} DevOps, cloud and AI channels, ranked by your stack and skill gaps`,
            S.data.videos_at ? ` · updated ${agoLabel(S.data.videos_at)}` : "")),
        gaps.length ? el("div", { class: "chips" }, el("span", { class: "sub" }, "Your gaps this week:"), gaps.map((g) => el("span", { class: "chip miss" }, g))) : null),
      el("div", { class: "segs", role: "group", "aria-label": "Topic" }, pill("all", `All (${vids.length})`),
        topics.map((t) => pill(t, `${t} (${vids.filter((v) => v.topic === t).length})`))),
      shown.length ? el("div", { class: "videos" }, shown.map((v) => {
        const img = el("img", { src: `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`, alt: "", loading: "lazy", width: "320", height: "180" });
        return el("a", { class: "video", href: `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`, target: "_blank", rel: "noopener noreferrer" },
          el("div", { class: "thumb" }, img, v.gap ? el("span", { class: "gap-badge" }, `fills gap: ${v.gap}`) : null),
          el("div", { class: "v-body" }, el("div", { class: "v-title" }, v.title),
            el("div", { class: "v-meta" }, el("span", {}, v.channel), el("span", {}, `${views(v.views)} views`), el("span", {}, agoLabel(v.published))),
            el("span", { class: "chip" }, v.topic)));
      })) : el("div", { class: "empty" }, "Videos appear after the next scan (refreshed about twice a day)."));
  }

  // ------------------------------------------------------------------ Settings
  function renderSettings(root) {
    const goal = el("input", { type: "number", min: "1", max: "50", value: String(S.local.goal || 5), "aria-label": "Daily application goal" });
    const repo = el("input", { type: "text", value: S.local.repo || "", placeholder: "owner/job-radar", "aria-label": "Private repository" });
    const token = el("input", { type: "password", value: S.local.token ? "••••••••" : "", placeholder: "github_pat_...", autocomplete: "off", "aria-label": "GitHub token" });
    const status = el("p", { role: "status" }, S.local.lastSync ? `Last sync ${agoLabel(S.local.lastSync)}.` : "Not synced yet.");
    const saveSettings = async () => {
      S.local.goal = Math.max(1, Math.min(50, Number(goal.value) || 5));
      S.local.repo = repo.value.trim();
      if (token.value && !token.value.startsWith("•")) S.local.token = token.value.trim();
      await saveLocal();
      toast("Saved (encrypted on this device)");
      render();
    };
    const test = async () => {
      status.textContent = "Testing...";
      try {
        const r = await fetch(`https://api.github.com/repos/${S.local.repo}/actions/workflows/update-status.yml`,
          { headers: { Authorization: `Bearer ${S.local.token}`, Accept: "application/vnd.github+json" } });
        status.textContent = r.ok ? "Connection works. Status changes will sync automatically." : `GitHub said ${r.status}. Check the token's repository and Actions permission.`;
      } catch (_) { status.textContent = "Network error."; }
    };
    const exportMine = () => {
      const rows = S.jobs.filter((j) => statusOf(j) !== "new").map((j) => ({ title: j.title, company: j.company, status: statusOf(j), url: j.url }));
      const blob = new Blob([JSON.stringify(rows, null, 1)], { type: "application/json" });
      const a = el("a", { download: "job-radar-statuses.json" }); a.href = URL.createObjectURL(blob); a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    const gm = S.data.gmail || {};
    const scriptUrl = new URL("autofill.user.js", location.href).href;
    root.append(el("div", { class: "settings" },
      el("div", { class: "box" }, el("h3", {}, "Daily goal"), el("p", {}, "Applications per day. Drives the Today progress bar, streak and the goal line in Insights."),
        goal, el("div", { class: "row" }, el("button", { class: "btn primary", type: "button", onclick: saveSettings }, "Save"))),
      el("div", { class: "box" }, el("h3", {}, "Sync across devices and browsers"),
        el("p", {}, "Each browser keeps its own copy of your marks. With a token, every change (Applied, Shortlisted, notes) is sent to your private job-radar repo, and the dashboard is rebuilt in about 2-3 minutes. Then any browser, phone or Google profile shows the same thing after pressing Refresh."),
        el("p", {}, "Create a fine-grained token: GitHub, Settings, Developer settings, Fine-grained tokens, Generate. Repository access: only job-radar. Permissions: Actions read and write. Nothing else."),
        el("label", {}, "Repository", repo), el("label", {}, "Token", token),
        el("div", { class: "row" }, el("button", { class: "btn primary", type: "button", onclick: saveSettings }, "Save"),
          el("button", { class: "btn", type: "button", onclick: test, disabled: !S.local.token }, "Test"),
          el("button", { class: "btn", type: "button", onclick: () => sync(false), disabled: !S.local.token }, `Sync now (${pendingChanges().length})`),
          S.local.token ? el("button", { class: "btn", type: "button", onclick: async () => { S.local.token = ""; await saveLocal(); render(); } }, "Remove token") : null),
        status),
      el("div", { class: "box" }, el("h3", {}, "Gmail status sync (read-only)"),
        el("p", {}, gm.last_sync
          ? `Last checked ${agoLabel(gm.last_sync)}: read ${gm.stats?.read ?? 0} hiring emails, updated ${gm.stats?.updated ?? 0} jobs, skipped ${gm.stats?.skipped ?? 0}.`
          : "Not connected yet. See README, \"Gmail status sync\"."),
        el("p", {}, "Only jobs you already marked Applied / Shortlisted / Interview can change, and only when the email clearly matches that job. The token is read-only: it cannot delete, move, label or send anything.")),
      el("div", { class: "box" }, el("h3", {}, "Resume"),
        el("p", {}, "Every job has a tailored version in its details. This prints your standard resume in the same layout (edit profile/resume.yaml to change it)."),
        el("div", { class: "row" }, el("button", { class: "btn", type: "button", onclick: () => printResume(null) }, "⬇ Download standard resume (PDF)"))),
      el("div", { class: "box" }, el("h3", {}, "Autofill for Greenhouse, Lever and Ashby"),
        el("p", {}, "Install Tampermonkey in your browser, then open the link below and click Install. On an application form, click \"⚡ Fill my details\". It never submits, never uploads, and never runs on LinkedIn or job boards."),
        el("div", { class: "row" }, extLink("Install autofill script ↗", scriptUrl, "btn primary"))),
      el("div", { class: "box" }, el("h3", {}, "Privacy"),
        el("p", {}, "Your passphrase never leaves this browser and is forgotten when you lock, close the tab, or after 15 minutes idle. The token above is saved here encrypted with your passphrase. \"Export my statuses\" downloads your list as a file. \"Clear this device\" removes the token and unsynced marks from this browser only."),
        el("div", { class: "row" }, el("button", { class: "btn", type: "button", onclick: exportMine }, "Export my statuses"),
          el("button", { class: "btn", type: "button", onclick: () => { if (confirm("Delete saved settings, token and unsynced marks from this device?")) { try { localStorage.removeItem(LS.local); localStorage.removeItem(LS.salt); } catch (_) { /* fine */ } lock(); } } }, "Clear this device")))));
  }

  // ------------------------------------------------------------------ service worker (offline shell)
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
