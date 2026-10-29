import AsyncStorage from '@react-native-async-storage/async-storage';
import { LUANDA } from './geo';

// ─── Realtime adapter (Cloudflare-only) ───────────────────────────────
// Substitui o antigo socket.io (que falava com o gateway NestJS). Agora:
//   • Canal por viagem: WebSocket cru em GET /api/v1/trips/:id/live
//     (Durable Object TripPush, com hibernação — mensagens WS grátis).
//   • Mapa público: WS /drivers/nearby-live (máx. 1 frame/5 s) com o
//     polling REST (/drivers/nearby) só como fallback; pedidos via
//     WS /trips/requests-live + polling (/trips/incoming).
// Mantém a mesma interface (connect/emit/on/off/connected) para as telas
// não precisarem de mudanças profundas.

type Cb = (...args: any[]) => void;

const API = (
  // >> LADIESGO 2026-10-28: API + BD na conta Cloudflare rerere… (ladiesgo-api.rererererererere670.workers.dev). Ver cloudflare/README.md
  process.env.EXPO_PUBLIC_API_URL || 'https://ladiesgo-api.rererererererere670.workers.dev/api/v1'
).replace(/\/$/, '');
const WS_BASE = API.replace(/^http/, 'ws');
const DEFAULT_CENTER = { lat: LUANDA.latitude, lng: LUANDA.longitude };

function havKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

class RealtimeService {
  private token: string | null = null;
  private connectedFlag = false;
  private handlers = new Map<string, Set<Cb>>();

  private ws: WebSocket | null = null;
  private wsTripId: string | null = null;
  private wsRole: 'driver' | 'passenger' | null = null;
  private wsAttempts = 0;
  private reconnectT: ReturnType<typeof setTimeout> | null = null;
  private heartbeatT: ReturnType<typeof setInterval> | null = null;
  // Watchdog: se o WS ficar calado (motorista em segundo plano, push perdido),
  // vai buscar a posição viva da motorista por REST (1 pedido, não é polling
  // constante) para o mapa nunca ficar congelado.
  private tripWatchT: ReturnType<typeof setInterval> | null = null;
  private lastDriverAt = 0;

  private lastLocation: { lat: number; lng: number } | null = null;
  private lastHeading = -1;
  private tripInfo: any = null;
  private curStatus: string | null = null;
  private lastDriver: { lat: number; lng: number } | null = null;
  private lastPax: { lat: number; lng: number } | null = null;
  private lastEtaMin: number | null = null;

  private driversTimer: ReturnType<typeof setInterval> | null = null;
  // WS do mapa público: substitui o polling quando está aberto.
  private nearbyWs: WebSocket | null = null;
  private nearbyWsAttempts = 0;
  private nearbyReconnectT: ReturnType<typeof setTimeout> | null = null;
  private requestsTimer: ReturnType<typeof setInterval> | null = null;
  private requestsWs: WebSocket | null = null;
  private requestsWsAttempts = 0;
  private requestsWsEverOpen = false;
  private requestsReconnectT: ReturnType<typeof setTimeout> | null = null;
  private requestsHeartbeatT: ReturnType<typeof setInterval> | null = null;
  private requestsRefreshT: ReturnType<typeof setTimeout> | null = null;
  private seenRequests = new Set<string>();

