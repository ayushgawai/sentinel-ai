/**
 * Live camera views.
 *
 * One hidden MJPEG <img> per camera feeds every view: views are canvases that copy
 * the current frame, so the console holds exactly 3 HTTP streams no matter how many
 * places show video (browsers cap HTTP/1.1 at 6 connections per host).
 * Detection boxes are an SVG overlay in the frame's own 960×540 coordinates and are
 * eased toward each new overlay.boxes update every animation frame.
 */
import { mjpegUrl } from "../api.js";
import { S, CAM_IDS, camName, current, focusBox } from "../state.js";
import { $, h, svg, text, camNum, reducedMotion } from "../util.js";


const W = 960, H = 540;
const STALE_MS = 2500;
const DRAW_EVERY_MS = 45;
const pool = {};
const views = new Set();

export function startVideo() {
  for (const id of CAM_IDS) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.src = mjpegUrl(id);
    img.onerror = () => setTimeout(() => { img.src = `${mjpegUrl(id)}?r=${Date.now()}`; }, 3000);
    $("video-pool").appendChild(img);
    pool[id] = img;
  }
  requestAnimationFrame(loop);
}

const hasFrame = (img) => img && img.complete && img.naturalWidth > 0;

/**
 * Mount a camera view into `el`.
 * opts.cam(): camera id to show (re-evaluated every frame, so a view can follow the incident).
 * opts.lens: zoom onto the freshest weapon box (or the armed person) instead of the full frame.
 * opts.tags: draw text tags on boxes (off for small thumbnails).
 */
export function mountCam(el, opts) {
  const v = { el, opts, camId: null, boxes: new Map(), lastDraw: 0, src: null, scale: 1 };
  el.classList.add("cam");
  v.canvas = h("canvas");
  v.overlay = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "boxes" });
  v.noSignal = h("div", "nosig", "<span>NO SIGNAL</span>");
  el.prepend(v.canvas, v.overlay, v.noSignal);
  if (opts.lens) {
    v.reticle = svg("g", { class: "reticle" }, v.overlay);
    svg("rect", { class: "ret-box" }, v.reticle);
    for (let i = 0; i < 4; i++) svg("path", { class: "ret-tick" }, v.reticle);
  }
  if (opts.hud !== false) {
    v.hud = h("div", "hud", `
      <div class="hud-tl"><span class="rec"><i></i>REC</span><b class="hud-name"></b></div>
      <div class="hud-tr"><span class="chip hud-people"></span><span class="chip warn hud-weapons"></span><span class="chip hud-online"></span></div>`);
    el.appendChild(v.hud);
  }
  new ResizeObserver(() => resize(v)).observe(el);
  resize(v);
  views.add(v);
  return v;
}

function resize(v) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const r = v.el.getBoundingClientRect();
  v.canvas.width = Math.max(1, Math.round(r.width * dpr));
  v.canvas.height = Math.max(1, Math.round(r.height * dpr));
  // Keep tag text ~11px on screen whatever the view size.
  v.scale = r.width ? W / r.width : 1;
  v.overlay.style.setProperty("--fs", `${11 * v.scale}px`);
  v.lastDraw = 0;
}

const visible = (el) => el.offsetParent !== null && el.closest(".page")?.classList.contains("active") !== false;

function loop(now) {
  for (const v of views) {
    if (!visible(v.el)) continue;
    const id = v.opts.cam();
    if (id !== v.camId) switchCam(v, id);
    if (!id) continue;
    const img = pool[id];
    const live = hasFrame(img) && S.online[id] !== false;
    v.el.classList.toggle("offline", !live);
    if (v.opts.lens) lensStep(v, now);
    if (live && now - v.lastDraw > DRAW_EVERY_MS) {
      draw(v, img);
      v.lastDraw = now;
    }
    if (!v.opts.lens) boxesStep(v);
    if (v.hud && now - (v.hudAt || 0) > 250) { hud(v, id); v.hudAt = now; }
  }
  requestAnimationFrame(loop);
}

