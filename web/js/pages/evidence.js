/** Evidence: why Sentinel acted — live frame, SAM lens, Muse classification, decision chain, timeline. */
import { S, STATES, current, latest, confidence, camName, focusBox } from "../state.js";
import { $, h, esc, text, icon, fmtConf, clockOf, camNum, shortId, ms } from "../util.js";
import { mountCam, lensInfo } from "../ui/camera.js";
import { verdictHtml, isBlocked } from "./live.js";

const CLASSES = ["WEAPON", "FIGHT", "THEFT", "RUN", "MEDICAL", "BENIGN"];
const CHAIN = [
  { id: "detect", title: "Detect", model: "YOLO26s-pose" },
  { id: "track", title: "Track", model: "ByteTrack" },
  { id: "segment", title: "Segment", model: "SAM 3.1 (Meta)" },
  { id: "classify", title: "Classify", model: "Muse Spark Open" },
  { id: "verify", title: "Verify", model: "Muse evidence review" },
  { id: "act", title: "Act", model: "ElevenLabs · SignalWire" },
];
const SUB_RULES = new Set(["overlay_handoff"]);

let lens;
const subject = () => current() || latest();

export function mountEvidence() {
  mountCam($("ev-cam"), { cam: () => subject()?.camera_id || "cam-01" });
  $("ev-cam").insertAdjacentHTML("beforeend", '<div class="hud-bl" id="ev-cam-cap"></div>');
  lens = mountCam($("ev-lens"), { cam: () => subject()?.camera_id || null, lens: true, hud: false });
  $("ev-lens").insertAdjacentHTML("beforeend", '<div class="hud-tl"><span class="chip amber">live lens</span><span class="chip" id="ev-zoom">—</span></div>');

  $("ev-class").innerHTML = `
    <div class="ph"><h3>Muse Spark Open · classification</h3><span class="meta" id="ev-model">—</span></div>
    <div class="cls-rows">${CLASSES.map((c) => `<div class="cls" data-c="${c}"><span>${c}</span><i><b></b></i><em>—</em></div>`).join("")}</div>
    <div class="quote"><span class="lbl">Muse description · clothing only</span><p id="ev-desc">—</p></div>
    <div class="ev-metrics" id="ev-metrics"></div>
    <div class="review" id="ev-review"></div>`;

  $("ev-chain").innerHTML = `
    <div class="ph"><h3>Decision chain <em>frame → act</em></h3><span class="meta">every gate must pass before Sentinel calls 911</span></div>
    <ol class="chain">${CHAIN.map((c, i) => `<li data-step="${c.id}" style="--i:${i}"><b>${c.title}</b><small>${c.model}</small><span class="node"><span class="n">${String(i + 1).padStart(2, "0")}</span>${icon("check", "ico ok-ico")}</span><span class="res"></span><span class="res2"></span></li>`).join("")}</ol>
    <div class="rules"><span class="lbl">Detector rules fired</span><div id="ev-rules"></div></div>`;
}

export function renderEvidence() {
  const inc = subject();
  const page = $("page-evidence");
  page.classList.toggle("empty", !inc);
  if (!inc) {
    text($("ev-eyebrow"), "Why Sentinel acted");
    $("ev-title").innerHTML = "No incident yet <em>— watching</em>";
    $("ev-badges").innerHTML = '<span class="badge outline">no facial recognition</span>';
    return;
  }
  const conf = confidence(inc);
  const mr = S.track?.muse_review;
  const reviewOk = /^yes\b/i.test(mr?.detail || "");
  const rules = [...(S.rules.get(inc.incident_id) || [])];
  const detectorRules = rules.filter((r) => !SUB_RULES.has(r));
  const signals = [detectorRules.length > 0, conf !== null && inc.class_token !== "BENIGN", reviewOk].filter(Boolean).length;

  text($("ev-eyebrow"), `Incident INC-${shortId(inc.incident_id)} · ${inc.state === "DISMISSED" || inc.state === "RESOLVED" ? inc.state.toLowerCase() : "why Sentinel acted"}`);
  $("ev-title").innerHTML = `${esc(inc.class_token)} ${signals === 3 ? "confirmed" : "flagged"} by <em>${signals} signal${signals === 1 ? "" : "s"}</em>`;
  $("ev-badges").innerHTML = `<span class="badge fill">${esc(inc.class_token)}</span><span class="badge hot">${esc(inc.severity)}</span><span class="badge">state · ${esc(inc.state.replace("_", " "))}</span><span class="badge outline">${icon("eye")} no facial recognition</span>`;

  const route = S.routes.get(inc.incident_id) || [];
  text($("ev-cam-cap"), `CAM ${camNum(inc.camera_id)} · ${camName(inc.camera_id)} · live · first seen ${clockOf(inc.created_at)} on cam ${camNum(route[0]?.cam || inc.camera_id)}`);

  const li = lensInfo(lens);
  text($("ev-zoom"), li.zoom ? `crop ×${li.zoom.toFixed(1)}` : "—");
  const fb = focusBox(inc.camera_id, inc.track_id);
  $("ev-lens-foot").innerHTML = fb?.kind === "weapon"
    ? `<span class="lbl">Segmentation · label “weapon” · this frame</span><b>${fmtConf(fb.score)}</b><i class="bar"><b style="width:${(fb.score * 100).toFixed(0)}%"></b></i>`
    : `<span class="lbl">Segmentation · this frame</span><b class="dim">—</b><span class="dim">no weapon box on cam ${camNum(inc.camera_id)} right now${fb ? " · lens on person" : ""}</span>`;

  // Classification: only the chosen class has a real probability.
  text($("ev-model"), S.mode?.vlm || "—");
  for (const row of $("ev-class").querySelectorAll(".cls")) {
    const on = row.dataset.c === inc.class_token;
    row.classList.toggle("on", on);
    row.querySelector("i b").style.width = on && conf !== null ? `${conf * 100}%` : "0";
    text(row.querySelector("em"), on ? fmtConf(conf) : "—");
  }
  text($("ev-desc"), inc.person_description || "—");
  $("ev-metrics").innerHTML = [
    ["Confidence", fmtConf(conf)],
    ["Fused probability", fmtConf(inc.fused_prob)],
    ["Router score", fmtConf(inc.router_score)],
    ["Severity", inc.severity || "—"],
  ].map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
  $("ev-review").innerHTML = `<span class="lbl">Evidence review · second Muse check</span>${verdictHtml(inc)}`;

  renderChain(inc, conf, reviewOk, detectorRules, fb);
  renderTimeline(inc);
}

