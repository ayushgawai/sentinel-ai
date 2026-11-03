/** HTTP side of the backend: endpoints, GET polling and operator POSTs. */

const qs = new URLSearchParams(location.search);
export const API = (qs.get("api") || `http://${location.hostname || "127.0.0.1"}:8180`).replace(/\/$/, "");
export const WS_URL = qs.get("ws") || `${API.replace(/^http/, "ws")}/ws`;
export const mjpegUrl = (camId) => `${API}/mjpeg/${camId}`;

const TIMEOUT_MS = 8000;

async function request(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API + path, { ...opts, signal: ctrl.signal });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const msg = data?.error || data?.detail || data?.message || `HTTP ${res.status}`;
      return { ok: false, message: typeof msg === "string" ? msg : JSON.stringify(msg) };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: e.name === "AbortError" ? "Backend timed out" : "Backend unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export const get = (path) => request(path);
const post = (path, body = {}) =>
  request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const inc = (id) => `/api/incidents/${encodeURIComponent(id)}`;
export const dispatch = (id) => post(`${inc(id)}/dispatch`, { requested_by: "operator", reason: "Operator call for help" });
export const confirm = (id) => post(`${inc(id)}/confirm`, {});
export const dismiss = (id, reason) => post(`${inc(id)}/dismiss`, { reason });
export const broadcast = ({ incidentId, audience, message }) =>
  post("/api/broadcast", { ...(incidentId ? { incident_id: incidentId } : {}), audience, message });
export const manualIncident = ({ cameraId, classToken, severity, note }) =>
  post("/api/incidents/manual", { camera_id: cameraId, class_token: classToken, severity, note });