  async connect(): Promise<void> {
    this.token = await AsyncStorage.getItem('accessToken');
    this.connectedFlag = true;
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  disconnect(): void {
    this.closeTrip();
    this.stopPublicPolls();
    this.connectedFlag = false;
  }

  /** Logout: limpa o token e fecha todos os canais. */
  logout(): void {
    this.token = null;
    this.disconnect();
  }

  // ── Canais por viagem ─────────────────────────────────────────────
  /** Abre (ou reutiliza) o WS da viagem. role define como o GPS é etiquetado. */
  openTrip(tripId: string, role: 'driver' | 'passenger'): void {
    if (!tripId) return;
    if (this.ws && this.wsTripId === tripId) {
      this.wsRole = role;
      return;
    }
    this.closeTrip();
    this.wsTripId = tripId;
    this.wsRole = role;
    this.curStatus = null;
    this.tripInfo = null;
    this.lastDriver = null;
    this.lastPax = null;
    this.lastEtaMin = null;
    this.loadTripInfo(tripId).catch(() => {});
    this.connectWs();
    this.startTripWatch();
  }

  // Rede de segurança: se não chega frame da motorista há >35s (app da
  // motorista em segundo plano, push perdido), busca a posição viva por REST.
  private startTripWatch(): void {
    this.stopTripWatch();
    this.tripWatchT = setInterval(() => {
      const tripId = this.wsTripId;
      if (!tripId) return;
      if (Date.now() - this.lastDriverAt < 35000) return;
      this.pollDriverPos(tripId);
    }, 15000);
  }

  private stopTripWatch(): void {
    if (this.tripWatchT) {
      clearInterval(this.tripWatchT);
      this.tripWatchT = null;
    }
  }

  private async pollDriverPos(tripId: string): Promise<void> {
    try {
      const res = await fetch(`${API}/trips/${tripId}`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
      });
      if (!res.ok) return;
      const t: any = await res.json();
      const d = t?.driver;
      if (!d) return;
      const la = Number(d.lat), lo = Number(d.lng);
      if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
      this.emitDriverLocation(la, lo);
    } catch {}
  }

  private closeTrip(): void {
    if (this.reconnectT) {
      clearTimeout(this.reconnectT);
      this.reconnectT = null;
    }
    this.stopTripWatch();
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    this.wsTripId = null;
    this.wsRole = null;
    this.curStatus = null;
    this.tripInfo = null;
    this.lastDriver = null;
    this.lastPax = null;
    this.lastEtaMin = null;
    try {
      ws?.close();
    } catch {}
  }

