import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TripsService, pinForTrip } from './trips.service';
import { LiveDriversService } from '../drivers/live-drivers.service';
import { WebRequestTripDto, TripStatusDto } from './dto/web-trip.dto';

// Compatibilidade com a página web (/home): mesmos caminhos e formatos da
// época do mock, mas persistidos no Neon. A app móvel usa as rotas nativas.
const WEB_TO_RIDE: Record<string, string> = {
  'Económico': 'ECONOMY',
  'Conforto': 'COMFORT',
  'Família': 'COMFORT',
};
const RIDE_TO_WEB: Record<string, string> = {
  ECONOMY: 'Económico',
  COMFORT: 'Conforto',
  PREMIUM: 'Conforto',
};
const DB_TO_WEB_STATUS: Record<string, string> = {
  REQUESTED: 'pending',
  ACCEPTED: 'accepted',
  DRIVER_ARRIVED: 'arrived',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const toPay = (p?: string) => (/cart|card|multicaixa|tpa/i.test(p || '') ? 'CARD' : 'CASH');
const payToWeb = (p?: string) => (p === 'CARD' ? 'Cartão' : 'Numerário');

// PIN estável por viagem (algoritmo único em trips.service: pinForTrip).
function pinFor(id: string): string {
  return pinForTrip(id);
}

// Nomes genéricos que o geocoder do cliente deixa quando falha.
const GENERIC_PLACE = ['ponto no mapa', 'local atual', 'ponto', 'destino', 'local'];

// Último recurso no servidor: morada legível via Nominatim para a fatura,
// o painel e a motorista não verem "Ponto no mapa".
async function revName(lat: number, lng: number): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16`,
      { headers: { 'User-Agent': 'LadiesGo/1.0' }, signal: ctl.signal },
    );
    clearTimeout(to);
    if (!r.ok) return null;
    const j: any = await r.json();
    const a = j?.address || {};
    const name = a.road || a.suburb || a.neighbourhood || a.city_district || a.city || a.town || a.village || null;
    return typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : null;
  } catch {
    return null;
  }
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

@Injectable()
export class WebTripsService {
  constructor(
    private prisma: PrismaService,
    private trips: TripsService,
    private live: LiveDriversService,
  ) {}

  private lastSweep = 0;

  // Pedidos mortos: REQUESTED sem motorista há +10min (ou agendados há muito
  // passados) passam a CANCELLED sozinhos — a motorista deixa de os ver e
  // a passageira, se voltar, vê "cancelada" em vez de espera infinita.
  private isStale(t: { createdAt: Date; scheduledAt: Date | null }): boolean {
    const now = Date.now();
    if (t.createdAt.getTime() > now - 10 * 60 * 1000) return false;
    if (!t.scheduledAt) return true;
    return t.scheduledAt.getTime() < now - 15 * 60 * 1000;
  }

  private async sweepStale() {
    const now = Date.now();
    if (now - this.lastSweep < 60 * 1000) return;
    this.lastSweep = now;
    try {
      await this.prisma.trip.updateMany({
        where: {
          status: 'REQUESTED',
          createdAt: { lt: new Date(now - 10 * 60 * 1000) },
          OR: [{ scheduledAt: null }, { scheduledAt: { lt: new Date(now - 15 * 60 * 1000) } }],
        },
        data: { status: 'CANCELLED', cancelledBy: 'system', cancelReason: 'Sem resposta das motoristas' },
      });
    } catch {}
  }

  // ---- Pedido da passageira (POST /trips/request-web) ----
  async requestWebTrip(callerId: string, dto: WebRequestTripDto) {
    if (dto.passengerId !== callerId) {
      throw new ForbiddenException('Só podes pedir viagens para a tua conta.');
    }
    // Avaliação obrigatória: há viagem concluída por avaliar? Primeiro avalia.
    const unrated = await this.prisma.trip.findFirst({
      where: { passengerId: callerId, status: 'COMPLETED', ratings: { none: { raterId: callerId } } },
      select: { id: true },
    });
    if (unrated) {
      throw new ConflictException('Avalia a tua última viagem antes de pedir outra.');
    }
    for (const [k, v] of Object.entries({ pickupLat: dto.pickupLat, pickupLng: dto.pickupLng, destLat: dto.destLat, destLng: dto.destLng })) {
      if (!Number.isFinite(v)) throw new BadRequestException(`Coordenada inválida: ${k}`);
    }
    const n = (dto.destN || '').trim().slice(0, 60) || 'Destino';
    const a = (dto.destA || '').trim().slice(0, 80);

    // Viagem já aceite/a decorrer bloqueia novo pedido (evita 2 destinos ativos).
    const ongoing = await this.prisma.trip.findFirst({
      where: { passengerId: callerId, status: { in: ['ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'] } },
      select: { id: true },
    });
    if (ongoing) {
      throw new ConflictException('Já tens uma viagem em curso. Cancela-a antes de pedir outra.');
    }
    // Um REQUESTED ainda sem motorista não bloqueia novo pedido — substitui.
    const activeTrip = await this.prisma.trip.findFirst({
      where: { passengerId: callerId, status: 'REQUESTED' },
    });    if (activeTrip) {
      await this.prisma.trip.update({
        where: { id: activeTrip.id },
        data: { status: 'CANCELLED', cancelledBy: callerId, cancelReason: 'Replaced by new booking' },
      });
    }

    const cleanStops = Array.isArray(dto.stops)
      ? dto.stops
          .slice(0, 3)
          .map((s) => ({
            n: typeof s?.n === 'string' ? s.n.slice(0, 60) : '',
            a: typeof s?.a === 'string' ? s.a.slice(0, 80) : '',
            lat: Number(s?.lat),
            lng: Number(s?.lng),
          }))
          .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
      : [];

    // Nomes para a fatura: preenche os genéricos em falta via Nominatim.
    let pickupName = (dto.pickupName || '').trim();
    if (!pickupName || GENERIC_PLACE.includes(pickupName.toLowerCase())) {
      pickupName = (await revName(dto.pickupLat, dto.pickupLng)) || 'Ponto no mapa';
    }
    await Promise.all(
      cleanStops.map(async (s) => {
        if ((!s.n && !s.a) || GENERIC_PLACE.includes((s.n || '').toLowerCase())) {
          const nm = await revName(s.lat, s.lng);
          if (nm) {
            s.n = nm;
            if (!s.a) s.a = '';
          } else if (!s.n) {
            s.n = 'Paragem';
          }
        }
      }),
    );

    const trip = await this.prisma.trip.create({
      data: {
        passengerId: callerId,
        pickupAddress: pickupName.slice(0, 80),
        pickupLat: dto.pickupLat,
        pickupLng: dto.pickupLng,
        dropoffAddress: a ? `${n} · ${a}` : n,
        dropoffLat: dto.destLat,
        dropoffLng: dto.destLng,
        rideType: (WEB_TO_RIDE[dto.cat || ''] || 'ECONOMY') as any,
        fareEstimate: Math.max(0, Math.round(Number(dto.fare)) || 0),
        distanceKm: haversine(dto.pickupLat, dto.pickupLng, dto.destLat, dto.destLng),
        paymentMethod: toPay(dto.pay) as any,
        scheduledAt: dto.scheduledAt && dto.scheduledAt > Date.now() ? new Date(dto.scheduledAt) : null,
        stops: cleanStops,
      },
    });
    return { id: trip.id, status: 'pending' };
  }

  // ---- Uma viagem no formato da página (?view=web) ----
  async getWebTrip(tripId: string, userId: string) {
    let trip = await this.assertAccess(tripId, userId);
    if (trip.status === 'REQUESTED' && this.isStale(trip)) {
      try {
        trip = await this.prisma.trip.update({
          where: { id: tripId },
          data: { status: 'CANCELLED', cancelledBy: 'system', cancelReason: 'Sem resposta das motoristas' },
          include: {
            passenger: { select: { name: true, phone: true } },
            driver: { include: { user: { select: { name: true, phone: true } } } },
          },
        });
      } catch {}
    }
    const isPax = trip.passengerId === userId;
    const isDrv = !!trip.driver && trip.driver.userId === userId;
    // Telefones só para os próprios intervenientes (nunca em listagens).
    // PIN só para a passageira: a motorista tem de o pedir e digitar.
    return this.formatTrip(trip, { driverPhone: isPax || isDrv, passengerPhone: isDrv, showPin: isPax });
  }

  // ---- Pedidos à espera de motorista (GET /trips/incoming) ----
  async incoming(callerId: string, driverIdParam?: string) {
    if (driverIdParam && driverIdParam !== callerId) {
      throw new ForbiddenException('Só podes ver os teus pedidos.');
    }
    await this.assertDriver(callerId);
    await this.sweepStale();
    const now = Date.now();
    const trips = await this.prisma.trip.findMany({
      where: {
        status: 'REQUESTED',
        OR: [
          { scheduledAt: null, createdAt: { gte: new Date(now - 10 * 60 * 1000) } },
          { scheduledAt: { gte: new Date(now - 15 * 60 * 1000), lte: new Date(now + 60 * 60 * 1000) } },
        ],
      },
      include: { passenger: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    // "X viram": regista que esta motorista viu cada pedido.
    for (const t of trips) {
      const seen = new Set<string>(Array.isArray((t as any).viewedBy) ? ((t as any).viewedBy as string[]) : []);
      if (!seen.has(callerId)) {
        seen.add(callerId);
        await this.prisma.trip.update({
          where: { id: t.id },
          data: { viewedBy: [...seen] as any },
        });
        (t as any).viewedBy = [...seen];
      }
    }
    return { trips: trips.map((t) => this.formatTrip(t)) };
  }

  // ---- Histórico (?passengerId= ou ?driverId= — tem de ser o próprio) ----
  async history(callerId: string, passengerId?: string, driverId?: string) {
    for (const id of [passengerId, driverId]) {
      if (id && id !== callerId) throw new ForbiddenException('Só podes ver o teu histórico.');
    }
    const or: any[] = [];
    if (passengerId) or.push({ passengerId });
    if (driverId) or.push({ driver: { userId: driverId } });
    if (!or.length) or.push({ passengerId: callerId });
    const trips = await this.prisma.trip.findMany({
      where: { OR: or },
      include: {
        passenger: { select: { name: true, phone: true } },
        driver: { include: { user: { select: { name: true, phone: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return {
      trips: trips.map((t) => {
        const w = this.formatTrip(t);
        const isPax = t.passengerId === callerId;
        return {
          id: w.id,
          dest: w.dest.n + (w.dest.a ? ' · ' + w.dest.a : ''),
          fare: w.fare,
          cat: w.cat,
          status: w.status,
          by: w.by,
          reason: w.reason,
          other: isPax ? w.driverName || '' : w.passengerName,
          ts: w.ts,
          from: w.pickup.name,
          pay: w.pay,
          stopsN: w.stops.length,
          stops: w.stops.map((s: any) => ({ n: s.n || '' })),
        };
      }),
    };
  }

  // ---- Chat da viagem ----
  async chatGet(tripId: string, userId: string, since?: string) {
    await this.assertAccess(tripId, userId);
    const sinceMs = Number(since) || 0;
    const msgs = await this.prisma.chatMessage.findMany({
      where: { tripId, createdAt: { gt: new Date(sinceMs) } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    return { msgs: msgs.map((m) => ({ from: m.senderName || '?', text: m.text, ts: m.createdAt.getTime() })) };
  }

  async chatPost(tripId: string, userId: string, from: string | undefined, text: string) {
    await this.assertAccess(tripId, userId);
    const clean = (text || '').trim().slice(0, 300);
    if (!clean) throw new BadRequestException('Mensagem vazia.');
    await this.prisma.chatMessage.create({
      data: { tripId, senderId: userId, senderName: (from || '').slice(0, 40) || 'Eu', text: clean },
    });
    return { ok: true };
  }

  // ---- Sinalização da chamada de voz (só intervenientes) ----
  private async assertParticipant(tripId: string, userId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: { driver: { select: { userId: true } } },
    });
    if (!trip) throw new NotFoundException('Viagem não encontrada.');
    const ok = trip.passengerId === userId || (!!trip.driver && trip.driver.userId === userId);
    if (!ok) throw new ForbiddenException('Sem acesso a esta viagem.');
    return trip;
  }

  private static readonly CALL_TYPES = ['offer', 'answer', 'ice', 'reject', 'end', 'cancel'];

  async callPost(tripId: string, userId: string, type: string, payload?: any) {
    await this.assertParticipant(tripId, userId);
    if (WebTripsService.CALL_TYPES.indexOf(String(type)) < 0) {
      throw new BadRequestException('Sinal inválido.');
    }
    const row = await this.prisma.callSignal.create({
      data: { tripId, senderId: userId, type: String(type), payload: payload ?? null },
    });
    // Higiene: apaga sinais com +10min (sem bloquear).
    void this.prisma.callSignal
      .deleteMany({ where: { tripId, createdAt: { lt: new Date(Date.now() - 10 * 60 * 1000) } } })
      .catch(() => {});
    return { ok: true, ts: row.createdAt.getTime() };
  }

  async callGet(tripId: string, userId: string, since?: string) {
    await this.assertParticipant(tripId, userId);
    const sinceMs = Number(since) || 0;
    // Sem `since` (primeira sondagem): só últimos 60s pelo relógio do
    // servidor — evita tocar por chamadas antigas e dispensa o relógio do
    // telemóvel (que pode estar adiantado e filtrar tudo).
    const cutoff = sinceMs > 0 ? sinceMs : Date.now() - 60 * 1000;
    const rows = await this.prisma.callSignal.findMany({
      where: { tripId, createdAt: { gt: new Date(cutoff) } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    return {
      signals: rows.map((s) => ({ from: s.senderId, type: s.type, payload: s.payload, ts: s.createdAt.getTime() })),
      now: Date.now(),
    };
  }
  async tripStatus(tripId: string, userId: string, body: TripStatusDto) {
    const st = String(body.status || '');
    if (st === 'accepted') {
      if (body.driverId && body.driverId !== userId) {
        throw new ForbiddenException('Só podes aceitar como tu.');
      }
      await this.assertDriver(userId);
      await this.trips.acceptTrip(tripId, userId);
      return { ok: true, status: 'accepted' };
    }
    if (st === 'arrived') {
      await this.trips.markArrived(tripId, userId);
      return { ok: true, status: 'arrived' };
    }
    if (st === 'in_progress') {
      await this.trips.startTrip(tripId, userId, body.pin);
      return { ok: true, status: 'in_progress' };
    }
    if (st === 'completed') {
      await this.trips.completeTrip(tripId, userId);
      return { ok: true, status: 'completed' };
    }
    if (st === 'cancelled') {
      // A página permite cancelar em qualquer fase ativa (a app nativa é
      // mais restrita e mantém as regras próprias no endpoint nativo).
      const trip = await this.prisma.trip.findUnique({
        where: { id: tripId },
        include: { driver: { select: { userId: true } } },
      });
      if (!trip) throw new NotFoundException('Viagem não encontrada.');
      const isPax = trip.passengerId === userId;
      const isDrv = !!trip.driver && trip.driver.userId === userId;
      if (!isPax && !isDrv) throw new ForbiddenException('Sem acesso a esta viagem.');
      if (['COMPLETED', 'CANCELLED'].includes(trip.status)) {
        throw new BadRequestException('Viagem já terminada.');
      }
      await this.prisma.trip.update({
        where: { id: tripId },
        data: { status: 'CANCELLED', cancelledBy: userId, cancelReason: (body.reason || '').slice(0, 80) || null },
      });
      return { ok: true, status: 'cancelled' };
    }
    throw new BadRequestException('Transição inválida.');
  }

  // ---- Formato exato que a página web espera ----
  formatTrip(t: any, opts?: { driverPhone?: boolean; passengerPhone?: boolean; showPin?: boolean }) {
    const [n, ...rest] = String(t.dropoffAddress || '').split(' · ');
    const driverUserId = t.driver?.userId || null;
    let live: any = null;
    if (driverUserId) {
      live = this.live.list().find((d) => d.id === driverUserId) || null;
    }
    const viewedBy: string[] = Array.isArray(t.viewedBy) ? t.viewedBy : [];
    return {
      id: t.id,
      passengerId: t.passengerId,
      passengerName: t.passenger?.name || t.passenger?.phone || 'Passageira',
      passengerPhone: opts?.passengerPhone ? t.passenger?.phone || null : null,
      pickup: { lat: t.pickupLat, lng: t.pickupLng, name: t.pickupAddress },
      dest: { n, a: rest.join(' · '), lat: t.dropoffLat, lng: t.dropoffLng },
      stops: Array.isArray(t.stops) ? t.stops : [],
      pay: payToWeb(t.paymentMethod),
      fare: t.finalFare ?? t.fareEstimate,
      fareEstimate: t.fareEstimate,
      distanceKm: t.distanceKm ?? null,
      cat: RIDE_TO_WEB[t.rideType] || 'Económico',
      status: DB_TO_WEB_STATUS[t.status] || 'pending',
      scheduledAt: t.scheduledAt ? new Date(t.scheduledAt).getTime() : 0,
      ts: new Date(t.createdAt).getTime(),
      views: viewedBy.length,
      by: this.byLabel(t),
      reason: t.cancelReason || '',
      pin: opts?.showPin ? pinFor(t.id) : null,
      driverId: driverUserId,
      driverName: t.driver?.user?.name || t.driver?.user?.phone || null,
      driver: driverUserId
        ? {
            lat: live ? live.lat : (t.driver?.currentLat ?? null),
            lng: live ? live.lng : (t.driver?.currentLng ?? null),
            name: t.driver?.user?.name || t.driver?.user?.phone || 'Motorista',
            phone: opts?.driverPhone ? t.driver?.user?.phone || null : null,
            rating: t.driver?.rating ?? null,
            totalTrips: t.driver?.totalTrips ?? null,
            carMake: t.driver?.carMake ?? null,
            carModel: t.driver?.carModel ?? null,
            carColor: t.driver?.carColor ?? null,
            carPlate: t.driver?.carPlate ?? t.vehiclePlate ?? null,
            snapLabel: t.vehicleLabel ?? null,
            snapPlate: t.vehiclePlate ?? null,
          }
        : null,
    };
  }

  private byLabel(t: any): string {
    if (t.status !== 'CANCELLED') return '';
    if (t.cancelledBy && t.cancelledBy === t.passengerId) return 'passenger';
    if (t.cancelledBy && t.driver && t.cancelledBy === t.driver.userId) return 'driver';
    return t.cancelledBy ? String(t.cancelledBy).slice(0, 16) : 'system';
  }

  private async assertDriver(userId: string) {
    const row = await this.prisma.driver.findUnique({ where: { userId } });
    if (!row || row.status === 'REJECTED' || row.status === 'SUSPENDED') {
      throw new ForbiddenException('Só motoristas.');
    }
    return row;
  }

  private async assertAccess(tripId: string, userId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        passenger: { select: { name: true, phone: true } },
        driver: { include: { user: { select: { name: true, phone: true } } } },
      },
    });
    if (!trip) throw new NotFoundException('Viagem não encontrada.');
    const isPax = trip.passengerId === userId;
    const isDrv = !!trip.driver && trip.driver.userId === userId;
    let allowed = isPax || isDrv;
    if (!allowed && trip.status === 'REQUESTED') {
      const row = await this.prisma.driver.findUnique({ where: { userId } });
      allowed = !!row;
    }
    if (!allowed) throw new ForbiddenException('Sem acesso a esta viagem.');
    return trip;
  }
}
