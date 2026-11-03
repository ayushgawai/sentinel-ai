/** Hash router: #/live #/evidence #/call #/system with an animated page swap. */
import { $ } from "./util.js";

export const ROUTES = ["live", "evidence", "call", "system"];
let active = null;
const listeners = new Set();
export const onRoute = (fn) => listeners.add(fn);
export const route = () => active;

function show() {
  const name = location.hash.replace(/^#\/?/, "");
  const next = ROUTES.includes(name) ? name : "live";
  if (next === active) return;
  const prevIdx = ROUTES.indexOf(active);
  const dir = prevIdx < 0 || ROUTES.indexOf(next) > prevIdx ? 1 : -1;
  document.documentElement.style.setProperty("--dir", dir);
  for (const page of document.querySelectorAll(".page")) {
    const on = page.dataset.route === next;
    page.classList.toggle("active", on);
    page.classList.toggle("leaving", !on && page.dataset.route === active);
  }
  for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("on", a.dataset.route === next);
  moveInk(next);
  active = next;
  listeners.forEach((fn) => fn(next));
}

function moveInk(name) {
  const tab = document.querySelector(`#tabs a[data-route="${name}"]`);
  const ink = $("tab-ink");
  if (!tab || !ink) return;
  ink.style.transform = `translateX(${tab.offsetLeft}px)`;
  ink.style.width = `${tab.offsetWidth}px`;
}

export function go(name) {
  location.hash = `#/${name}`;
}

export function startRouter() {
  addEventListener("hashchange", show);
  addEventListener("resize", () => moveInk(active));
  show();
}