function switchCam(v, id) {
  const first = v.camId === null;
  v.camId = id;
  v.el.dataset.cam = id || "";
  for (const b of v.boxes.values()) b.g.remove();
  v.boxes.clear();
  v.src = null;
  v.lastDraw = 0;
  if (!first && !reducedMotion()) {
    v.el.classList.remove("snap");
    void v.el.offsetWidth;
    v.el.classList.add("snap");
  }
}

function draw(v, img) {
  const ctx = v.canvas.getContext("2d");
  const cw = v.canvas.width, ch = v.canvas.height;
  if (v.opts.lens) {
    const s = v.src || { x: 0, y: 0, w: W, h: H };
    const kx = img.naturalWidth / W, ky = img.naturalHeight / H;
    ctx.drawImage(img, s.x * kx, s.y * ky, s.w * kx, s.h * ky, 0, 0, cw, ch);
  } else {
    ctx.drawImage(img, 0, 0, cw, ch);
  }
}

/* ---------- lens: ease a source rect toward the focus box ---------- */

function lensStep(v, now) {
  const inc = current();
  const fb = focusBox(v.camId, inc?.track_id);
  const aspect = v.canvas.width / v.canvas.height || 1;
  let target;
  if (fb) {
    const bx = fb.x * W, by = fb.y * H, bw = fb.w * W, bh = fb.h * H;
    const pad = fb.kind === "weapon" ? 3.2 : 1.25;
    let tw = Math.max(bw * pad, 90), th = Math.max(bh * pad, 90);
    if (tw / th > aspect) th = tw / aspect; else tw = th * aspect;
    tw = Math.min(tw, W); th = Math.min(th, H);
    target = { x: clamp(bx + bw / 2 - tw / 2, 0, W - tw), y: clamp(by + bh / 2 - th / 2, 0, H - th), w: tw, h: th };
  } else {
    const th = H, tw = Math.min(W, th * aspect);
    target = { x: (W - tw) / 2, y: 0, w: tw, h: th };
  }
  const k = reducedMotion() || !v.src ? 1 : 0.12;
  v.src = v.src ? lerpRect(v.src, target, k) : target;
  v.focus = fb;
  v.zoom = W / v.src.w;
  // Reticle on the focus box, mapped into lens space (the svg is 960×540 user units).
  const r = v.reticle;
  r.style.opacity = fb ? 1 : 0;
  if (fb) {
    const sx = W / v.src.w, sy = H / v.src.h;
    const x = (fb.x * W - v.src.x) * sx, y = (fb.y * H - v.src.y) * sy, w = fb.w * W * sx, hh = fb.h * H * sy;
    r.setAttribute("class", `reticle ${fb.kind}`);
    const box = r.children[0];
    box.setAttribute("x", x); box.setAttribute("y", y); box.setAttribute("width", w); box.setAttribute("height", hh);
    const cx = x + w / 2, cy = y + hh / 2, L = 26;
    const ticks = [`M${cx} ${y - L}V${y - 6}`, `M${cx} ${y + hh + 6}V${y + hh + L}`, `M${x - L} ${cy}H${x - 6}`, `M${x + w + 6} ${cy}H${x + w + L}`];
    ticks.forEach((d, i) => r.children[i + 1].setAttribute("d", d));
  }
  v.lastDraw = Math.min(v.lastDraw, now - DRAW_EVERY_MS); // redraw while the lens moves
}

/* ---------- detection boxes ---------- */

