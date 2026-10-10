import { Injectable } from '@nestjs/common';

export const TRIP_LIVE_TTL_MS = 60000;

export interface LiveSidePosition {
  lat: number;
  lng: number;
  ts: number;
}

// Posição live da PASSAGEIRA dentro de uma viagem (a motorista vê no mapa).
// Espelho do LiveDriversService, mas por viagem e só entre participantes:
// a motorista já partilha via POST /drivers/position; a passageira não
// tinha canal nenhum. Sem DB — expira sozinho (TTL).
@Injectable()
export class LiveTripPositionsService {
  private trips = new Map<string, { passenger?: LiveSidePosition; driver?: LiveSidePosition }>();

  upsert(tripId: string, side: 'passenger' | 'driver', lat: number, lng: number) {
    const cur = this.trips.get(tripId) || {};
    cur[side] = { lat, lng, ts: Date.now() };
    this.trips.set(tripId, cur);
  }

  get(tripId: string): { passenger?: LiveSidePosition; driver?: LiveSidePosition } | null {
    const cur = this.trips.get(tripId);
    if (!cur) return null;
    const now = Date.now();
    let touched = false;
    for (const side of ['passenger', 'driver'] as const) {
      const p = cur[side];
      if (p && now - p.ts > TRIP_LIVE_TTL_MS) {
        delete cur[side];
        touched = true;
      }
    }
    if (!cur.passenger && !cur.driver) {
      this.trips.delete(tripId);
      return null;
    }
    if (touched) this.trips.set(tripId, cur);
    return cur;
  }

  clear(tripId: string) {
    this.trips.delete(tripId);
  }
}
