/** Call console: the full 911 conversation, grounding camera, spoken handoffs and the call brief. */
import { S, current, latest, callStatus, camName } from "../state.js";
import { $, h, esc, text, icon, clockOf, camNum, shortId, mmss, ms } from "../util.js";
import { mountCam } from "../ui/camera.js";
import { renderTranscript } from "../ui/transcript.js";
import { mountWave, setWave } from "../ui/wave.js";

let wave;
const subject = () => current() || latest();

export function mountCall() {
  wave = mountWave($("wave-big"), 150);
  mountCam($("call-cam"), { cam: () => subject()?.camera_id || "cam-01" });
}

export function renderCall() {
  const inc = subject();
  const call = callStatus(inc);
  const lines = inc ? S.transcripts.get(inc.incident_id) || [] : [];
  const page = $("page-call");
  page.classList.toggle("on-call", !!call && call.state !== "ended");

  text($("call-state-word"), call ? call.state.toUpperCase() : "STANDBY");
  const v = S.voice;
  const line = v ? `line: SignalWire ${v.signalwire?.configured ? "configured" : "not configured"} · voice: ${v.tts?.provider || "—"}` : "line status —";
  text($("call-sub"), inc ? `INC-${shortId(inc.incident_id)} · ${line}` : line);
  text($("call-elapsed"), call?.startTs ? mmss(((call.endTs ? ms(call.endTs) : Date.now()) - ms(call.startTs)) / 1000) : "--:--");
  for (const s of $("call-seg").children) s.classList.toggle("on", call?.state === s.dataset.s);

  const tr = $("transcript");
  if (!lines.length) {
    const msg = call ? "Dialing 911 — waiting for the dispatcher to answer…" : "No call yet. When Sentinel dials 911, every line of the conversation appears here in real time.";
    if (tr.dataset.empty !== msg) {
      tr.dataset.inc = "";
      tr.dataset.n = "0";
      tr.dataset.empty = msg;
      tr.innerHTML = `<div class="tr-empty">${icon("phone")}<p>${msg}</p></div>`;
    }
  } else {
    tr.dataset.empty = "";
    renderTranscript(tr, inc.incident_id, lines);
  }
  setWave(wave, lines.at(-1), call && call.state !== "ended");

  // Grounding: what the call's camera shows at this second.
  const f = inc && S.boxes[inc.camera_id];
  const ppl = f ? f.boxes.filter((b) => b.label === "person").length : null;
  const wpn = f ? f.boxes.filter((b) => b.label === "weapon").length : null;
  text($("ground-meta"), inc ? `cam ${camNum(inc.camera_id)} · ${ppl ?? "—"} persons · ${wpn ?? "—"} weapons` : "—");

  renderHandoffs(inc, lines);
  renderBrief(inc);
}

function renderHandoffs(inc, lines) {
  const route = inc ? S.routes.get(inc.incident_id) || [] : [];
  const spoken = lines.filter((l) => /^update:/i.test(l.text));
  text($("handoff-count"), inc ? `${spoken.length} update${spoken.length === 1 ? "" : "s"} spoken · ${Math.max(0, route.length - 1)} camera handoffs` : "—");
  const el = $("handoff-track");
  const key = route.map((r) => r.cam + r.ts).join("|");
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  if (!route.length) { el.innerHTML = '<p class="dim pad">No route yet — the armed person\'s path appears here camera by camera.</p>'; return; }
  el.innerHTML = "";
  const track = h("div", "htrack");
  route.forEach((r, i) => {
    if (i) track.appendChild(h("i", "hlink", ""));
    track.appendChild(h("div", `hnode ${i === route.length - 1 ? "now" : ""}`,
      `<span class="hc">${camNum(r.cam)}</span><b>${esc(camName(r.cam))}</b><time>${clockOf(r.ts)}</time>`));
  });
  el.appendChild(track);
}

function renderBrief(inc) {
  const b = inc ? S.briefs.get(inc.incident_id) : null;
  const el = $("call-brief");
  const key = b ? JSON.stringify(b) : `none:${inc?.incident_id}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const rows = b ? [
    ["Building", b.building],
    ["Address", b.address],
    ["Entrances", (b.entrances || []).join(", ")],
    ["Person", b.person_description],
    ["Camera", b.camera_id ? `Cam ${camNum(b.camera_id)} · ${camName(b.camera_id)}` : null],
    ["Brief", `${b.reason || "—"} · ${clockOf(b.brief_generated_at)}`],
  ] : [];
  el.innerHTML = `<div class="ph"><h3>Call brief · what Sentinel tells 911</h3><span class="meta">${b ? "from call.brief" : "—"}</span></div>` +
    (b ? `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v || "—")}</dd>`).join("")}</dl>` : '<p class="dim pad">The dispatch brief appears when Sentinel places the call.</p>') +
    `<button class="act amber wide" type="button" id="brief-shelter">${icon("speaker")}<span class="a-l"><b>Shelter-in-place broadcast</b><small>message everyone on site</small></span><kbd>S</kbd></button>`;
  $("brief-shelter").addEventListener("click", () => document.querySelector('#ic-actions [data-act="shelter"]').click());
}
