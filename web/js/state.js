/** Single client-side store: folds WebSocket events + API polls into one state object. */
import { ms } from "./util.js";

export const STATES = ["NEW", "ALERTED", "DISPATCH_PENDING", "DISPATCHED", "TRACKING", "RESOLVED"];
const TERMINAL = new Set(["RESOLVED", "DISMISSED"]);
const CALL_STATES = new Set(["DISPATCHED", "TRACKING"]);
export const CAM_IDS = ["cam-01", "cam-02", "cam-03"];
const HIST_MAX = 600;

export const S = {
  conn: "connecting",
  site: null,
  cams: {},          // camera_id -> camera record from /api/site
  mode: null,        // /api/mode
  track: null,       // /api/track
  voice: null,       // /voice/status
  health: null,      // last health.strip
  p95Hist: [],       // [{t, v}] from health.strip
  activity: null,    // last activity.tick stages
  usage: null,       // last usage.total
  usageTicks: new Map(), // usage.tick ts -> tick (5-min buckets, replayed history + live)
  boxes: {},         // camera_id -> {t (client ms), boxes[]}
  online: {},        // camera_id -> bool
  incidents: new Map(),
  routes: new Map(),      // incident_id -> [{cam, ts}]
  rules: new Map(),       // incident_id -> Set of every rules_fired value seen
  events: new Map(),      // incident_id -> [{ts, state, note}] (timeline + state_change, deduped)
  transcripts: new Map(), // incident_id -> [{speaker, text, ts}]
  briefs: new Map(),      // incident_id -> last call.brief.brief
  blocked: null,          // {incidentId, reason, ts}
  focus: null,            // null (auto) | camera_id | "all"
  lastPeople: {},         // camera_id -> person count in last boxes frame
};

const subs = new Set();
let queued = false;
export const subscribe = (fn) => subs.add(fn);
/** Coalesce many events into one render per animation frame. */
export function changed() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    subs.forEach((fn) => fn(S));
  });
}

function pushEvent(id, ev) {
  const list = S.events.get(id) || [];
  if (!list.some((x) => x.state === ev.state && x.note === ev.note && Math.abs(ms(x.ts) - ms(ev.ts)) < 1500)) {
    list.push(ev);
    list.sort((a, b) => ms(a.ts) - ms(b.ts));
  }
  S.events.set(id, list);
}

function upsert(inc) {
  const id = inc.incident_id;
  if (!id) return;
  const prev = S.incidents.get(id);
  // A state_change can arrive before the next upsert; never move state backwards in the fuse.
  if (prev && STATES.indexOf(inc.state) < STATES.indexOf(prev.state) && !TERMINAL.has(inc.state)) {
    inc = { ...inc, state: prev.state };
  }
  S.incidents.set(id, inc);
  for (const ev of inc.timeline || []) pushEvent(id, ev);
  const route = S.routes.get(id) || [];
  if (inc.camera_id && route.at(-1)?.cam !== inc.camera_id) {
    route.push({ cam: inc.camera_id, ts: route.length ? inc.updated_at : inc.created_at });
  }
  S.routes.set(id, route);
  const rules = S.rules.get(id) || new Set();
  for (const r of inc.rules_fired || []) rules.add(r);
  S.rules.set(id, rules);
}

function clearSession() {
  S.incidents.clear();
  S.routes.clear();
  S.rules.clear();
  S.events.clear();
  S.transcripts.clear();
  S.briefs.clear();
  S.blocked = null;
  S.focus = null;
}

