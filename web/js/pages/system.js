/** System: live pipeline diagram (from activity.tick), p95 latency, funnel and token usage. */
import { S, CAM_IDS, camName, usageBuckets } from "../state.js";
import { $, svg, text, tween, fmtInt, fmtCompact, camNum, isNum } from "../util.js";
import { ago, stageState } from "../ui/strip.js";

const VB = { w: 1700, h: 400 };
const NODES = {
  "cam-01": [120, 110], "cam-02": [120, 205], "cam-03": [120, 300],
  decode: [345, 205], yolo: [525, 205], bytetrack: [705, 205],
  sam: [890, 105], weapons: [890, 205], clip: [890, 305],
  muse: [1135, 205], elevenlabs: [1395, 105], signalwire: [1395, 215], stream: [1395, 325],
};
const BIG = { muse: [232, 120] };
const EDGES = [
  ["cam-01", "decode"], ["cam-02", "decode"], ["cam-03", "decode"], ["decode", "yolo"], ["yolo", "bytetrack"],
  ["bytetrack", "sam"], ["bytetrack", "clip"], ["sam", "weapons"], ["weapons", "muse"], ["clip", "muse"],
  ["muse", "elevenlabs"], ["elevenlabs", "signalwire"], ["signalwire", "911"], ["bytetrack", "stream"],
];
const ZONES = [["On-prem · cameras", 12, 228], ["Edge GPU · site server", 248, 990], ["Cloud · model API", 1012, 1262], ["Voice · telephony · viewers", 1282, 1690]];
const size = (id) => BIG[id] || (id.startsWith("cam") ? [196, 66] : [168, 82]);

let nodeEls = {}, edgeEls = [];

export function mountSystem() {
  const root = svg("svg", { viewBox: `0 0 ${VB.w} ${VB.h}`, class: "diagram", preserveAspectRatio: "xMidYMid meet" }, $("sys-diagram"));
  for (const [name, x0, x1] of ZONES) {
    svg("rect", { x: x0, y: 8, width: x1 - x0, height: VB.h - 16, rx: 10, class: "zone" }, root);
    svg("text", { x: x0 + 14, y: 30, class: "zone-tx" }, root).textContent = name.toUpperCase();
  }
  const eg = svg("g", { class: "edges" }, root);
  for (const [a, b] of EDGES) {
    const [ax, ay] = NODES[a], [bx, by] = b === "911" ? [1600, 215] : NODES[b];
    const sx = ax + size(a)[0] / 2, tx = b === "911" ? bx - 30 : bx - size(b)[0] / 2;
    const mx = (sx + tx) / 2;
    const d = `M${sx} ${ay}C${mx} ${ay} ${mx} ${by} ${tx} ${by}`;
    const g = svg("g", { class: "edge" }, eg);
    const p = svg("path", { d, id: `e-${a}-${b}` }, g);
    for (let i = 0; i < 2; i++) {
      const c = svg("circle", { r: 4, class: "packet" }, g);
      const m = svg("animateMotion", { dur: "1.6s", repeatCount: "indefinite", begin: `${i * 0.8}s` }, c);
      svg("mpath", { href: `#e-${a}-${b}` }, m);
    }
    edgeEls.push({ a, b, g, p });
  }
  const ng = svg("g", { class: "nodes" }, root);
  for (const id in NODES) {
    const [cx, cy] = NODES[id], [w, hgt] = size(id);
    const g = svg("g", { class: "node", transform: `translate(${cx - w / 2} ${cy - hgt / 2})` }, ng);
    svg("rect", { width: w, height: hgt, rx: 8, class: "nbox" }, g);
    svg("circle", { cx: w - 14, cy: 16, r: 4.5, class: "ndot" }, g);
    const t = (cls, y, x = 12) => svg("text", { x, y, class: cls }, g);
    nodeEls[id] = { g, w, name: t("nname", 24), role: t("nrole", 41), val: t("nval", hgt - 14), extra: id === "muse" ? t("nval2", hgt - 36) : null };
  }
  const n911 = svg("g", { class: "n911", transform: "translate(1600 215)" }, root);
  svg("circle", { r: 34, class: "ring911" }, n911);
  svg("circle", { r: 26 }, n911);
  svg("text", { y: 6 }, n911).textContent = "911";
  nodeEls["911"] = { g: n911 };
}

