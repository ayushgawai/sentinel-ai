/** Small DOM / format helpers shared by every module. */

export const $ = (id) => document.getElementById(id);
export const NS = "http://www.w3.org/2000/svg";

/** Create an element from a tag and an HTML string (trusted templates only; data goes through esc()). */
export function h(tag, cls, html = "") {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html) el.innerHTML = html;
  return el;
}

export function svg(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** Set text only when it changed, so CSS animations keyed on content don't restart. */
export function text(el, v) {
  const s = String(v ?? "—");
  if (el && el.textContent !== s) el.textContent = s;
}

export const DASH = "—";
export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const fmtInt = (v) => (isNum(v) ? Math.round(v).toLocaleString("en-US") : DASH);
export function fmtCompact(v) {
  if (!isNum(v)) return DASH;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e4) return (v / 1e3).toFixed(1) + "k";
  return fmtInt(v);
}
export const fmtConf = (v) => (isNum(v) ? v.toFixed(2) : DASH);

export const ms = (iso) => (iso ? Date.parse(iso) : NaN);
export function clockOf(iso) {
  const t = ms(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString("en-GB", { hour12: false }) : DASH;
}
export function mmss(sec) {
  if (!isNum(sec) || sec < 0) return "--:--";
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export const camNum = (id) => String(id || "").replace(/\D/g, "").replace(/^0+/, "") || "?";
export const shortId = (id) => String(id || "").replace(/^inc-/, "").slice(0, 6).toUpperCase();

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Animate a number's text from its previous value to `v` (count-up). */
const tweens = new WeakMap();
export function tween(el, v, fmt = fmtInt) {
  if (!el) return;
  if (!isNum(v)) return text(el, DASH);
  const prev = tweens.get(el);
  const from = prev?.to ?? v;
  if (prev?.to === v) return;
  cancelAnimationFrame(prev?.raf);
  const t0 = performance.now(), dur = reducedMotion() ? 0 : 500;
  const step = (now) => {
    const k = dur ? Math.min(1, (now - t0) / dur) : 1;
    const e = 1 - Math.pow(1 - k, 3);
    text(el, fmt(from + (v - from) * e));
    if (k < 1) rec.raf = requestAnimationFrame(step);
  };
  const rec = { to: v, raf: requestAnimationFrame(step) };
  tweens.set(el, rec);
}

/** Inline icon set (stroke icons, 24×24). */
export const ICON = {
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  check: '<path d="M5 12.5 10 17 19 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4h4"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  warn: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17v.5"/>',
  grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};
export const icon = (name, cls = "ico") =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
