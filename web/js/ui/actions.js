/** Operator actions: the 6-button grid, dialogs, keyboard shortcuts and toasts. */
import * as api from "../api.js";
import { isBlocked } from "../pages/live.js";
import { send } from "../ws.js";
import { S, CAM_IDS, STATES, current, callStatus, camName, changed } from "../state.js";
import { $, h, esc, icon, text, mmss, ms, camNum, shortId } from "../util.js";

const DISMISS_REASONS = ["False alarm", "Authorized activity", "Duplicate incident", "Other"];
const AUDIENCES = [["everyone", "Everyone"], ["students", "Students"], ["faculty_staff", "Faculty & staff"], ["security", "Security team"]];
const CLASSES = ["WEAPON", "FIGHT", "THEFT", "MEDICAL", "RUN"];
const busy = new Set();

const BUTTONS = [
  { id: "dispatch", key: "D", label: "Dispatch 911", ico: "phone", cls: "hot" },
  { id: "confirm", key: "C", label: "Confirm", ico: "check", cls: "ok" },
  { id: "dismiss", key: "X", label: "Dismiss", ico: "x", cls: "" },
  { id: "shelter", key: "S", label: "Shelter", ico: "speaker", cls: "amber" },
  { id: "report", key: "", label: "Report", ico: "plus", cls: "" },
  { id: "reset", key: "R", label: "Reset", ico: "reset", cls: "" },
];
const SUB = { confirm: "mark as real", dismiss: "false alarm", shelter: "broadcast", report: "manual incident", reset: "replay to start" };

export function mountActions(el) {
  el.classList.add("actions");
  for (const b of BUTTONS) {
    const btn = h("button", `act ${b.cls}`, `${icon(b.ico)}<span class="a-l"><b>${b.label}</b><small>${SUB[b.id] || ""}</small></span>${b.key ? `<kbd>${b.key}</kbd>` : ""}`);
    btn.type = "button";
    btn.dataset.act = b.id;
    btn.addEventListener("click", () => run(b.id));
    el.appendChild(btn);
  }
  return el;
}

/** Enable/disable and relabel buttons from the current incident. */
export function renderActions(el) {
  const inc = current();
  const call = callStatus(inc);
  const past = inc && STATES.indexOf(inc.state) >= STATES.indexOf("DISPATCH_PENDING");
  for (const btn of el.querySelectorAll(".act")) {
    const id = btn.dataset.act;
    const needsInc = id === "dispatch" || id === "confirm" || id === "dismiss";
    btn.disabled = busy.has(id) || (needsInc && !inc) || (id === "dispatch" && past);
    btn.classList.toggle("busy", busy.has(id));
  }
  const d = el.querySelector('[data-act="dispatch"]');
  let sub = "operator call";
  if (call) sub = call.state === "connecting" ? "connecting…" : `on call ${mmss((Date.now() - ms(call.startTs)) / 1000)}`;
  else if (past) sub = inc.state.replace("_", " ").toLowerCase();
  else if (isBlocked(inc)) sub = "operator dispatch required";
  text(d.querySelector("b"), call ? "911 on call" : "Dispatch 911");
  text(d.querySelector("small"), sub);
  d.classList.toggle("oncall", !!call && call.state !== "ended");
}