/** Fold one backend event into state. Overlay boxes skip the render queue (the video loop reads them). */
export function apply(e) {
  if (e.ok && e.cmd === "reset") { // ack of our own {"cmd":"reset"}
    clearSession();
    return changed();
  }
  switch (e.type) {
    case "overlay.boxes":
      S.boxes[e.camera_id] = { t: performance.now(), boxes: Array.isArray(e.boxes) ? e.boxes : [] };
      S.lastPeople[e.camera_id] = S.boxes[e.camera_id].boxes.filter((b) => b.label === "person").length;
      return;
    case "incident.upsert":
      if (e.incident) upsert(e.incident);
      break;
    case "incident.state_change": {
      const inc = S.incidents.get(e.incident_id);
      if (inc) S.incidents.set(e.incident_id, { ...inc, state: e.state, severity: e.severity || inc.severity, updated_at: e.ts });
      pushEvent(e.incident_id, { ts: e.ts, state: e.state, note: e.note || "" });
      break;
    }
    case "call.transcript_delta": {
      const list = S.transcripts.get(e.incident_id) || [];
      if (!list.some((l) => l.ts === e.ts && l.text === e.text)) list.push({ speaker: e.speaker, text: e.text, ts: e.ts });
      S.transcripts.set(e.incident_id, list);
      break;
    }
    case "call.brief":
      S.briefs.set(e.incident_id, { ...e.brief, reason: e.reason });
      break;
    case "health.strip":
      S.health = e;
      if (typeof e.p95_ms === "number") {
        S.p95Hist.push({ t: ms(e.ts) || Date.now(), v: e.p95_ms });
        if (S.p95Hist.length > HIST_MAX) S.p95Hist.shift();
      }
      break;
    case "activity.tick":
      S.activity = e.stages || null;
      break;
    case "usage.total":
      S.usage = e;
      break;
    case "usage.tick":
      S.usageTicks.set(e.ts, e);
      if (S.usageTicks.size > 48) S.usageTicks.delete(S.usageTicks.keys().next().value);
      break;
    case "camera.online":
      if (S.online[e.camera_id] === e.online) return;
      S.online[e.camera_id] = e.online;
      break;
    case "control":
      if (e.action === "reset") clearSession();
      else if (String(e.scenario_id || "").startsWith("dispatch_blocked:")) {
        const cur = current();
        S.blocked = { incidentId: cur?.incident_id, reason: e.scenario_id.split(":")[1], ts: e.ts };
      }
      break;
    default:
      return;
  }
  changed();
}

/** The incident the console is about: newest non-terminal one, else null (idle). */
export function current() {
  let best = null;
  for (const inc of S.incidents.values()) {
    if (TERMINAL.has(inc.state)) continue;
    if (!best || ms(inc.created_at) > ms(best.created_at)) best = inc;
  }
  return best;
}

/** Latest incident of any state (Evidence/Call pages keep showing it after it ends). */
export function latest() {
  let best = null;
  for (const inc of S.incidents.values()) if (!best || ms(inc.created_at) > ms(best.created_at)) best = inc;
  return best;
}

/** usage.tick buckets sorted oldest → newest. */
export const usageBuckets = () => [...S.usageTicks.values()].sort((a, b) => ms(a.ts) - ms(b.ts));

export const confidence = (inc) =>
  typeof inc?.class_logprob_calibrated === "number" ? Math.exp(inc.class_logprob_calibrated) : null;

export function camName(id) {
  const c = S.cams[id];
  if (!c) return id || "—";
  return (c.name || "").split(" / ").pop() || c.location || id;
}

/** Call status for an incident: null (no call), connecting, live, ended. */
export function callStatus(inc) {
  if (!inc) return null;
  const evs = S.events.get(inc.incident_id) || [];
  const started = evs.find((e) => e.state === "DISPATCHED");
  if (!started && !CALL_STATES.has(inc.state)) return null;
  const lines = S.transcripts.get(inc.incident_id) || [];
  const startTs = started?.ts || lines[0]?.ts || null;
  if (TERMINAL.has(inc.state)) return { state: "ended", startTs, endTs: inc.updated_at };
  return { state: lines.length ? "live" : "connecting", startTs };
}

/** Freshest weapon box (normalized) on a camera, else the armed/first person box. */
export function focusBox(camId, trackId) {
  const f = S.boxes[camId];
  if (!f || performance.now() - f.t > 3000) return null;
  const weapon = f.boxes.filter((b) => b.label === "weapon").sort((a, b) => b.score - a.score)[0];
  if (weapon) return { ...weapon, kind: "weapon" };
  const person = f.boxes.find((b) => b.track_id === trackId) || f.boxes.find((b) => b.label === "person");
  return person ? { ...person, kind: "person" } : null;
}
