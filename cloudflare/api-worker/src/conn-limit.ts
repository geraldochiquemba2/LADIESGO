// Fase 2 — Connection limits, heartbeat, idle timeout, load shedding
export const WS_MAX_CONNECTIONS = 1000;
export const WS_SHEDDING_THRESHOLD = 800;
export const WS_HEARTBEAT_MS = 30_000;
export const WS_IDLE_TIMEOUT_MS = 60_000;
export const WS_MAX_MESSAGE_BYTES = 64 * 1024;

// Heartbeat via DO alarm (sobrevive hibernação)
export async function armHeartbeat(ws: any, alarmMs: number) {
  try { const att = (ws.deserializeAttachment && ws.deserializeAttachment()) || {}; att.nextPingAt = Date.now() + alarmMs; ws.serializeAttachment(att); } catch {}
}
