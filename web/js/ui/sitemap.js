/**
 * Site floorplan: the 3 cameras with field-of-view cones and the armed person's route.
 * Room layout follows the camera neighbour bearings from /api/site
 * (east corridor ESE of the lobby, west corridor + stairwell WSW). Schematic, not to scale.
 */
import { S, CAM_IDS, current } from "../state.js";
import { svg, text, camNum, clockOf } from "../util.js";

// Camera mount point, cone apex angle (deg, 0 = east, clockwise), and the zone point the route passes through.
const CAMS = {
  "cam-01": { x: 300, y: 262, dir: -90, zone: [300, 196], label: [300, 290] },
  "cam-02": { x: 556, y: 175, dir: 180, zone: [470, 175], label: [556, 210] },
  "cam-03": { x: 214, y: 175, dir: 180, zone: [140, 175], label: [214, 140] },
};
const ROOMS = [
  { name: "WEST CORRIDOR", x: 40, y: 150, w: 190, h: 50, lx: 135, ly: 222 },
  { name: "LOBBY", x: 230, y: 110, w: 140, h: 170, lx: 300, ly: 102 },
  { name: "EAST CORRIDOR", x: 370, y: 150, w: 200, h: 50, lx: 470, ly: 222 },
];

export function mountMap(el) {
  const root = svg("svg", { viewBox: "28 84 556 222", class: "sitemap", preserveAspectRatio: "xMidYMid meet" }, el);
  const defs = svg("defs", {}, root);
  defs.innerHTML = `
    <pattern id="mgrid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" class="mgrid"/></pattern>
    <radialGradient id="cone-calm"><stop offset="0" stop-color="var(--ice)" stop-opacity=".35"/><stop offset="1" stop-color="var(--ice)" stop-opacity="0"/></radialGradient>
    <radialGradient id="cone-hot"><stop offset="0" stop-color="var(--hot)" stop-opacity=".6"/><stop offset="1" stop-color="var(--hot)" stop-opacity="0"/></radialGradient>`;
  svg("rect", { width: 600, height: 300, fill: "url(#mgrid)" }, root);
  const rooms = svg("g", { class: "rooms" }, root);
  for (const r of ROOMS) {
    svg("rect", { x: r.x, y: r.y, width: r.w, height: r.h, class: "room" }, rooms);
    const t = svg("text", { x: r.lx, y: r.ly, class: "room-lbl" }, rooms);
    t.textContent = r.name;
  }
  // Stairwell hatch + lobby entrance.
  const stairs = svg("g", { class: "stairs" }, rooms);
  for (let i = 0; i < 6; i++) svg("path", { d: `M${46 + i * 6} 154V196` }, stairs);
  svg("text", { x: 60, y: 142, class: "room-lbl small" }, rooms).textContent = "STAIRS";
  svg("path", { d: "M280 280h40", class: "door" }, rooms);

  const cones = svg("g", { class: "cones" }, root);
  const camEls = {};
  for (const id of CAM_IDS) {
    const c = CAMS[id];
    const g = svg("g", { class: "mcam", "data-cam": id }, cones);
    const R = id === "cam-01" ? 150 : 140, half = 24;
    const a1 = ((c.dir - half) * Math.PI) / 180, a2 = ((c.dir + half) * Math.PI) / 180;
    svg("path", { d: `M${c.x} ${c.y}L${c.x + R * Math.cos(a1)} ${c.y + R * Math.sin(a1)}A${R} ${R} 0 0 1 ${c.x + R * Math.cos(a2)} ${c.y + R * Math.sin(a2)}Z`, class: "cone" }, g);
    const sweep = svg("g", { class: "sweep", style: `transform-origin:${c.x}px ${c.y}px; --base:${c.dir}deg` }, g);
    svg("path", { d: `M${c.x} ${c.y}h${R}`, class: "sweep-line" }, sweep);
    svg("rect", { x: c.x - 11, y: c.y - 9, width: 22, height: 18, rx: 3, class: "cam-node" }, g);
    svg("text", { x: c.x, y: c.y + 4, class: "cam-node-tx" }, g).textContent = `C${camNum(id)}`;
    const badge = svg("text", { x: c.label[0], y: c.label[1], class: "cam-count" }, g);
    camEls[id] = { g, badge };
  }
  const route = svg("g", { class: "route" }, root);
  return { root, camEls, route, key: "" };
}

/** Update cones/counts every render; rebuild the route only when it changes. */
export function renderMap(m) {
  const active = current();
  const path = active ? S.routes.get(active.incident_id) || [] : [];
  for (const id of CAM_IDS) {
    const { g, badge } = m.camEls[id];
    const n = S.lastPeople[id];
    const hot = active && active.camera_id === id;
    g.setAttribute("class", `mcam ${hot ? "hot" : ""} ${S.online[id] === false ? "off" : ""} ${n ? "busy" : ""}`);
    text(badge, S.online[id] === false ? "offline" : typeof n === "number" ? `${n} in view` : "");
  }
  const key = path.map((p) => p.cam + p.ts).join("|");
  if (key === m.key) return path;
  m.key = key;
  m.route.innerHTML = "";
  if (!path.length) return path;
  const pts = path.map((p) => CAMS[p.cam]?.zone).filter(Boolean);
  if (pts.length > 1) {
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join("");
    svg("path", { d, class: "route-glow" }, m.route);
    const line = svg("path", { d, class: "route-line" }, m.route);
    line.style.setProperty("--len", line.getTotalLength?.() || 600);
  }
  // One marker per camera: visit times (latest two), origin ring on the first camera, pulse on the current one.
  const visits = {};
  path.forEach((p, i) => (visits[p.cam] ||= []).push({ ...p, i }));
  Object.entries(visits).forEach(([cam, vs], k) => {
    const z = CAMS[cam]?.zone;
    if (!z) return;
    const now = cam === path.at(-1).cam, origin = cam === path[0].cam;
    const g = svg("g", { class: `rnode ${now ? "now" : ""}`, style: `--i:${k}` }, m.route);
    if (now) svg("circle", { cx: z[0], cy: z[1], r: 14, class: "rnode-pulse" }, g);
    if (origin) svg("rect", { x: z[0] - 9, y: z[1] - 9, width: 18, height: 18, class: "rnode-origin" }, g);
    svg("circle", { cx: z[0], cy: z[1], r: now ? 6 : 4, class: "rnode-dot" }, g);
    const t = svg("text", { x: z[0], y: z[1] - 15, class: "rnode-tx" }, g);
    t.textContent = `${origin ? "origin · " : ""}${vs.slice(-2).map((v) => clockOf(v.ts)).join(" · ")}`;
  });
  return path;
}

/** "C1 → C2 → C3" text for headers. */
export const pathText = (path) => (path.length ? path.map((p) => `C${camNum(p.cam)}`).join(" → ") : "—");