function renderChain(inc, conf, reviewOk, detectorRules, fb) {
  const stage = (id) => (S.activity || []).find((s) => s.id === id);
  const people = S.lastPeople[inc.camera_id];
  const evs = S.events.get(inc.incident_id) || [];
  const dispatched = evs.find((e) => e.state === "DISPATCHED");
  const blocked = isBlocked(inc);
  const mr = S.track?.muse_review;
  const steps = {
    detect: ["pass", typeof people === "number" ? `${people} persons · cam ${camNum(inc.camera_id)}` : "—", `${stage("yolo")?.count ?? "—"} frames in batch`],
    track: ["pass", `subject ${inc.track_id || "—"}`, `${stage("bytetrack")?.count ?? "—"} people tracked`],
    segment: [detectorRules.length ? "pass" : "wait", fb?.kind === "weapon" ? `weapon ${fmtConf(fb.score)}` : "weapon box earlier", detectorRules.join(" · ") || "—"],
    classify: [conf !== null ? "pass" : "wait", `${inc.class_token} ${fmtConf(conf)}`, `severity ${inc.severity}`],
    verify: [reviewOk ? "pass" : blocked ? "fail" : "wait", reviewOk ? "agree" : blocked ? S.blocked.reason : mr?.state || "—", (mr?.detail || "").replace(/^yes:\s*/i, "").slice(0, 46) || "—"],
    act: [dispatched ? "pass" : blocked ? "fail" : "wait", dispatched ? "911 dialed" : blocked ? "operator required" : "not dialed",
      dispatched ? `+${((ms(dispatched.ts) - ms(inc.created_at)) / 1000).toFixed(1)} s from first alert` : "—"],
  };
  for (const li of $("ev-chain").querySelectorAll(".chain li")) {
    const [st, a, b] = steps[li.dataset.step];
    li.className = st;
    text(li.querySelector(".res"), a);
    text(li.querySelector(".res2"), b);
  }
  const rules = [...(S.rules.get(inc.incident_id) || [])];
  $("ev-rules").innerHTML = rules.length ? rules.map((r) => `<span class="rule ${SUB_RULES.has(r) ? "sub" : ""}">${esc(r)}</span>`).join("") : '<span class="dim">—</span>';
}

function renderTimeline(inc) {
  const evs = S.events.get(inc.incident_id) || [];
  const ol = $("ev-tl");
  const key = `${inc.incident_id}:${evs.length}`;
  text($("ev-tl-count"), `${evs.length} event${evs.length === 1 ? "" : "s"}`);
  if (ol.dataset.key === key) return;
  const prevN = ol.dataset.key?.startsWith(inc.incident_id) ? Number(ol.dataset.key.split(":")[1]) : 0;
  ol.dataset.key = key;
  const reached = new Set(evs.map((e) => e.state));
  const pending = STATES.filter((s) => !reached.has(s) && STATES.indexOf(s) > STATES.indexOf(inc.state));
  ol.innerHTML = "";
  evs.forEach((e, i) => ol.appendChild(h("li", `${i === evs.length - 1 ? "cur" : ""} ${i >= prevN ? "enter" : ""}`,
    `<time>${clockOf(e.ts)}</time><b>${esc(e.state.replace("_", " "))}</b><span>${esc(e.note || "")}</span>`)));
  for (const s of pending) ol.appendChild(h("li", "todo", `<time>—</time><b>${s.replace("_", " ")}</b><span>awaiting</span>`));
}
