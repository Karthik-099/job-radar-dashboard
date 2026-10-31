// Map tab: a draggable 3D globe. The satellite layer (NASA Blue Marble) is drawn on the GPU by a tiny WebGL shader
// that uses the same orthographic projection as d3; a transparent canvas on top draws borders, job heat and the
// selected country. While you drag or zoom the overlay uses coarse borders (1:110m) at 1x pixels, and redraws in
// full detail (1:50m) when you stop, so interaction stays smooth. No WebGL -> a vector globe instead.
// Loaded only when the Map tab opens. Untrusted text is only ever set via textContent (helpers from app.js).
"use strict";
(() => {
  const ALIASES = { usa: "840", "united states": "840", us: "840", uk: "826", "united kingdom": "826", "great britain": "826",
    uae: "784", "united arab emirates": "784", czechia: "203", "czech republic": "203", "south korea": "410", korea: "410",
    "saudi arabia": "682", russia: "643", vietnam: "704", "hong kong": "344", taiwan: "158", iran: "364", netherlands: "528",
    "the netherlands": "528", turkey: "792", "türkiye": "792", india: "356" };
  // Industries most likely to hire DevOps/SRE/platform engineers come first.
  const INDUSTRY_RANK = { cloud: 0, software: 1, "IT services": 2, internet: 3, semiconductors: 4, "e-commerce": 5, fintech: 6,
    "video games": 7, telecom: 8, consulting: 9, "banking & finance": 10 };
  const STYLE_KEY = "jr.globe";
  let state = null;

  const norm = (s) => String(s || "").toLowerCase().replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|gmbh|group|plc|s\.?a\.?|ag|technologies|technology|india)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
  const flag = (iso2) => (iso2 && /^[A-Z]{2}$/.test(iso2) ? String.fromCodePoint(...[...iso2].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "🌐");
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ver = (src) => { const b = document.querySelector('meta[name="jr-build"]')?.content; return b ? `${src}?v=${b}` : src; };

  function countryKeyFor(job, byName) {
    if (job.region === "india") return "356";
    const c = String(job.country || "").toLowerCase().trim();
    return ALIASES[c] || byName.get(c) || null;
  }

  // ---------------------------------------------------------------- WebGL satellite layer
  // Per pixel: screen -> orthographic sphere point -> undo d3's rotation [lambda, phi] -> lon/lat -> texture.
  const VERT = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";
  const FRAG = `precision highp float;
    uniform sampler2D tex; uniform vec2 center; uniform float radius; uniform float dl; uniform float dp;
    const float PI = 3.14159265359;
    void main() {
      vec2 q = (gl_FragCoord.xy - center) / radius;
      float d2 = dot(q, q);
      if (d2 > 1.0) {                      // thin atmosphere glow just outside the disc
        float a = smoothstep(1.09, 1.0, sqrt(d2));
        gl_FragColor = vec4(0.35, 0.6, 1.0, 0.0) + vec4(0.0, 0.0, 0.0, 0.5 * a * a);
        gl_FragColor.rgb *= gl_FragColor.a; return;
      }
      float edge = smoothstep(1.0, 1.0 - 2.5 / radius, sqrt(d2));  // anti-aliased rim (no MSAA needed)
      float zr = sqrt(1.0 - d2);
      float lr = atan(q.x, zr), pr = asin(clamp(q.y, -1.0, 1.0));
      float x = cos(lr) * cos(pr), y = sin(lr) * cos(pr), z = sin(pr);
      float lon = atan(y, x * cos(dp) + z * sin(dp)) - dl;
      float lat = asin(clamp(z * cos(dp) - x * sin(dp), -1.0, 1.0));
      vec2 uv = vec2(fract(lon / (2.0 * PI) + 0.5), 0.5 - lat / PI);
      vec3 c = texture2D(tex, uv).rgb;
      float light = 0.55 + 0.45 * zr;     // soft limb darkening for depth
      c = c * light + vec3(0.06, 0.12, 0.25) * pow(1.0 - zr, 3.0);
      gl_FragColor = vec4(c * edge, edge);
    }`;
  function satellite(canvas) {
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
    const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = Object.fromEntries(["center", "radius", "dl", "dp", "tex"].map((n) => [n, gl.getUniformLocation(prog, n)]));
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 40, 80, 255]));
    let ready = false;
    const load = (src) => new Promise((ok) => {
      const img = new Image();
      img.onload = () => {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        ready = true; ok(true);
      };
      img.onerror = () => ok(false);
      img.src = src;
    });
    return {
      // Small texture first (fast), the sharp one swapped in afterwards for zooming.
      load: async (onReady) => { if (await load(ver("vendor/earth-2k.jpg"))) onReady(); if (await load(ver("vendor/earth-4k.jpg"))) onReady(); },
      ready: () => ready,
      draw(w, h, dpr, [tx, ty], r, [lambda, phi]) {
        gl.viewport(0, 0, w * dpr, h * dpr);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(u.center, tx * dpr, (h - ty) * dpr);
        gl.uniform1f(u.radius, r * dpr);
        gl.uniform1f(u.dl, (lambda * Math.PI) / 180);
        gl.uniform1f(u.dp, (phi * Math.PI) / 180);
        gl.uniform1i(u.tex, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      },
    };
  }

  async function mount(host, ctx) {
    unmount();
    const { el, extLink, fmtInt } = ctx;
    const [topo, topoLow] = await Promise.all([fetch(ver("vendor/countries-50m.json")).then((r) => r.json()),
      fetch(ver("vendor/countries-110m.json")).then((r) => r.json())]);
    const features = topojson.feature(topo, topo.objects.countries).features;
    const coarse = topojson.feature(topoLow, topoLow.objects.countries).features;
    const borders = topojson.mesh(topo, topo.objects.countries, (a, b) => a !== b);
    const bordersLow = topojson.mesh(topoLow, topoLow.objects.countries, (a, b) => a !== b);
    const keyOf = (f) => (f.id != null && f.id !== "" ? String(f.id) : f.properties.name);
    const world = ctx.world.countries || {};
    const nameOf = (k, f) => world[k]?.name || f?.properties?.name || k;
    const byName = new Map();
    for (const f of features) byName.set(nameOf(keyOf(f), f).toLowerCase(), keyOf(f));
    for (const [k, v] of Object.entries(world)) { byName.set(String(v.name || "").toLowerCase(), k); if (v.iso2) byName.set(v.iso2.toLowerCase(), k); }

    // Your data per country: open matching jobs and applications.
    const stats = new Map();
    for (const j of ctx.jobs) {
      const k = countryKeyFor(j, byName);
      if (!k) continue;
      const s = stats.get(k) || { open: [], applied: 0 };
      if (ctx.statusOf(j) === "new") s.open.push(j); else s.applied += 1;
      stats.set(k, s);
    }
    const maxOpen = Math.max(1, ...[...stats.values()].map((s) => s.open.length));
    const hot = (list) => list.filter((f) => stats.get(keyOf(f))?.open.length);
    const hotFine = hot(features), hotCoarse = hot(coarse);

    // ---------------------------------------------------------------- layout
    const sat = el("canvas", { class: "globe sat", "aria-hidden": "true" });
    const canvas = el("canvas", { class: "globe overlay", role: "img", "aria-label": "Globe of countries; use the country search to choose one with the keyboard" });
    const stage = el("div", { class: "globe-stage" }, sat, canvas);
    const tip = el("div", { class: "globe-tip hidden" });
    const search = el("input", { type: "search", class: "search", list: "jr-countries", placeholder: "Find a country…", "aria-label": "Find a country" });
    const options = el("datalist", { id: "jr-countries" }, features.map((f) => nameOf(keyOf(f), f)).sort().map((n) => el("option", { value: n })));
    let style = "satellite";
    try { style = localStorage.getItem(STYLE_KEY) || "satellite"; } catch (_) { /* default */ }
    const styleBtn = el("button", { class: "btn small ghost", type: "button", title: "Switch between satellite and map style" });
    const legend = el("div", { class: "legend globe-legend" }, el("span", {}, el("i", { class: "lg hot" }), "many matching jobs"),
      el("span", {}, el("i", { class: "lg warm" }), "some"), el("span", {}, el("i", { class: "lg sel" }), "selected"),
      el("span", { class: "credit" }, "Imagery: NASA Blue Marble"));
    const panel = el("div", { class: "country-panel" });
    host.replaceChildren(el("div", { class: "map-layout" },
      el("div", { class: "globe-wrap" }, el("div", { class: "globe-tools" }, search, options, styleBtn,
        el("button", { class: "btn small ghost", type: "button", onclick: () => { select(null); spin = true; } }, "Reset")), stage, tip, legend),
      panel));

    // ---------------------------------------------------------------- globe state
    const g = canvas.getContext("2d");
    const projection = d3.geoOrthographic().clipAngle(90).precision(0.7).rotate([-78, -20]);
    const path = d3.geoPath(projection, g);
    const graticule = d3.geoGraticule10();
    const gpu = satellite(sat);
    if (!gpu) style = "map";
    let size = 0, scale = 1, selected = null, hovered = null, spin = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, anim = null, dirty = true, moving = false, idleTimer = 0, dpr = 1;
    const colors = {};
    function readColors() { for (const n of ["--ocean", "--ocean-2", "--land", "--land-line", "--heat-1", "--heat-2", "--heat-3", "--selected"]) colors[n] = css(n); }
    function setStyle(s) {
      style = gpu ? s : "map";
      try { localStorage.setItem(STYLE_KEY, style); } catch (_) { /* fine */ }
      styleBtn.textContent = style === "satellite" ? "Map style" : "Satellite";
      styleBtn.hidden = !gpu;
      sat.style.display = style === "satellite" ? "block" : "none";
      dirty = true;
    }
    styleBtn.addEventListener("click", () => setStyle(style === "satellite" ? "map" : "satellite"));
    function resize() {
      const w = Math.max(200, Math.min(stage.parentElement.clientWidth - 28, 760));
      size = w;
      for (const c of [sat, canvas]) { c.style.width = `${w}px`; c.style.height = `${w}px`; }
      stage.style.width = `${w}px`; stage.style.height = `${w}px`;
      projection.translate([w / 2, w / 2]).scale((w / 2 - 8) * scale);
      setDpr(moving ? 1 : Math.min(2, devicePixelRatio || 1));
    }
    function setDpr(d) {
      dpr = d;
      for (const c of [sat, canvas]) { c.width = Math.round(size * d); c.height = Math.round(size * d); }
      g.setTransform(d, 0, 0, d, 0, 0);
      dirty = true;
    }
    // Interaction: drop to coarse borders and 1x pixels; full detail 180 ms after the last movement.
    function touch() {
      if (!moving) { moving = true; if (dpr !== 1) setDpr(1); }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { moving = false; setDpr(Math.min(2, devicePixelRatio || 1)); }, 180);
      dirty = true;
    }
    function heat(k) {
      const n = stats.get(k)?.open.length || 0;
      if (!n) return null;
      const t = Math.sqrt(n / maxOpen);
      return t > 0.66 ? colors["--heat-3"] : t > 0.33 ? colors["--heat-2"] : colors["--heat-1"];
    }
    function draw() {
      const satOn = style === "satellite" && gpu;
      if (satOn) gpu.draw(size, size, dpr, projection.translate(), projection.scale(), projection.rotate());
      g.clearRect(0, 0, size, size);
      const coarseNow = moving || anim || (spin && !selected);
      if (!satOn) {
        const r = projection.scale(), [cx, cy] = projection.translate();
        const grad = g.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
        grad.addColorStop(0, colors["--ocean-2"]); grad.addColorStop(1, colors["--ocean"]);
        g.beginPath(); path({ type: "Sphere" }); g.fillStyle = grad; g.fill();
        g.beginPath(); path(graticule); g.strokeStyle = "rgba(255,255,255,.07)"; g.lineWidth = 0.6; g.stroke();
        g.beginPath(); for (const f of coarseNow ? coarse : features) path(f); g.fillStyle = colors["--land"]; g.fill();
      }
      // Job heat: translucent over the satellite image, solid on the map style.
      g.globalAlpha = satOn ? 0.5 : 1;
      for (const f of coarseNow ? hotCoarse : hotFine) { g.beginPath(); path(f); g.fillStyle = heat(keyOf(f)); g.fill(); }
      g.globalAlpha = 1;
      g.beginPath(); path(coarseNow ? bordersLow : borders);
      g.strokeStyle = satOn ? "rgba(255,255,255,.38)" : colors["--land-line"]; g.lineWidth = satOn ? 0.6 : 0.5; g.stroke();
      for (const [k, fill] of [[hovered, null], [selected, colors["--selected"]]]) {
        const f = k && features.find((x) => keyOf(x) === k);
        if (!f) continue;
        g.beginPath(); path(f);
        if (fill) { g.globalAlpha = satOn ? 0.55 : 0.9; g.fillStyle = fill; g.fill(); g.globalAlpha = 1; }
        g.strokeStyle = "#fff"; g.lineWidth = fill ? 1.6 : 1.1; g.stroke();
      }
      // Name label on the selected country (phones have no hover tooltip).
      const sf = selected && features.find((x) => keyOf(x) === selected);
      if (sf) {
        const c = d3.geoCentroid(sf), visible = d3.geoDistance(c, [-projection.rotate()[0], -projection.rotate()[1]]) < Math.PI / 2;
        const pt = visible && projection(c);
        if (pt) {
          const label = `${flag(world[selected]?.iso2)} ${nameOf(selected, sf)}`;
          g.font = "600 13px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
          const w = g.measureText(label).width + 16;
          g.fillStyle = "rgba(8, 12, 22, .82)"; g.beginPath(); g.roundRect(pt[0] - w / 2, pt[1] - 26, w, 22, 11); g.fill();
          g.fillStyle = "#fff"; g.fillText(label, pt[0], pt[1] - 15);
        }
      }
      if (satOn && !gpu.ready()) { g.fillStyle = "rgba(255,255,255,.7)"; g.font = "13px system-ui"; g.textAlign = "center"; g.fillText("Loading satellite imagery…", size / 2, size / 2); }
      dirty = false;
    }
    function loop() {
      if (anim) {
        const k = Math.min(1, (performance.now() - anim.t0) / anim.ms), e = 1 - (1 - k) ** 3;
        projection.rotate([anim.from[0] + (anim.to[0] - anim.from[0]) * e, anim.from[1] + (anim.to[1] - anim.from[1]) * e]);
        projection.scale(anim.s0 + (anim.s1 - anim.s0) * e);
        if (k === 1) { anim = null; touch(); }
        dirty = true;
      } else if (spin && !dragging && !selected) {
        const [l, p] = projection.rotate();
        projection.rotate([l + 0.1, p]);
        dirty = true;
      }
      if (dirty) draw();
      raf = requestAnimationFrame(loop);
    }
    function featureAt(evt) {
      const rect = canvas.getBoundingClientRect();
      const ll = projection.invert([evt.clientX - rect.left, evt.clientY - rect.top]);
      if (!ll || d3.geoDistance(ll, [-projection.rotate()[0], -projection.rotate()[1]]) > Math.PI / 2) return null;
      return features.find((f) => d3.geoContains(f, ll)) || null;
    }
    let dragging = false, moved = 0, last = null, hoverPending = null;
    canvas.addEventListener("pointerdown", (e) => { dragging = true; moved = 0; last = [e.clientX, e.clientY]; spin = false; anim = null; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => {
      if (dragging && last) {
        const dx = e.clientX - last[0], dy = e.clientY - last[1];
        moved += Math.abs(dx) + Math.abs(dy);
        last = [e.clientX, e.clientY];
        const [l, p] = projection.rotate(), k = 70 / projection.scale();
        projection.rotate([l + dx * k, Math.max(-85, Math.min(85, p - dy * k))]);
        touch();
        return;
      }
      if (hoverPending) return;          // hit-testing once per frame is plenty
      hoverPending = requestAnimationFrame(() => {
        hoverPending = null;
        const f = featureAt(e), k = f ? keyOf(f) : null;
        if (k !== hovered) { hovered = k; dirty = true; }
        if (f) {
          const s = stats.get(k);
          tip.textContent = `${flag(world[k]?.iso2)} ${nameOf(k, f)}${s?.open.length ? ` · ${s.open.length} matching job${s.open.length > 1 ? "s" : ""}` : ""}`;
          const wrap = stage.parentElement.getBoundingClientRect(); // tip is positioned inside .globe-wrap
          tip.style.left = `${e.clientX - wrap.left + 14}px`; tip.style.top = `${e.clientY - wrap.top + 12}px`;
          tip.classList.remove("hidden");
        } else tip.classList.add("hidden");
      });
    });
    canvas.addEventListener("pointerup", (e) => {
      if (dragging && moved < 5) { const f = featureAt(e); if (f) select(keyOf(f)); }
      dragging = false; last = null;
    });
    canvas.addEventListener("pointerleave", () => { hovered = null; tip.classList.add("hidden"); dirty = true; });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      scale = Math.max(0.8, Math.min(12, scale * Math.exp(-e.deltaY * 0.0015)));
      projection.scale((size / 2 - 8) * scale);
      touch();
    }, { passive: false });
    // Two-finger pinch on phones.
    const touches = new Map();
    let pinch0 = 0, scale0 = 1;
    canvas.addEventListener("touchstart", (e) => { for (const t of e.changedTouches) touches.set(t.identifier, t); if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch0 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); scale0 = scale; } }, { passive: true });
    canvas.addEventListener("touchmove", (e) => {
      for (const t of e.changedTouches) touches.set(t.identifier, t);
      if (touches.size === 2 && pinch0) {
        const [a, b] = [...touches.values()];
        scale = Math.max(0.8, Math.min(12, scale0 * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch0));
        projection.scale((size / 2 - 8) * scale); touch();
      }
    }, { passive: true });
    canvas.addEventListener("touchend", (e) => { for (const t of e.changedTouches) touches.delete(t.identifier); if (touches.size < 2) pinch0 = 0; }, { passive: true });
    search.addEventListener("change", () => {
      const k = byName.get(search.value.trim().toLowerCase());
      if (k) select(k);
    });
    function flyTo(k) {
      const f = features.find((x) => keyOf(x) === k);
      if (!f) return;
      const [lon, lat] = d3.geoCentroid(f), from = projection.rotate();
      let to0 = -lon;
      while (to0 - from[0] > 180) to0 -= 360;
      while (to0 - from[0] < -180) to0 += 360;
      const area = d3.geoArea(f);
      scale = area < 0.0005 ? 6 : area < 0.005 ? 3 : area < 0.03 ? 1.7 : 1.1;
      anim = { from: [from[0], from[1]], to: [to0, Math.max(-60, Math.min(60, -lat))], s0: projection.scale(), s1: (size / 2 - 8) * scale, t0: performance.now(), ms: 900 };
    }
    function select(k) {
      selected = k;
      spin = false;
      if (k) flyTo(k);
      else { scale = 1; anim = { from: projection.rotate(), to: projection.rotate(), s0: projection.scale(), s1: size / 2 - 8, t0: performance.now(), ms: 500 }; }
      renderPanel();
      dirty = true;
    }

    // ---------------------------------------------------------------- side panel
    function renderPanel() {
      if (!selected) {
        const top = [...stats.entries()].filter(([, s]) => s.open.length).sort((a, b) => b[1].open.length - a[1].open.length).slice(0, 12);
        panel.replaceChildren(el("h2", {}, "Where your jobs are"),
          el("p", { class: "sub" }, "Click a country on the globe, or pick one in the search box. Every country is listed, even the tiny ones."),
          top.length ? el("ul", { class: "country-rank" }, top.map(([k, s]) => el("li", {},
            el("button", { type: "button", onclick: () => select(k) }, `${flag(world[k]?.iso2)} ${world[k]?.name || k}`),
            el("span", { class: "count-pill" }, `${s.open.length} open`)))) : el("div", { class: "empty" }, "No matching jobs with a known country yet."));
        return;
      }
      const c = world[selected] || { name: nameOf(selected, features.find((f) => keyOf(f) === selected)), companies: [] };
      const s = stats.get(selected) || { open: [], applied: 0 };
      // Live roles grouped by company.
      const byCo = new Map();
      for (const j of s.open) { const k = norm(j.company); const x = byCo.get(k) || { name: j.company, jobs: [] }; x.jobs.push(j); byCo.set(k, x); }
      const groups = [...byCo.values()].sort((a, b) => Math.max(...b.jobs.map((j) => j.prio || 0)) - Math.max(...a.jobs.map((j) => j.prio || 0)));
      const hiring = new Set(byCo.keys());
      const employers = [...(c.companies || [])].sort((a, b) =>
        (hiring.has(norm(b.name)) - hiring.has(norm(a.name))) || ((INDUSTRY_RANK[a.industry] ?? 11) - (INDUSTRY_RANK[b.industry] ?? 11)) || ((b.employees || 0) - (a.employees || 0)));
      const country = c.name || "";
      panel.replaceChildren(
        el("div", { class: "cp-head" }, el("span", { class: "cp-flag" }, flag(c.iso2)), el("div", {}, el("h2", {}, country),
          el("div", { class: "sub" }, `${fmtInt(s.open.length)} matching open jobs · ${fmtInt(s.applied)} applications · ${fmtInt((c.companies || []).length)} major employers`))),
        el("h3", {}, "Hiring for your roles now"),
        groups.length ? el("ul", { class: "co-list" }, groups.slice(0, 15).map((gp) => el("li", {},
          el("div", { class: "co-name" }, gp.name, el("span", { class: "chip have" }, `${gp.jobs.length} role${gp.jobs.length > 1 ? "s" : ""}`)),
          el("div", { class: "co-jobs" }, gp.jobs.slice(0, 4).map((j) => el("button", { type: "button", class: "btn small ghost", onclick: () => ctx.openJob(j) },
            `${j.title}${j.score != null ? ` · fit ${Number(j.score).toFixed(1)}` : ""}`)))))) :
          el("p", { class: "sub" }, "No live matching roles here right now. The employers below are where to look."),
        el("h3", {}, "Top employers for DevOps / cloud roles"),
        el("p", { class: "sub" }, "Largest companies in software, cloud, IT services, internet, telecom, fintech and banking (Wikidata). Tech first; ✓ = hiring for your roles now."),
        employers.length ? el("ul", { class: "co-list" }, employers.map((e) => el("li", {},
          el("div", { class: "co-name" }, hiring.has(norm(e.name)) ? el("span", { class: "chip have" }, "✓ hiring") : null, e.name,
            el("span", { class: "chip" }, e.industry), e.employees ? el("span", { class: "sub" }, `${fmtInt(e.employees)} people`) : null),
          el("div", { class: "co-links" }, extLink("Website ↗", e.website, "btn small"),
            extLink("Careers search ↗", `https://www.google.com/search?q=${encodeURIComponent(`${e.name} careers DevOps OR SRE OR cloud ${country}`)}`, "btn small ghost"),
            extLink("Jobs on LinkedIn ↗", `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`${e.name} DevOps`)}&location=${encodeURIComponent(country)}`, "btn small ghost"))))) :
          el("div", { class: "empty" }, "No large tech employers recorded for this country."),
        el("p", { class: "sub" }, "Links open normal pages in your browser; nothing is automated on any site."));
    }

    readColors();
    setStyle(style);
    const ro = new ResizeObserver(resize);
    ro.observe(stage.parentElement);
    resize();
    renderPanel();
    if (gpu) gpu.load(() => { dirty = true; });
    raf = requestAnimationFrame(loop);
    state = { stop: () => { cancelAnimationFrame(raf); ro.disconnect(); clearTimeout(idleTimer); } };
  }
  function unmount() { state?.stop(); state = null; }

  window.JRMap = { mount, unmount };
})();