async function run(id) {
  const inc = current();
  if (busy.has(id)) return;
  if (id === "dispatch" && inc) return act(id, () => api.dispatch(inc.incident_id), "911 dispatch requested");
  if (id === "confirm" && inc) return act(id, () => api.confirm(inc.incident_id), "Incident confirmed");
  if (id === "dismiss" && inc) {
    const f = await ask("Dismiss incident", `INC-${shortId(inc.incident_id)} · ${esc(inc.class_token)}`,
      `<fieldset class="chips">${DISMISS_REASONS.map((r, i) => `<label><input type="radio" name="reason" value="${r}" ${i ? "" : "checked"}><span>${r}</span></label>`).join("")}</fieldset>`,
      "Dismiss");
    if (f) return act(id, () => api.dismiss(inc.incident_id, f.get("reason")), "Incident dismissed");
  }
  if (id === "shelter") {
    const where = inc ? camName(inc.camera_id).toLowerCase() : "the reported area";
    const f = await ask("Shelter-in-place broadcast", inc ? `Linked to INC-${shortId(inc.incident_id)}` : "Site-wide",
      `<label class="fld"><span>Message</span><textarea name="message" maxlength="280" rows="3">Shelter in place now. Security incident near the ${esc(where)}. Lock doors, stay quiet, wait for instructions.</textarea></label>
       <fieldset class="chips">${AUDIENCES.map(([v, l], i) => `<label><input type="checkbox" name="audience" value="${v}" ${i ? "" : "checked"}><span>${l}</span></label>`).join("")}</fieldset>`,
      "Broadcast now");
    if (f) {
      const audience = f.getAll("audience");
      const message = String(f.get("message") || "").trim();
      if (!audience.length || !message) return toast("Broadcast needs a message and an audience", "bad");
      return act(id, () => api.broadcast({ incidentId: inc?.incident_id, audience, message }), "Broadcast sent");
    }
  }
  if (id === "report") {
    const f = await ask("Report a manual incident", "For something the cameras missed",
      `<div class="row3">
        <label class="fld"><span>Camera</span><select name="camera">${CAM_IDS.map((c) => `<option value="${c}">Cam ${camNum(c)} · ${esc(camName(c))}</option>`).join("")}</select></label>
        <label class="fld"><span>Type</span><select name="cls">${CLASSES.map((c) => `<option>${c}</option>`).join("")}</select></label>
        <label class="fld"><span>Severity</span><select name="sev"><option>SEVERE</option><option>MINOR</option></select></label>
      </div><label class="fld"><span>Note</span><input name="note" maxlength="200" placeholder="What did you see?"></label>`,
      "Report");
    if (f) return act(id, () => api.manualIncident({ cameraId: f.get("camera"), classToken: f.get("cls"), severity: f.get("sev"), note: String(f.get("note") || "") }), "Incident reported");
  }
  if (id === "reset") {
    const f = await ask("Reset the replay?", "Rewinds the recorded footage and clears every incident on this console.", "", "Reset");
    if (!f) return;
    const sent = send({ cmd: "reset" });
    toast(sent ? "Replay reset" : "Stream offline — reset not sent", sent ? "ok" : "bad");
  }
}

async function act(id, fn, okMsg) {
  busy.add(id);
  changed();
  const res = await fn();
  busy.delete(id);
  changed();
  toast(res.ok ? okMsg : `Declined: ${res.message}`, res.ok ? "ok" : "bad");
}

/** Native <dialog> form. Resolves FormData on submit, null on cancel. */
function ask(title, sub, body, okLabel) {
  const dlg = $("dlg"), form = $("dlg-form");
  form.innerHTML = `<header><h3>${esc(title)}</h3><p>${sub}</p></header>${body}
    <footer><button value="cancel" formnovalidate class="ghost">Cancel <kbd>Esc</kbd></button><button value="ok" class="primary" autofocus>${esc(okLabel)} <kbd>↵</kbd></button></footer>`;
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok" ? new FormData(form) : null), { once: true });
  });
}

export function toast(msg, kind = "") {
  const t = h("div", `toast ${kind}`, esc(msg));
  $("toasts").appendChild(t);
  setTimeout(() => t.classList.add("out"), 3600);
  setTimeout(() => t.remove(), 4200);
}

/** Keyboard: D dispatch, C confirm, X dismiss, S shelter, 1/2/3 focus, A all, R reset. */
export function bindKeys() {
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || $("dlg").open) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    const map = { d: "dispatch", c: "confirm", x: "dismiss", s: "shelter", r: "reset" };
    if (map[k]) { e.preventDefault(); flash(map[k]); run(map[k]); return; }
    if (["1", "2", "3"].includes(k)) setFocus(`cam-0${k}`);
    else if (k === "a") setFocus("all");
  });
}

export function setFocus(f) {
  S.focus = S.focus === f && f !== "all" ? null : f;
  changed();
}

function flash(id) {
  for (const b of document.querySelectorAll(`.act[data-act="${id}"]`)) {
    b.classList.remove("pressed");
    void b.offsetWidth;
    b.classList.add("pressed");
  }
}
