/** Top bar (clock, mode, stream, incident pill) and the incident fuse band with KPIs. */
import { S, STATES, current, callStatus } from "../state.js";
import { $, h, text, tween, fmtCompact, fmtInt, ms, mmss, camNum, shortId, clockOf } from "../util.js";

const LABEL = { NEW: "New", ALERTED: "Alerted", DISPATCH_PENDING: "Dispatch pending", DISPATCHED: "Dispatched", TRACKING: "Tracking", RESOLVED: "Resolved" };
const IDLE_SUB = { NEW: "detect", ALERTED: "verify", DISPATCH_PENDING: "policy", DISPATCHED: "911 call", TRACKING: "follow", RESOLVED: "close" };
let cells = [];
let lastState = null;

export function mountTopbar() {
  const ol = $("fuse-states");
  cells = STATES.map((st) => {
    const li = h("li", "fs", `<i class="node"></i><b>${LABEL[st]}</b><span class="sub"></span>`);
    ol.appendChild(li);
    return li;
  });
  ol.appendChild(h("div", "burn", '<div class="burn-fill"><i class="ember"></i></div>'));
}

/** Every second: wall clock + incident clock. */
export function tickTopbar() {
  const now = new Date();
  text($("clock-time"), now.toLocaleTimeString("en-GB", { hour12: false }));
  text($("clock-date"), now.toLocaleDateString("en-US", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase());
  const inc = current();
  text($("fuse-t"), inc ? `T+${mmss((Date.now() - ms(inc.created_at)) / 1000)}` : "STANDBY");
}

export function renderTopbar() {
  const inc = current();
  const severe = inc?.severity === "SEVERE";
  document.body.classList.toggle("incident", !!inc);
  document.body.classList.toggle("severe", severe);

  // Mode pill: LIVE once /api/mode answers.
  const mode = $("mode");
  text(mode, S.mode ? "LIVE" : "—");
  mode.className = `mode ${S.mode ? "live" : ""}`;
  const conn = $("conn");
  conn.className = `conn ${S.conn}`;
  text($("conn-text"), S.conn === "live" ? "STREAM" : S.conn === "connecting" ? "CONNECTING" : "OFFLINE");

  const pill = $("inc-pill");
  pill.className = `inc-pill ${inc ? (severe ? "severe" : "minor") : "calm"}`;
  const onlineN = Object.values(S.online).filter(Boolean).length;
  text($("inc-pill-text"), inc
    ? `INC-${shortId(inc.incident_id)} · ${inc.class_token || "—"} · ${inc.severity} · CAM ${camNum(inc.camera_id)}`
    : S.conn === "live" ? `ALL CLEAR · watching ${onlineN || "—"} camera${onlineN === 1 ? "" : "s"}` : "Connecting to Sentinel…");

  const call = callStatus(inc);
  $("tab-call-live").classList.toggle("on", call?.state === "live" || call?.state === "connecting");

  renderFuse(inc);
  renderKpis();
}

function renderFuse(inc) {
  const fuse = $("fuse");
  const dismissed = inc?.state === "DISMISSED";
  const idx = inc ? STATES.indexOf(inc.state) : -1;
  fuse.classList.toggle("lit", !!inc);
  fuse.classList.toggle("severe", inc?.severity === "SEVERE");
  if (inc && inc.state !== lastState && lastState !== null) {
    fuse.classList.remove("ignite");
    void fuse.offsetWidth;
    fuse.classList.add("ignite");
  }
  lastState = inc?.state ?? null;
  const evs = inc ? S.events.get(inc.incident_id) || [] : [];
  const t0 = inc ? ms(inc.created_at) : 0;
  cells.forEach((li, i) => {
    const st = STATES[i];
    const ev = evs.find((e) => e.state === st);
    const status = !inc ? "idle" : i < idx ? (ev ? "done" : "skipped") : i === idx ? "cur" : "todo";
    li.className = `fs ${status}`;
    let sub = IDLE_SUB[st];
    if (inc && ev) sub = [i ? `+${mmss((ms(ev.ts) - t0) / 1000)}` : clockOf(ev.ts), noteOf(st, ev, inc)].filter(Boolean).join(" · ");
    else if (inc && status === "skipped") sub = "skipped";
    else if (inc) sub = i === idx ? "now" : "—";
    text(li.querySelector(".sub"), sub);
  });
  if (dismissed) text(cells[5].querySelector("b"), "Dismissed");
  else text(cells[5].querySelector("b"), LABEL.RESOLVED);
  const pos = !inc ? 0 : dismissed ? 1 : idx < 0 ? 0 : (idx + 0.5) / STATES.length;
  fuse.querySelector(".burn-fill").style.width = `${pos * 100}%`;
}

function noteOf(st, ev, inc) {
  const route = S.routes.get(inc.incident_id) || [];
  if (st === "NEW") return `cam ${camNum(route[0]?.cam || inc.camera_id)}`;
  if (st === "TRACKING") return `${Math.max(0, route.length - 1)} handoffs`;
  return ev.note && ev.note !== st ? ev.note.slice(0, 24) : "";
}

function renderKpis() {
  const hs = S.health;
  text($("k-cams"), hs ? `${hs.cameras_online}/${hs.cameras_total}` : "—");
  tween($("k-screened"), hs?.frames_screened);
  tween($("k-escalated"), hs?.frames_escalated);
  tween($("k-p95"), hs?.p95_ms, (v) => `${fmtInt(v)} ms`);
  tween($("k-tokens"), S.usage?.tokens, fmtCompact);
}
