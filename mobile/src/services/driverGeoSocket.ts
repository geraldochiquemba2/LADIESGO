// GPS da motorista por WebSocket para o DO DriverGeo (Cloudflare).
// Mensagens WS NÃO contam como pedidos → elimina o limite de pedidos por ping.
// Fallback transparente para HTTP em driversApi.updateLocation.
import AsyncStorage from '@react-native-async-storage/async-storage';

const API_URL =
  // >> LADIESGO 2026-10-28: API + BD na conta Cloudflare rerere… (ladiesgo-api.rererererererere670.workers.dev). Ver cloudflare/README.md
  process.env.EXPO_PUBLIC_API_URL || 'https://ladiesgo-api.rererererererere670.workers.dev/api/v1';
const WS_URL = API_URL.replace(/^http/, 'ws') + '/drivers/live-geo';

let ws: WebSocket | null = null;
let want = false;
let retry: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  if (retry || !want) return;
  retry = setTimeout(() => {
    retry = null;
    if (want) void connect();
  }, 3000);
}

async function connect(): Promise<void> {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try {
    const token = await AsyncStorage.getItem('accessToken');
    if (!token) {
      want = false;
      return;
    }
    const sock = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    ws = sock;
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (want) schedule();
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {}
    };
  } catch {
    if (want) schedule();
  }
}

export const driverGeoSocket = {
  async start(): Promise<void> {
    want = true;
    if (ws && ws.readyState === 1) return;
    await connect();
  },
  stop(): void {
    want = false;
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    try {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ offline: true }));
    } catch {}
    try {
      ws?.close();
    } catch {}
    ws = null;
  },
  isConnected(): boolean {
    return !!ws && ws.readyState === 1;
  },
  send(lat: number, lng: number): boolean {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({ lat, lng }));
      return true;
    } catch {
      return false;
    }
  },
};
