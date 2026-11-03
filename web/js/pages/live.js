/** Live Ops: hero camera, thumbnails, incident card, site map, live call mini panel. */
import { S, CAM_IDS, current, latest, confidence, callStatus, camName } from "../state.js";
import { $, h, esc, text, icon, fmtConf, clockOf, camNum, shortId, mmss, ms } from "../util.js";
import { mountCam, lensInfo } from "../ui/camera.js";
import { mountMap, renderMap, pathText } from "../ui/sitemap.js";
import { mountActions, renderActions, setFocus } from "../ui/actions.js";
import { renderTranscript } from "../ui/transcript.js";
import { mountWave, setWave } from "../ui/wave.js";
import { go } from "../router.js";

export const CLASS_TITLE = { WEAPON: "Armed person", FIGHT: "Fight in progress", THEFT: "Theft", RUN: "Person running", MEDICAL: "Medical emergency", BENIGN: "Benign activity" };
const RING_C = 2 * Math.PI * 44;

let map, lens, actionsEl, wave;

/** Camera on the hero: operator focus, else the live incident's camera, else the lobby. */
export function heroCam() {
  if (S.focus && S.focus !== "all") return S.focus;
  return current()?.camera_id || "cam-01";
}

export function mountLive() {
  // Hero: single camera + 3-up "all cameras" mode.
  const heroEl = $("hero-cam");
  mountCam(heroEl, { cam: heroCam });
  heroEl.insertAdjacentHTML("beforeend", `
    <div class="hud-bl" id="hero-cap"></div>
    <div class="hud-br"><span class="chip" id="hero-follow">AUTO-FOLLOW</span><button class="chip btn" id="btn-all">${icon("grid")} VIEW ALL <kbd>A</kbd></button></div>
    <div class="scan" aria-hidden="true"></div>`);
  $("btn-all").addEventListener("click", () => setFocus("all"));
  for (const id of CAM_IDS) {
    const tile = h("div", "cam stage tile");
    $("hero-all").appendChild(tile);
    mountCam(tile, { cam: () => id });
    tile.addEventListener("click", () => setFocus(id));
  }
  for (const id of CAM_IDS) {
    const t = h("div", "thumb", `<div class="cam stage"></div><div class="thumb-foot"><kbd>${camNum(id)}</kbd><span class="tf-text"></span></div>`);
    t.dataset.cam = id;
    $("thumbs").appendChild(t);
    mountCam(t.querySelector(".cam"), { cam: () => id, tags: false });
    t.addEventListener("click", () => setFocus(id));
  }

  // Incident card (active + idle faces share one action grid).
  const card = $("inc-card");
  card.innerHTML = `
    <div class="ic-active">
      <div class="ic-top">
        <div class="ic-lens"><div class="cam lens" id="ic-lens"></div><span class="lens-tag" id="ic-lens-tag">live lens</span></div>
        <div class="ic-main">
          <div class="badges"><b class="b-class" id="ic-class"></b><b class="b-sev" id="ic-sev"></b><b class="b-state" id="ic-state"></b><span class="ic-id" id="ic-id"></span></div>
          <h2 id="ic-title"></h2>
          <p class="ic-meta" id="ic-meta"></p>
        </div>
        <div class="ring" id="ic-ring"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="ring-bg"/><circle cx="50" cy="50" r="44" class="ring-fg" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/></svg><b id="ic-conf">—</b><span>Confidence</span></div>
      </div>
      <div class="ic-desc"><span class="lbl">Description · clothing only · <em>no face ID</em></span><p id="ic-desc"></p></div>
      <div class="ic-verdict" id="ic-verdict"></div>
    </div>
    <div class="ic-idle">
      <svg viewBox="0 0 120 120" class="radar"><circle cx="60" cy="60" r="56"/><circle cx="60" cy="60" r="38"/><circle cx="60" cy="60" r="20"/><path d="M60 4V116M4 60H116" class="ax"/><g class="radar-sweep"><path d="M60 60L60 4A56 56 0 0 1 108 32Z"/></g><circle cx="60" cy="60" r="3" class="c"/></svg>
      <div><span class="lbl">Status</span><h2>All clear</h2><p id="idle-line">—</p><p class="dim" id="idle-last"></p></div>
    </div>
    <div id="ic-actions"></div>`;
  lens = mountCam($("ic-lens"), { cam: () => current()?.camera_id || null, lens: true, hud: false });
  actionsEl = mountActions($("ic-actions"));

  map = mountMap($("map-live"));

  const mini = $("call-mini");
  mini.innerHTML = `
    <div class="ph"><h3>${icon("phone")} 911 · <span id="cm-state">No call</span></h3><svg class="wave" id="cm-wave" preserveAspectRatio="none"></svg><b class="cm-t" id="cm-t">--:--</b><a href="#/call" class="meta link">Open console →</a></div>
    <div class="cm-lines" id="cm-lines"></div>
    <p class="cm-idle" id="cm-idle">No active call. Sentinel phones 911 itself once a SEVERE incident passes the evidence check.</p>`;
  wave = mountWave($("cm-wave"), 40);
  mini.addEventListener("click", (e) => { if (!e.target.closest("a")) go("call"); });
}