  private connectWs(): void {
    const tripId = this.wsTripId;
    if (!tripId) return;
    const q = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
    let sock: WebSocket;
    try {
      sock = new WebSocket(`${WS_BASE}/trips/${tripId}/live${q}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = sock;
    sock.onopen = () => {
      this.wsAttempts = 0;
      this.startHeartbeat();
    };
    sock.onmessage = (ev: any) => this.onWsMessage(ev);
    sock.onerror = () => {};
    sock.onclose = () => {
      this.stopHeartbeat();
      if (this.ws === sock) this.ws = null;
      if (this.wsTripId) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectT || !this.wsTripId) return;
    if (this.wsAttempts >= 10) return;
    this.wsAttempts += 1;
    const delay = Math.min(2000 * this.wsAttempts, 15000);
    this.reconnectT = setTimeout(async () => {
      this.reconnectT = null;
      this.token = (await AsyncStorage.getItem('accessToken')) || this.token;
      this.connectWs();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // 'ping' literal → auto-resposta 'pong' do DO (não acorda o objeto).
    this.heartbeatT = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === 1) this.ws.send('ping');
      } catch {}
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatT) {
      clearInterval(this.heartbeatT);
      this.heartbeatT = null;
    }
  }

  private async loadTripInfo(tripId: string): Promise<void> {
    try {
      const res = await fetch(`${API}/trips/${tripId}`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
      });
      const t = await res.json();
      if (t && t.id) {
        this.tripInfo = t;
        if (t.status && !this.curStatus) this.curStatus = t.status;
      }
    } catch {}
  }

  private async fetchDriverProfile(tripId: string): Promise<any | null> {
    try {
      const res = await fetch(`${API}/trips/${tripId}?view=web`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
      });
      const t = await res.json();
      const d = t?.driver;
      if (!d) return null;
      return { ...d, user: { name: d.name || 'Motorista', phone: d.phone || '' } };
    } catch {
      return null;
    }
  }

  private onWsMessage(ev: any): void {
    let m: any;
    try {
      m = JSON.parse(typeof ev?.data === 'string' ? ev.data : String(ev?.data));
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'hello':
        if (m.driver) this.emitDriverLocation(m.driver.lat, m.driver.lng);
        if (m.pax) this.emitPaxLocation(m.pax.lat, m.pax.lng);
        if (m.status) this.onStatus(String(m.status));
        break;
      case 'driver':
        this.emitDriverLocation(Number(m.lat), Number(m.lng));
        break;
      case 'pax':
        this.emitPaxLocation(Number(m.lat), Number(m.lng));
        break;
      case 'eta':
        this.lastEtaMin = Number(m.min) || null;
        if (this.lastDriver) this.emitDriverLocation(this.lastDriver.lat, this.lastDriver.lng);
        break;
      case 'status':
        this.onStatus(String(m.status));
        break;
      case 'chat':
        this.dispatch('server:chat-message', {
          text: String(m.text || ''),
          senderId: '',
          timestamp: new Date(Number(m.ts) || Date.now()).toISOString(),
        });
        break;
      default:
        break;
    }
  }

  private targetCoord(): { lat: number; lng: number } | null {
    const t = this.tripInfo;
    if (!t) return null;
    const inProgress = this.curStatus === 'IN_PROGRESS';
    const lat = Number(inProgress ? t.dropoffLat : t.pickupLat);
    const lng = Number(inProgress ? t.dropoffLng : t.pickupLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }

  private emitDriverLocation(lat: number, lng: number): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    this.lastDriver = { lat, lng };
    this.lastDriverAt = Date.now();
    let distanceKm: number | undefined;
    const target = this.targetCoord();
    if (target) distanceKm = Math.round(havKm(lat, lng, target.lat, target.lng) * 10) / 10;
    const etaMinutes =
      this.lastEtaMin != null
        ? this.lastEtaMin
        : distanceKm != null
          ? Math.max(1, Math.ceil((distanceKm / 30) * 60))
          : undefined;
    this.dispatch('server:driver-location', {
      lat,
      lng,
      heading: -1,
      etaMinutes,
      distanceKm,
      status: this.curStatus || undefined,
    });
  }

  private emitPaxLocation(lat: number, lng: number): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    this.lastPax = { lat, lng };
    let distanceKm: number | undefined;
    let etaMinutes: number | undefined;
    if (this.lastLocation) {
      distanceKm = Math.round(havKm(this.lastLocation.lat, this.lastLocation.lng, lat, lng) * 10) / 10;
      etaMinutes = Math.max(1, Math.ceil((distanceKm / 30) * 60));
    }
    this.dispatch('server:passenger-location', { lat, lng, distanceKm, etaMinutes });
  }

  private onStatus(status: string): void {
    const changed = this.curStatus !== status;
    this.curStatus = status;
    if (!changed) return;
    this.dispatch('server:trip-update', { status });
    if (status === 'ACCEPTED') {
      const tripId = this.wsTripId;
      if (tripId) {
        this.fetchDriverProfile(tripId)
          .then((driver) => this.dispatch('server:driver-found', { driver, status }))
          .catch(() => this.dispatch('server:driver-found', { driver: null, status }));
      } else {
        this.dispatch('server:driver-found', { driver: null, status });
      }
    }
    if (status === 'CANCELLED') this.dispatch('server:trip-cancelled', {});
  }

  // ── API de eventos (compatível com as telas) ──────────────────────
  emit(event: string, data?: any): void {
    switch (event) {
      case 'passenger:trip-request':
        if (data?.tripId) this.openTrip(String(data.tripId), 'passenger');
        break;
      case 'driver:trip-accepted':
        if (data?.tripId) this.openTrip(String(data.tripId), 'driver');
        break;
      case 'driver:location-update':
        if (data && Number.isFinite(data.lat) && Number.isFinite(data.lng)) {
          this.lastLocation = { lat: data.lat, lng: data.lng };
          this.lastHeading = Number.isFinite(data.heading) ? data.heading : -1;
          this.sendWs({ t: 'gps', role: 'driver', lat: data.lat, lng: data.lng });
        }
        break;
      case 'passenger:location-update':
        if (data && Number.isFinite(data.lat) && Number.isFinite(data.lng)) {
          this.lastLocation = { lat: data.lat, lng: data.lng };
          this.sendWs({ t: 'gps', role: 'pax', lat: data.lat, lng: data.lng });
        }
        break;
      case 'chat:message':
        if (data?.text) {
          this.sendWs({ t: 'chat', text: String(data.text) });
          if (data.tripId) this.persistChat(String(data.tripId), String(data.text)).catch(() => {});
        }
        break;
      case 'passenger:cancel-trip':
        // Cancelamento é feito pelo thunk REST (tripsApi.cancel).
        break;
      case 'driver:trip-completed':
        this.closeTrip();
        break;
      case 'join:public-drivers':
        this.startDriversPoll();
        break;
      case 'join:public-requests':
        this.startRequestsFeed();
        break;
      default:
        break;
    }
  }

  private sendWs(obj: any): void {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    } catch {}
  }

  private async persistChat(tripId: string, text: string): Promise<void> {
    try {
      await fetch(`${API}/trips/${tripId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ from: 'Eu', text }),
      });
    } catch {}
  }

  // ── Mapa público (mapa) ───────────────────────────────────────────
  isNearbyWsOpen(): boolean {
    return this.nearbyWs?.readyState === 1;
  }

  private startDriversPoll(): void {
    if (this.driversTimer) return;
    const tick = async () => {
      // WS aberto → não faz fetch (o polling é só fallback).
      if (this.isNearbyWsOpen()) return;
      const c = this.lastLocation || DEFAULT_CENTER;
      try {
        const res = await fetch(`${API}/drivers/nearby?lat=${c.lat}&lng=${c.lng}`);
        const body = await res.json();
        const list = (body?.drivers ?? body ?? []) as any[];
        this.emitNearbyDrivers(list);
      } catch {}
    };
    tick();
    this.driversTimer = setInterval(tick, 15000);
    this.connectNearbyWs();
  }

  /** Despacha public:driver-location para cada motorista + o snapshot completo (WS ou polling). */
  private emitNearbyDrivers(list: any[]): void {
    if (!Array.isArray(list)) return;
    const snapshot: { driverId: string; lat: number; lng: number; heading: number }[] = [];
    for (const d of list) {
      const lat = Number(d?.currentLat ?? d?.lat);
      const lng = Number(d?.currentLng ?? d?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const h = d?.h != null ? Number(d.h) : -1;
      const driver = {
        driverId: String(d?.id),
        lat,
        lng,
        heading: Number.isFinite(h) ? h : -1,
      };
      snapshot.push(driver);
      this.dispatch('public:driver-location', driver);
    }
    this.dispatch('public:drivers-snapshot', snapshot);
  }

  /** WS do mapa: /drivers/nearby-live (frames {t:'nearby', drivers, ts}). */
  private connectNearbyWs(): void {
    if (this.nearbyWs || this.nearbyReconnectT) return;
    if (!this.token) {
      // Sem JWT ainda: tenta ler e reagenda (o polling cobre entretanto).
      AsyncStorage.getItem('accessToken')
        .then((t) => {
          this.token = t || this.token;
          if (this.token) this.connectNearbyWs();
          else this.scheduleNearbyReconnect();
        })
        .catch(() => this.scheduleNearbyReconnect());
      return;
    }
    let sock: WebSocket;
    try {
      const q = `?token=${encodeURIComponent(this.token)}`;
      sock = new WebSocket(`${WS_BASE}/drivers/nearby-live${q}`);
    } catch {
      this.scheduleNearbyReconnect();
      return;
    }
    this.nearbyWs = sock;
    sock.onopen = () => {
      this.nearbyWsAttempts = 0;
    };
    sock.onmessage = (ev: any) => this.onNearbyMessage(ev);
    sock.onerror = () => {};
    sock.onclose = () => {
      if (this.nearbyWs === sock) this.nearbyWs = null;
      this.scheduleNearbyReconnect();
    };
  }

  private onNearbyMessage(ev: any): void {
    let m: any;
    try {
      m = JSON.parse(typeof ev?.data === 'string' ? ev.data : String(ev?.data));
    } catch {
      return;
    }
    if (!m || m.t !== 'nearby') return;
    this.emitNearbyDrivers(m.drivers);
  }

  private scheduleNearbyReconnect(): void {
    if (this.nearbyReconnectT) return;
    if (!this.driversTimer) return; // ninguém está a ouvir o mapa
    this.nearbyWsAttempts += 1;
    const delay = Math.min(3000 * this.nearbyWsAttempts, 30000);
    this.nearbyReconnectT = setTimeout(async () => {
      this.nearbyReconnectT = null;
      this.token = (await AsyncStorage.getItem('accessToken')) || this.token;
      this.connectNearbyWs();
    }, delay);
  }

  private closeNearbyWs(): void {
    if (this.nearbyReconnectT) {
      clearTimeout(this.nearbyReconnectT);
      this.nearbyReconnectT = null;
    }
    this.nearbyWsAttempts = 0;
    const ws = this.nearbyWs;
    this.nearbyWs = null;
    try {
      ws?.close();
    } catch {}
  }

  private startRequestsFeed(): void {
    if (this.requestsWs || this.requestsTimer || this.requestsReconnectT) return;
    this.connectRequestsWs();
  }

  private connectRequestsWs(): void {
    if (this.requestsWs) return;
    let sock: WebSocket;
    try {
      const q = this.token ? `?token=${encodeURIComponent(this.token)}` : '';
      sock = new WebSocket(`${WS_BASE}/trips/requests-live${q}`);
    } catch {
      this.startRequestsFallback();
      this.scheduleRequestsReconnect();
      return;
    }
    this.requestsWs = sock;
    sock.onopen = () => {
      this.requestsWsAttempts = 0;
      this.requestsWsEverOpen = true;
      this.stopRequestsFallback();
      this.startRequestsHeartbeat();
      this.fetchIncoming();
    };
    sock.onmessage = (ev: any) => {
      let m: any;
      try { m = JSON.parse(typeof ev?.data === 'string' ? ev.data : String(ev?.data)); } catch { return; }
      if (m && m.t === 'refresh') this.scheduleIncomingRefresh();
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      this.stopRequestsHeartbeat();
      if (this.requestsWs === sock) this.requestsWs = null;
      if (!this.handlers.get('public:requests-snapshot')?.size && !this.handlers.get('server:new-trip-request')?.size) return;
      this.startRequestsFallback();
      this.scheduleRequestsReconnect();
    };
  }

  private scheduleRequestsReconnect(): void {
    if (this.requestsReconnectT) return;
    if (!this.requestsWsEverOpen && this.requestsWsAttempts >= 3) return;
    this.requestsWsAttempts += 1;
    const delay = Math.min(3000 * this.requestsWsAttempts, 30000);
    this.requestsReconnectT = setTimeout(async () => {
      this.requestsReconnectT = null;
      this.token = (await AsyncStorage.getItem('accessToken')) || this.token;
      this.connectRequestsWs();
    }, delay);
  }

  private startRequestsHeartbeat(): void {
    this.stopRequestsHeartbeat();
    this.requestsHeartbeatT = setInterval(() => {
      try { if (this.requestsWs && this.requestsWs.readyState === 1) this.requestsWs.send('ping'); } catch {}
    }, 25000);
  }

  private stopRequestsHeartbeat(): void {
    if (this.requestsHeartbeatT) { clearInterval(this.requestsHeartbeatT); this.requestsHeartbeatT = null; }
  }

  private scheduleIncomingRefresh(): void {
    if (this.requestsRefreshT) return;
    this.requestsRefreshT = setTimeout(() => {
      this.requestsRefreshT = null;
      this.fetchIncoming();
    }, 1200);
  }

  private startRequestsFallback(): void {
    if (this.requestsTimer) return;
    this.requestsTimer = setInterval(() => this.fetchIncoming(), 30000);
  }

  private stopRequestsFallback(): void {
    if (this.requestsTimer) { clearInterval(this.requestsTimer); this.requestsTimer = null; }
  }

  private async fetchIncoming(): Promise<void> {
    try {
      const res = await fetch(`${API}/trips/incoming`, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : undefined,
      });
      const body = await res.json();
      const rows = (body?.trips ?? []) as any[];
      const pin = (r: any) => ({
        id: String(r.id),
        pickupLat: Number(r?.pickup?.lat ?? r.pickupLat),
        pickupLng: Number(r?.pickup?.lng ?? r.pickupLng),
        pickupAddress: String(r?.pickup?.name ?? r.pickupAddress ?? ''),
        fareEstimate: Number(r?.fare ?? r.fareEstimate ?? 0),
        rideType: r.rideType,
        tripType: r.tripType,
        status: r.status,
      });
      const list = rows.map(pin).filter((p: any) => Number.isFinite(p.pickupLat) && Number.isFinite(p.pickupLng));
      this.dispatch('public:requests-snapshot', list);
      // Auto-popup só na primeira vez que cada pedido aparece (rejeitar não volta a abrir).
      for (const r of rows) {
        const id = String(r?.id || '');
        if (!id || this.seenRequests.has(id)) continue;
        this.seenRequests.add(id);
        this.dispatch('server:new-trip-request', {
          trip: {
            id,
            pickupAddress: r?.pickup?.name || '',
            dropoffAddress: `${r?.dest?.n || ''}${r?.dest?.a ? ' · ' + r.dest.a : ''}`,
            pickupLat: Number(r?.pickup?.lat),
            pickupLng: Number(r?.pickup?.lng),
            dropoffLat: Number(r?.dest?.lat),
            dropoffLng: Number(r?.dest?.lng),
            fareEstimate: Number(r?.fare || 0),
            rideType: r?.rideType,
            tripType: r?.tripType,
            paymentMethod: r?.pay === 'Cartão' ? 'CARD' : 'CASH',
            scheduledAt: r?.scheduledAt || undefined,
          },
          passenger: { name: r?.passengerName || r?.passenger_name || 'Passageira', photo: r?.passengerPhoto || r?.passenger_photo || '' },
        });
      }
    } catch {}
  }

  private stopRequestsFeed(): void {
    if (this.requestsReconnectT) { clearTimeout(this.requestsReconnectT); this.requestsReconnectT = null; }
    if (this.requestsRefreshT) { clearTimeout(this.requestsRefreshT); this.requestsRefreshT = null; }
    this.stopRequestsHeartbeat();
    this.stopRequestsFallback();
    const ws = this.requestsWs;
    this.requestsWs = null;
    this.requestsWsEverOpen = false;
    try { ws?.close(); } catch {}
  }

  private stopPublicPolls(): void {
    if (this.driversTimer) {
      clearInterval(this.driversTimer);
      this.driversTimer = null;
    }
    this.closeNearbyWs();
    this.stopRequestsFeed();
  }

  on(event: string, cb: Cb): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(cb);
  }

  off(event: string, cb?: Cb): void {
    if (cb) {
      this.handlers.get(event)?.delete(cb);
    } else {
      this.handlers.delete(event);
    }
    if (event === 'public:driver-location' && !this.handlers.get(event)?.size) this.stopDriversPollStop();
    if (event === 'public:requests-snapshot' && !this.handlers.get(event)?.size) this.stopRequestsFeed();
  }

  private stopDriversPollStop(): void {
    if (this.driversTimer) {
      clearInterval(this.driversTimer);
      this.driversTimer = null;
    }
    this.closeNearbyWs();
  }

  private dispatch(event: string, data?: any): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try {
        cb(data);
      } catch {}
    }
  }
}

export const socketService = new RealtimeService();
