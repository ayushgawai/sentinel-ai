/** Incremental 911 transcript rendering (call page + live mini panel). */
import { h, esc, clockOf } from "../util.js";

const isUpdate = (l) => /^update:/i.test(l.text || "");

/** Append only new lines; restart when the incident changes or the list shrinks (reset). */
export function renderTranscript(el, incId, lines, { limit = 0, compact = false } = {}) {
  if (el.dataset.inc !== String(incId) || Number(el.dataset.n || 0) > lines.length) {
    el.innerHTML = "";
    el.dataset.inc = String(incId);
    el.dataset.n = "0";
  }
  const from = Number(el.dataset.n);
  for (const l of lines.slice(from)) el.appendChild(lineEl(l, compact, from > 0 || lines.length < 3));
  el.dataset.n = String(lines.length);
  if (limit) while (el.children.length > limit) el.firstChild.remove();
  if (lines.length > from) el.scrollTo({ top: el.scrollHeight, behavior: from ? "smooth" : "auto" });
}

function lineEl(l, compact, animate) {
  const who = l.speaker === "dispatcher" ? "dispatcher" : "sentinel";
  const anim = animate ? " enter" : "";
  if (isUpdate(l)) {
    return h("div", `tline update${anim}`,
      `<span class="t">${clockOf(l.ts)}</span><span class="tx">${esc(l.text)}</span>`);
  }
  if (compact) {
    return h("div", `tline ${who}${anim}`, `<span class="who">${who === "dispatcher" ? "DISPATCH" : "SENTINEL"}</span><span class="tx">${esc(l.text)}</span>`);
  }
  return h("div", `tline bubble ${who}${anim}`,
    `<span class="t">${clockOf(l.ts)}</span><div class="bub"><span class="who">${who}</span><span class="tx">${esc(l.text)}</span></div>`);
}
