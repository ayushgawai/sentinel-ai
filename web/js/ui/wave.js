/**
 * Call waveform. Bars swell for a few seconds after each real transcript line
 * (someone is speaking) and settle to a flat carrier when the line is quiet.
 */
import { svg, reducedMotion } from "../util.js";

const waves = new Set();

export function mountWave(el, bars = 96) {
  el.setAttribute("viewBox", `0 0 ${bars * 6} 60`);
  const w = { el, bars: [], level: 0, target: 0, speaker: "sentinel", phase: Math.random() * 10 };
  for (let i = 0; i < bars; i++) w.bars.push(svg("rect", { x: i * 6 + 1, width: 3.2, rx: 1.6, y: 29, height: 2 }, el));
  waves.add(w);
  if (waves.size === 1) requestAnimationFrame(loop);
  return w;
}

/** Called each render: `lastLine` is the newest transcript line or null; `on` = call active. */
export function setWave(w, lastLine, on) {
  const age = lastLine ? (Date.now() - Date.parse(lastLine.ts)) / 1000 : Infinity;
  w.target = !on ? 0 : age < 5 ? 1 : 0.22;
  w.speaker = lastLine?.speaker === "dispatcher" ? "dispatcher" : "sentinel";
  w.el.dataset.speaker = w.speaker;
  w.el.classList.toggle("on", !!on);
}

function loop(t) {
  for (const w of waves) {
    if (w.el.getBoundingClientRect().width === 0) continue;
    w.level += (w.target - w.level) * 0.06;
    const n = w.bars.length;
    w.bars.forEach((b, i) => {
      const env = Math.sin((i / n) * Math.PI) * 0.6 + 0.4;
      const noise = reducedMotion() ? 0.5 : (Math.sin(t / 90 + i * 1.7 + w.phase) * Math.sin(t / 230 + i * 0.37) + 1) / 2;
      const hgt = 2 + 54 * w.level * env * noise;
      b.setAttribute("y", 30 - hgt / 2);
      b.setAttribute("height", hgt);
    });
  }
  requestAnimationFrame(loop);
}
