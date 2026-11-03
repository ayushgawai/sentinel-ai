/** Boot: mount UI, connect the stream, poll the API, render the active page on every state change. */
import * as api from "./api.js";
import { connect } from "./ws.js";
import { S, apply, subscribe, changed } from "./state.js";
import { startRouter, onRoute, route } from "./router.js";
import { startVideo } from "./ui/camera.js";
import { mountTopbar, renderTopbar, tickTopbar } from "./ui/topbar.js";
import { renderStrip } from "./ui/strip.js";
import { bindKeys } from "./ui/actions.js";
import { mountLive, renderLive } from "./pages/live.js";
import { mountEvidence, renderEvidence } from "./pages/evidence.js";
import { mountCall, renderCall } from "./pages/call.js";
import { mountSystem, renderSystem } from "./pages/system.js";

const PAGES = { live: renderLive, evidence: renderEvidence, call: renderCall, system: renderSystem };

/** Poll a GET endpoint into state every `everyMs` (0 = until it succeeds once). */
function poll(path, everyMs, map) {
  const run = async () => {
    const res = await api.get(path);
    if (res.ok) {
      Object.assign(S, map(res.data));
      changed();
    }
    if (everyMs || !res.ok) setTimeout(run, everyMs || 3000);
  };
  run();
}

function boot() {
  mountTopbar();
  mountLive();
  mountEvidence();
  mountCall();
  mountSystem();
  bindKeys();
  startVideo();

  subscribe(() => {
    renderTopbar();
    renderStrip();
    PAGES[route()]?.();
  });
  onRoute(() => changed());
  startRouter();

  poll("/api/site", 0, (d) => ({ site: d.site, cams: Object.fromEntries((d.cameras || []).map((c) => [c.camera_id, c])) }));
  poll("/api/mode", 30000, (d) => ({ mode: d }));
  poll("/api/track", 3000, (d) => ({ track: d }));
  poll("/voice/status", 15000, (d) => ({ voice: d }));

  connect(apply, (st) => { S.conn = st; changed(); });

  tickTopbar();
  setInterval(() => { tickTopbar(); changed(); }, 1000);
}

boot();