export function renderLive() {
  const inc = current();
  const hero = $("hero");
  hero.classList.toggle("all", S.focus === "all");
  const follow = $("hero-follow");
  text(follow, S.focus && S.focus !== "all" ? `FOCUSED · CAM ${camNum(S.focus)}` : inc ? "AUTO-FOLLOW · ARMED" : "AUTO");
  follow.className = `chip ${!S.focus && inc ? "hot" : ""}`;
  const hc = heroCam();
  for (const t of $("thumbs").children) {
    const id = t.dataset.cam;
    t.classList.toggle("on", S.focus !== "all" && id === hc);
    t.classList.toggle("hot", inc?.camera_id === id);
    const n = S.lastPeople[id];
    text(t.querySelector(".tf-text"), `${camName(id)} · ${S.online[id] === false ? "offline" : typeof n === "number" ? `${n} in view` : "—"}`);
  }

  const path = renderMap(map);
  text($("map-path"), pathText(path));
  text($("map-meta"), path.length ? `${path.length - 1} handoff${path.length === 2 ? "" : "s"}` : inc ? "—" : "scanning");

  // Hero caption: where the armed person came from.
  const cap = $("hero-cap");
  if (inc && path.length) {
    const last = path.at(-1), prev = path.at(-2);
    text(cap, prev
      ? `${inc.class_token} · entered ${camName(last.cam)} from ${camName(prev.cam)} at ${clockOf(last.ts)}`
      : `${inc.class_token} · first seen ${camName(last.cam)} at ${clockOf(last.ts)}`);
  } else text(cap, "");

  renderCard(inc);
  renderActions(actionsEl);
  renderCallMini(inc);
}

function renderCard(inc) {
  const card = $("inc-card");
  card.classList.toggle("is-idle", !inc);
  card.classList.toggle("severe", inc?.severity === "SEVERE");
  if (!inc) {
    const onlineN = Object.values(S.online).filter(Boolean).length;
    const people = CAM_IDS.reduce((a, id) => a + (S.lastPeople[id] || 0), 0);
    text($("idle-line"), `Watching ${onlineN || "—"} of ${CAM_IDS.length} cameras · ${people} ${people === 1 ? "person" : "people"} in view`);
    const last = latest();
    text($("idle-last"), last ? `Last: INC-${shortId(last.incident_id)} · ${last.class_token} · ${last.state.toLowerCase()} ${clockOf(last.updated_at)}` : "No incidents since the last reset.");
    return;
  }
  text($("ic-class"), inc.class_token || "—");
  text($("ic-sev"), inc.severity || "—");
  text($("ic-state"), (inc.state || "").replace("_", " "));
  text($("ic-id"), `INC-${shortId(inc.incident_id)}`);
  text($("ic-title"), `${CLASS_TITLE[inc.class_token] || inc.class_token} · ${camName(inc.camera_id)}`);
  const route = S.routes.get(inc.incident_id) || [];
  const first = route[0];
  text($("ic-meta"), `First seen ${clockOf(inc.created_at)} · Cam ${camNum(first?.cam || inc.camera_id)} ${camName(first?.cam || inc.camera_id)}${route.length > 1 ? ` · now Cam ${camNum(inc.camera_id)}` : ""}`);
  text($("ic-desc"), inc.person_description || "—");

  const conf = confidence(inc);
  text($("ic-conf"), conf === null ? "—" : fmtConf(conf).replace(/^0/, ""));
  $("ic-ring").querySelector(".ring-fg").style.strokeDashoffset = RING_C * (1 - (conf ?? 0));

  const li = lensInfo(lens);
  text($("ic-lens-tag"), li.focus ? `${li.focus.kind === "weapon" ? `SAM 3.1 · weapon ${fmtConf(li.focus.score)}` : "person"} · ×${li.zoom.toFixed(1)}` : "SAM 3.1 · searching");

  $("ic-verdict").innerHTML = verdictHtml(inc);
}

/** A blocked auto-dispatch matters only while no call is running for that incident. */
export const isBlocked = (inc) =>
  !!inc && S.blocked?.incidentId === inc.incident_id && !callStatus(inc)
  && S.blocked.reason !== "voice_busy"  // "a call is already running" is not an operator task
  && !["DISPATCHED", "TRACKING", "RESOLVED"].includes(inc.state);

/** Evidence-check line: dispatch block for this incident wins, else Muse review status. */
export function verdictHtml(inc) {
  if (isBlocked(inc)) {
    const what = /^review/.test(S.blocked.reason) ? "Evidence check" : "Dispatch blocked";
    return `<span class="vd bad">${icon("warn")}<b>${what}: ${esc(S.blocked.reason)}</b> — operator dispatch required</span>`;
  }
  const mr = S.track?.muse_review;
  if (!mr) return `<span class="vd">${icon("shield")}<b>Evidence check</b> — status unavailable</span>`;
  const st = String(mr.state || "").toLowerCase();
  const agree = /^yes\b/i.test(mr.detail || "") || st === "agree" || st === "ok";
  const cls = agree ? "ok" : st === "pending" ? "wait" : st === "failed" || st === "disagree" ? "bad" : "";
  const detail = String(mr.detail || "").replace(/^yes:\s*/i, "");
  return `<span class="vd ${cls}">${icon("shield")}<b>Muse evidence review: ${esc(agree ? "passed" : mr.state || "—")}</b>${detail ? ` — ${esc(detail)}` : ""}</span>`;
}

function renderCallMini(inc) {
  const call = callStatus(inc);
  const lines = inc ? S.transcripts.get(inc.incident_id) || [] : [];
  $("call-mini").classList.toggle("on", !!call);
  text($("cm-state"), call ? `${call.state === "live" ? "Live call · SignalWire" : call.state}` : "No call");
  text($("cm-t"), call?.startTs ? mmss(((call.endTs ? ms(call.endTs) : Date.now()) - ms(call.startTs)) / 1000) : "--:--");
  $("cm-idle").hidden = !!call;
  renderTranscript($("cm-lines"), inc?.incident_id, lines, { limit: 4, compact: true });
  setWave(wave, lines.at(-1), call && call.state !== "ended");
}
