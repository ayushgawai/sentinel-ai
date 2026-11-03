/** Bottom AI-pipeline strip: one chip per backend stage from activity.tick. */
import { S } from "../state.js";
import { $, esc, text, fmtCompact } from "../util.js";

let built = null;

export const ago = (s) => (typeof s === "number" ? (s < 1 ? "now" : s < 60 ? `${s.toFixed(0)}s ago` : `${Math.floor(s / 60)}m ago`) : "—");
export const stageState = (st) => (st.active || st.count > 0 ? "busy" : "idle");

export function renderStrip() {
  const el = $("strip");
  const stages = S.activity || [];
  const key = stages.map((s) => s.id).join();
  if (key !== built) {
    built = key;
    el.innerHTML = `<span class="strip-lbl">AI<br>pipeline</span>` +
      stages.map((s, i) => `${i ? '<i class="arrow"></i>' : ""}<div class="stage" data-id="${esc(s.id)}"><b>${esc(s.name)}</b><span class="v"></span></div>`).join("") +
      (stages.length ? "" : '<span class="strip-wait">Waiting for pipeline activity…</span>') +
      `<div class="strip-tot"><span>Requests</span><b id="st-req">—</b><span>Frames</span><b id="st-frames">—</b></div>`;
  }
  for (const s of stages) {
    const chip = el.querySelector(`.stage[data-id="${CSS.escape(s.id)}"]`);
    chip.className = `stage ${stageState(s)}`;
    text(chip.querySelector(".v"), `${s.count ?? "—"} ${s.unit} · ${ago(s.last_s)}`);
  }
  text($("st-req"), fmtCompact(S.usage?.requests));
  text($("st-frames"), fmtCompact(S.usage?.frames));
}
