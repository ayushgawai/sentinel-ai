/** WebSocket transport with reconnect. Every parsed event goes to `onEvent`. */
import { WS_URL } from "./api.js";

let sock = null;
let retry = 0;

export function connect(onEvent, onStatus) {
  onStatus("connecting");
  sock = new WebSocket(WS_URL);
  sock.onopen = () => { retry = 0; onStatus("live"); };
  sock.onmessage = (m) => {
    let e;
    try { e = JSON.parse(m.data); } catch { return; }
    if (e && typeof e === "object") onEvent(e);
  };
  sock.onclose = () => {
    onStatus("offline");
    setTimeout(() => connect(onEvent, onStatus), Math.min(8000, 500 * 2 ** retry++));
  };
}

export function send(cmd) {
  if (sock?.readyState !== WebSocket.OPEN) return false;
  sock.send(JSON.stringify(cmd));
  return true;
}