function boxesStep(v) {
  const frame = S.boxes[v.camId];
  const fresh = frame && performance.now() - frame.t < STALE_MS;
  const list = fresh ? frame.boxes : [];
  const weapons = list.filter((b) => b.label === "weapon");
  const inc = current();
  const seen = new Set();
  list.forEach((b, i) => {
    const key = b.track_id ? `${b.label}:${b.track_id}` : `${b.label}#${i}`;
    seen.add(key);
    const tgt = { x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H };
    let rec = v.boxes.get(key);
    if (!rec) {
      rec = makeBox(v, tgt);
      v.boxes.set(key, rec);
    }
    rec.tgt = tgt;
    const armed = b.label === "person" && (
      weapons.some((w) => inside(w, b)) ||
      (inc && inc.camera_id === v.camId && inc.track_id === b.track_id && inc.severity === "SEVERE"));
    const kind = b.label === "weapon" ? "weapon" : armed ? "armed" : b.label === "person" ? "person" : "other";
    rec.g.setAttribute("class", `bx ${kind}`);
    if (v.opts.tags !== false || kind !== "person") {
      const score = typeof b.score === "number" ? b.score.toFixed(2) : "—";
      rec.label = kind === "weapon" ? `WEAPON · SAM ${score}` : kind === "armed" ? `ARMED · ${b.track_id || "?"} · ${score}` : `${b.track_id || b.label} · ${score}`;
    } else rec.label = "";
  });
  for (const [key, rec] of v.boxes) {
    if (!seen.has(key)) { rec.g.remove(); v.boxes.delete(key); continue; }
    rec.cur = reducedMotion() ? rec.tgt : lerpRect(rec.cur, rec.tgt, 0.28);
    paintBox(v, rec);
  }
}

function makeBox(v, r) {
  const g = svg("g", { class: "bx" }, v.overlay);
  const rec = {
    g, cur: { ...r }, tgt: r, label: "",
    fill: svg("rect", { class: "bx-fill" }, g),
    path: svg("path", { class: "bx-br" }, g),
    tag: svg("g", { class: "bx-tag" }, g),
  };
  rec.tagBg = svg("rect", { class: "bx-tag-bg" }, rec.tag);
  rec.tagText = svg("text", { class: "bx-tag-tx" }, rec.tag);
  return rec;
}

function paintBox(v, rec) {
  const { x, y, w, h } = rec.cur;
  const L = clamp(Math.min(w, h) * 0.24, 6, 34);
  rec.path.setAttribute("d",
    `M${x} ${y + L}V${y}H${x + L}M${x + w - L} ${y}H${x + w}V${y + L}M${x + w} ${y + h - L}V${y + h}H${x + w - L}M${x + L} ${y + h}H${x}V${y + h - L}`);
  for (const [k, val] of [["x", x], ["y", y], ["width", w], ["height", h]]) rec.fill.setAttribute(k, val);
  rec.tag.style.display = rec.label ? "" : "none";
  if (!rec.label) return;
  text(rec.tagText, rec.label);
  const fs = 11 * v.scale;
  const tw = rec.label.length * fs * 0.62 + fs;
  const th = fs * 1.6;
  const ty = y - th - 2 < 0 ? y + 2 : y - th - 2;
  rec.tagBg.setAttribute("x", x); rec.tagBg.setAttribute("y", ty);
  rec.tagBg.setAttribute("width", tw); rec.tagBg.setAttribute("height", th);
  rec.tagText.setAttribute("x", x + fs * 0.5); rec.tagText.setAttribute("y", ty + th * 0.7);
}

function hud(v, id) {
  const frame = S.boxes[id];
  const fresh = frame && performance.now() - frame.t < STALE_MS;
  const people = fresh ? frame.boxes.filter((b) => b.label === "person").length : null;
  const weapons = fresh ? frame.boxes.filter((b) => b.label === "weapon").length : 0;
  text(v.hud.querySelector(".hud-name"), `CAM ${camNum(id)} — ${camName(id)}`);
  text(v.hud.querySelector(".hud-people"), people === null ? "— persons" : `${people} person${people === 1 ? "" : "s"}`);
  const wEl = v.hud.querySelector(".hud-weapons");
  text(wEl, `${weapons} weapon${weapons === 1 ? "" : "s"}`);
  wEl.hidden = !weapons;
  const on = S.online[id];
  const onEl = v.hud.querySelector(".hud-online");
  text(onEl, on === false ? "OFFLINE" : !fresh && on ? "HELD" : on ? "ONLINE" : "—");
  onEl.className = `chip hud-online ${on === false ? "bad" : fresh ? "ok" : ""}`;
}

/** Lens zoom factor for a view (derived from the drawn crop), for captions. */
export const lensInfo = (v) => ({ zoom: v?.zoom || null, focus: v?.focus || null });

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, k) => a + (b - a) * k;
const lerpRect = (a, b, k) => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) });
const inside = (w, p) => {
  const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
  return cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h;
};
