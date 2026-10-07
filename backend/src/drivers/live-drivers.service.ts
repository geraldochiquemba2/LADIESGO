import { Injectable } from '@nestjs/common';

export const KNOWN_CATS = ['Económico', 'Conforto', 'Família'];
export const LIVE_TTL_MS = 45000;

export interface LiveDriver {
  id: string;
  name: string;
  lat: number;
  lng: number;
  cats: string[];
  carMake?: string;
  carPlate?: string;
  ts: number;
}

// Posições em tempo real das motoristas (web): a app publica a cada poucos
// segundos via POST /drivers/position. Sem DB — expira sozinho (TTL).
@Injectable()
export class LiveDriversService {
  private drivers = new Map<string, LiveDriver>();

  upsert(d: Omit<LiveDriver, 'ts'>) {
    const cats = (d.cats ?? []).filter((c) => KNOWN_CATS.includes(c));
    this.drivers.set(d.id, {
      ...d,
      name: (d.name || 'Motorista').slice(0, 40),
      cats: cats.length ? cats : [...KNOWN_CATS],
      ts: Date.now(),
    });
  }

  remove(id: string) {
    this.drivers.delete(id);
  }

  list(): LiveDriver[] {
    const now = Date.now();
    const out: LiveDriver[] = [];
    for (const [id, d] of this.drivers) {
      if (now - d.ts > LIVE_TTL_MS) {
        this.drivers.delete(id);
        continue;
      }
      out.push(d);
    }
    return out;
  }
}