export function renderSystem() {
  const stages = Object.fromEntries((S.activity || []).map((s) => [s.id, s]));
  const hs = S.health;
  const online = CAM_IDS.filter((id) => S.online[id]).length;
  const offline = CAM_IDS.filter((id) => S.online[id] === false).length;
  text($("sys-eyebrow"), `System · ${S.mode ? "all models live" : "mode —"}`);
  $("sys-title").innerHTML = `${(S.activity || []).length || "—"} pipeline stages, ${online || "—"} cameras, <em class="${offline ? "bad" : ""}">${offline} offline</em>`;

  const kp = $("sys-kpis");
  if (!kp.children.length) {
    kp.innerHTML = ["Frames screened", "Escalated", "Tokens", "Requests", "Cameras", "p95 latency"].map((k, i) => `<div class="kpi"><span>${k}</span><b id="sk-${i}">—</b></div>`).join("");
  }
  tween($("sk-0"), hs?.frames_screened);
  tween($("sk-1"), hs?.frames_escalated);
  tween($("sk-2"), S.usage?.tokens, fmtCompact);
  tween($("sk-3"), S.usage?.requests);
  text($("sk-4"), hs ? `${hs.cameras_online}/${hs.cameras_total}` : "—");
  tween($("sk-5"), hs?.p95_ms, (v) => `${fmtInt(v)} ms`);

  for (const id in nodeEls) {
    const n = nodeEls[id];
    if (id === "911") {
      n.g.classList.toggle("on", (stages.signalwire?.count || 0) > 0);
      continue;
    }
    if (id.startsWith("cam")) {
      const on = S.online[id];
      n.g.setAttribute("class", `node cam ${on === false ? "off" : on ? "ok" : ""}`);
      text(n.name, fit(`CAM ${camNum(id)} · ${camName(id)}`, n.w - 14, 7));
      text(n.role, on === false ? "offline" : on ? "online" : "—");
      text(n.val, typeof S.lastPeople[id] === "number" ? `${S.lastPeople[id]} in view` : "—");
      continue;
    }
    const st = stages[id];
    n.g.setAttribute("class", `node ${st ? stageState(st) : "unk"}`);
    text(n.name, st?.name || id);
    text(n.role, fit(st?.role || "—", n.w));
    text(n.val, st ? `${st.count ?? "—"} ${st.unit} · ${ago(st.last_s)}` : "—");
    if (n.extra) {
      const last = usageBuckets().filter(museOf).at(-1);
      const mu = museOf(last);
      text(n.extra, mu ? `${fmtInt(mu.requests)} req · ${fmtCompact(museTokens(mu))} tok · bucket ${new Date(last.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : "— req (no bucket yet)");
    }
  }
  for (const e of edgeEls) {
    const tgt = e.b === "911" ? stages.signalwire : e.b.startsWith("cam") ? null : stages[e.b];
    const src = e.a.startsWith("cam") ? S.online[e.a] : true;
    e.g.classList.toggle("live", !!(src && tgt && stageState(tgt) === "busy"));
  }

  renderLatency();
  renderFunnel();
  renderTokens();
}

function renderLatency() {
  const pts = S.p95Hist;
  const el = $("lat-chart");
  text($("lat-meta"), pts.length ? `last ${fmtInt(pts.at(-1).v)} ms · ${pts.length} samples` : "waiting for health.strip");
  if (el.dataset.n === String(pts.length)) return;
  el.dataset.n = pts.length;
  if (pts.length < 2) { el.innerHTML = '<p class="dim pad">Collecting p95 samples…</p>'; return; }
  const W = 600, H = 200, P = 34;
  const max = Math.max(...pts.map((p) => p.v)) * 1.15 || 1;
  const t0 = pts[0].t, t1 = pts.at(-1).t || t0 + 1;
  const xy = pts.map((p) => [P + ((p.t - t0) / Math.max(1, t1 - t0)) * (W - P - 8), H - 22 - (p.v / max) * (H - 40)]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
  const last = xy.at(-1);
  const fmtT = (t) => new Date(t).toLocaleTimeString("en-GB", { hour12: false });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="lat">
    <defs><linearGradient id="lat-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--ice)" stop-opacity=".35"/><stop offset="1" stop-color="var(--ice)" stop-opacity="0"/></linearGradient></defs>
    ${[0, 0.5, 1].map((k) => `<path d="M${P} ${H - 22 - k * (H - 40)}H${W - 8}" class="gl"/><text x="${P - 6}" y="${H - 18 - k * (H - 40)}" class="ax" text-anchor="end">${fmtInt(max * k)}</text>`).join("")}
    <path d="${line}L${last[0]} ${H - 22}L${P} ${H - 22}Z" fill="url(#lat-g)"/>
    <path d="${line}" class="ln"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="4" class="pt"/>
    <text x="${P}" y="${H - 4}" class="ax">${fmtT(t0)}</text><text x="${W - 8}" y="${H - 4}" class="ax" text-anchor="end">${fmtT(t1)}</text>
  </svg>`;
}

function renderFunnel() {
  const hs = S.health;
  const incs = [...S.incidents.values()];
  const calls = incs.filter((i) => (S.events.get(i.incident_id) || []).some((e) => e.state === "DISPATCHED")).length;
  const rows = [
    ["Frames screened", hs?.frames_screened, "YOLO26s-pose"],
    ["Frames escalated", hs?.frames_escalated, "to SAM 3.1 / Muse"],
    ["Incidents raised", S.incidents.size, "since last reset"],
    ["911 calls placed", calls, "since last reset"],
  ];
  const max = Math.log10(Math.max(10, ...rows.map((r) => r[1] || 0)) + 1);
  const el = $("funnel");
  if (!el.children.length) {
    el.innerHTML = rows.map((r, i) => `<div class="fr" style="--i:${i}"><span>${r[0]}<small>${r[2]}</small></span><i><b></b></i><em id="fn-${i}">—</em></div>`).join("") +
      '<p class="dim small">Bar length is log scale. Cheap detectors screen every frame; the expensive reasoning runs only on what they escalate.</p>';
  }
  rows.forEach((r, i) => {
    tween($(`fn-${i}`), r[1]);
    el.children[i].querySelector("b").style.width = isNum(r[1]) && r[1] > 0 ? `${(Math.log10(r[1] + 1) / max) * 100}%` : "0";
  });
}

const museOf = (tick) => Object.entries(tick?.by_model || {}).find(([k]) => /muse/i.test(k))?.[1] || null;
const museTokens = (m) => (m?.tokens_in || 0) + (m?.tokens_out || 0);
/** Truncate an SVG label to the node width (mono ~0.6em per char at 8.5px). */
const fit = (s, w, cw = 5.1) => { const n = Math.floor((w - 22) / cw); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

function renderTokens() {
  const u = S.usage;
  const el = $("tokens");
  text($("tok-meta"), u ? `${fmtInt(u.requests)} requests this session` : "—");
  const C = 2 * Math.PI * 52;
  if (!el.children.length) {
    el.innerHTML = `<div class="tok-top"><div class="donut"><svg viewBox="0 0 130 130"><circle cx="65" cy="65" r="52" class="d-bg"/><circle cx="65" cy="65" r="52" class="d-in" stroke-dasharray="0 ${C}"/><circle cx="65" cy="65" r="52" class="d-out" stroke-dasharray="0 ${C}"/></svg><div><b id="tok-total">—</b><span>tokens</span></div></div>
      <div class="tok-legend"><div><i class="in"></i>Prompt (in)<b id="tok-in">—</b></div><div><i class="out"></i>Completion (out)<b id="tok-out">—</b></div></div></div>
      <div class="buckets"><span class="lbl" id="bk-lbl">Muse tokens per 5 min</span><div class="bk-bars" id="bk-bars"></div><div class="bk-axis"><span id="bk-t0"></span><span id="bk-t1"></span></div></div>`;
  }
  tween($("tok-total"), u?.tokens, fmtCompact);
  tween($("tok-in"), u?.tokens_in);
  tween($("tok-out"), u?.tokens_out);
  if (u?.tokens) {
    const a = (u.tokens_in / u.tokens) * C, b = (u.tokens_out / u.tokens) * C;
    el.querySelector(".d-in").setAttribute("stroke-dasharray", `${a} ${C}`);
    const out = el.querySelector(".d-out");
    out.setAttribute("stroke-dasharray", `${b} ${C}`);
    out.setAttribute("stroke-dashoffset", -a);
  }
  const buckets = usageBuckets().slice(-16);
  const bars = $("bk-bars");
  if (bars.dataset.key === buckets.map((b) => b.ts + museTokens(museOf(b))).join()) return;
  bars.dataset.key = buckets.map((b) => b.ts + museTokens(museOf(b))).join();
  const max = Math.max(1, ...buckets.map((b) => museTokens(museOf(b))));
  bars.innerHTML = buckets.map((b, i) => {
    const m = museOf(b), v = museTokens(m);
    return `<i style="--h:${(v / max) * 100}%;--i:${i}" title="${new Date(b.ts).toLocaleTimeString("en-GB", { hour12: false })} · ${fmtInt(v)} tokens · ${fmtInt(m?.requests || 0)} requests"></i>`;
  }).join("");
  const hhmm = (t) => (t ? new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");
  text($("bk-lbl"), buckets.length ? `Muse tokens per ${Math.round(Math.max(...buckets.map((b) => b.window_s || 0)) / 60) || "—"} min · peak ${fmtCompact(max)}` : "Muse tokens per bucket · waiting");
  text($("bk-t0"), hhmm(buckets[0]?.ts));
  text($("bk-t1"), hhmm(buckets.at(-1)?.ts));
}
