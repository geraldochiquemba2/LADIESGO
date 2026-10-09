import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@WebSocketGateway({ cors: { origin: '*' }, namespace: '/trips' })
export class TripsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private connectedUsers = new Map<string, string>();
  private passengerLocations = new Map<string, { lat: number; lng: number }>();
  private lastDbSave = new Map<string, number>();
  // Live odometer: tracks actual km driven per trip (only counts when driver is moving)
  private tripOdometer = new Map<string, { lastLat: number; lastLng: number; lastTs: number; totalKm: number; rideType: string; surgeMultiplier: number }>();
  // Movement faster than this between GPS pings is a glitch, not driving
  private readonly MAX_SPEED_KMH = 150;

  private readonly BASE_FARE = 5;
  private readonly PER_KM = 2.5;
  private readonly RIDE_MULTIPLIER: Record<string, number> = { ECONOMY: 1.0, COMFORT: 1.35, PREMIUM: 1.7 };

  constructor(
    private jwt: JwtService,
    private config: ConfigService,
    private prisma: PrismaService,
    private notifs: NotificationsService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.split(' ')[1];
      const payload = this.jwt.verify(token, { secret: this.config.get('JWT_SECRET') });
      client.data.userId = payload.sub;
      client.data.role = payload.role;
      this.connectedUsers.set(payload.sub, client.id);
      client.join(`user:${payload.sub}`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    if (client.data.userId) {
      this.connectedUsers.delete(client.data.userId);
      this.passengerLocations.delete(client.data.userId);
      this.lastDbSave.delete(client.data.userId);
    }
  }

  // ─── driver streams location in real time ────────────────────────────────
  @SubscribeMessage('driver:location-update')
  async handleDriverLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { lat: number; lng: number; heading?: number },
  ) {
    const userId = client.data.userId;
    if (!this.validCoords(data?.lat, data?.lng)) return;

    // Only actual drivers may stream — a non-driver's update would throw on
    // driver.update and could poison the public map otherwise.
    const driver = await this.prisma.driver.findUnique({ where: { userId }, select: { id: true, isOnline: true } });
    if (!driver) return;

    // Save to DB at most every 10 seconds to reduce write load
    const now = Date.now();
    if (now - (this.lastDbSave.get(userId) ?? 0) >= 10000) {
      await this.prisma.driver.update({
        where: { userId },
        data: { currentLat: data.lat, currentLng: data.lng },
      });
      this.lastDbSave.set(userId, now);
    }

    // Broadcast live location to ALL passengers watching the public map
    if (driver.isOnline) {
      this.server.to('public:drivers').emit('public:driver-location', {
        driverId: driver.id,
        lat: data.lat,
        lng: data.lng,
        heading: data.heading ?? -1,
      });
    }

    const activeTrip = await this.prisma.trip.findFirst({
      where: {
        driver: { userId },
        status: { in: ['ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
      },
    });

    if (!activeTrip) return;

    // ── Live odometer: only counts distance while driver is moving ──────────
    if (activeTrip.status === 'IN_PROGRESS') {
      const odo = this.tripOdometer.get(activeTrip.id);
      if (!odo) {
        // First IN_PROGRESS update — start tracking from current position
        this.tripOdometer.set(activeTrip.id, {
          lastLat: data.lat, lastLng: data.lng, lastTs: Date.now(), totalKm: 0,
          rideType: activeTrip.rideType ?? 'ECONOMY',
          surgeMultiplier: activeTrip.fareEstimate / Math.max(0.01,
            (this.BASE_FARE + (activeTrip.distanceKm ?? 1) * this.PER_KM) *
            (this.RIDE_MULTIPLIER[activeTrip.rideType ?? 'ECONOMY'] ?? 1)),
        });
      } else {
        const moved = this.haversine(odo.lastLat, odo.lastLng, data.lat, data.lng);
        const nowTs = Date.now();
        const hours = Math.max((nowTs - odo.lastTs) / 3600000, 1 / 3600000);
        const speedKmh = moved / hours;
        // GPS glitch: impossible speed — resync position without charging the passenger
        if (speedKmh > this.MAX_SPEED_KMH) {
          this.tripOdometer.set(activeTrip.id, { ...odo, lastLat: data.lat, lastLng: data.lng, lastTs: nowTs });
        } else
        // Only add to odometer if driver moved more than 10 m — ignores stops
        if (moved >= 0.01) {
          const totalKm = odo.totalKm + moved;
          const mult = this.RIDE_MULTIPLIER[odo.rideType] ?? 1.0;
          const liveFare = Math.round((this.BASE_FARE + totalKm * this.PER_KM) * mult * odo.surgeMultiplier * 100) / 100;
          this.tripOdometer.set(activeTrip.id, { ...odo, lastLat: data.lat, lastLng: data.lng, lastTs: nowTs, totalKm });

          // Push live fare to passenger — meter only ticks when moving
          this.server.to(`user:${activeTrip.passengerId}`).emit('server:fare-update', {
            distanceKm: Math.round(totalKm * 10) / 10,
            currentFare: liveFare,
            moving: true,
          });
        } else {
          // Driver stopped — update position without counting distance, notify passenger meter is paused
          this.tripOdometer.set(activeTrip.id, { ...odo, lastLat: data.lat, lastLng: data.lng, lastTs: nowTs });
          this.server.to(`user:${activeTrip.passengerId}`).emit('server:fare-update', {
            distanceKm: Math.round(odo.totalKm * 10) / 10,
            currentFare: Math.round((this.BASE_FARE + odo.totalKm * this.PER_KM) * (this.RIDE_MULTIPLIER[odo.rideType] ?? 1) * odo.surgeMultiplier * 100) / 100,
            moving: false,
          });
        }
      }
    }

    // ETA target: passenger pickup for ACCEPTED/DRIVER_ARRIVED, destination for IN_PROGRESS
    let targetLat: number;
    let targetLng: number;

    if (activeTrip.status === 'IN_PROGRESS') {
      targetLat = activeTrip.dropoffLat;
      targetLng = activeTrip.dropoffLng;
    } else {
      const paxLoc = this.passengerLocations.get(activeTrip.passengerId);
      targetLat = paxLoc?.lat ?? activeTrip.pickupLat;
      targetLng = paxLoc?.lng ?? activeTrip.pickupLng;
    }

    const distanceKm = this.haversine(data.lat, data.lng, targetLat, targetLng);

    this.server.to(`user:${activeTrip.passengerId}`).emit('server:driver-location', {
      lat: data.lat,
      lng: data.lng,
      heading: data.heading ?? -1,
      driverId: userId,
      distanceKm: Math.round(distanceKm * 10) / 10,
      etaMinutes: this.calcEta(distanceKm),
      status: activeTrip.status,
    });
  }

  // ─── passenger shares location every 10 s ────────────────────────────────
  @SubscribeMessage('passenger:location-update')
  async handlePassengerLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { lat: number; lng: number },
  ) {
    const userId = client.data.userId;
    if (!this.validCoords(data?.lat, data?.lng)) return;
    this.passengerLocations.set(userId, { lat: data.lat, lng: data.lng });

    const activeTrip = await this.prisma.trip.findFirst({
      where: {
        passengerId: userId,
        status: { in: ['ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
      },
      include: { driver: true },
    });

    if (!activeTrip?.driver) return;

    const driverLat = activeTrip.driver.currentLat ?? data.lat;
    const driverLng = activeTrip.driver.currentLng ?? data.lng;
    const distanceKm = this.haversine(driverLat, driverLng, data.lat, data.lng);

    this.server.to(`user:${activeTrip.driver.userId}`).emit('server:passenger-location', {
      lat: data.lat,
      lng: data.lng,
      passengerId: userId,
      distanceKm: Math.round(distanceKm * 10) / 10,
      etaMinutes: this.calcEta(distanceKm),
    });
  }

  // ─── passenger joins public room to receive live driver locations ────────
  @SubscribeMessage('join:public-drivers')
  handleJoinPublic(@ConnectedSocket() client: Socket) {
    client.join('public:drivers');
  }

  // ─── any user joins public requests room to see live trip demand ─────────
  @SubscribeMessage('join:public-requests')
  async handleJoinPublicRequests(@ConnectedSocket() client: Socket) {
    client.join('public:requests');
    // Send all currently pending requests so map is populated on join
    const pending = await this.prisma.trip.findMany({
      where: { status: 'REQUESTED' },
      select: { id: true, pickupLat: true, pickupLng: true, pickupAddress: true, fareEstimate: true, rideType: true, tripType: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    client.emit('public:requests-snapshot', pending);
  }

  // ─── passenger broadcasts trip request to nearest drivers ────────────────
  @SubscribeMessage('passenger:trip-request')
  async handleTripRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tripId: string },
  ) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: data.tripId },
      include: { passenger: { select: { name: true, phone: true, profilePhoto: true } } },
    });
    if (!trip) return;
    // Only the trip's own passenger may broadcast it — otherwise anyone could
    // blast a stranger's trip (with their name + phone) to drivers.
    if (trip.passengerId !== client.data.userId) return;

    const allDrivers = await this.prisma.driver.findMany({
      where: { isOnline: true, status: 'APPROVED' },
      select: { userId: true, currentLat: true, currentLng: true },
    });

    // Sort by distance from pickup — notify nearest 5 first (like Uber/Bolt)
    const sorted = allDrivers
      .filter((d) => d.currentLat && d.currentLng)
      .map((d) => ({
        ...d,
        dist: this.haversine(trip.pickupLat, trip.pickupLng, d.currentLat!, d.currentLng!),
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5);

    // Also include online drivers without GPS (they may still be close)
    const noGps = allDrivers.filter((d) => !d.currentLat || !d.currentLng).slice(0, 3);
    const targets = [...sorted, ...noGps];

    const payload = { trip, passenger: trip.passenger };
    targets.forEach((driver) => {
      this.server.to(`user:${driver.userId}`).emit('server:new-trip-request', payload);
    });

    // Broadcast to ALL passengers watching the public map — live demand feed
    this.server.to('public:requests').emit('public:trip-requested', {
      id: trip.id,
      pickupLat: trip.pickupLat,
      pickupLng: trip.pickupLng,
      pickupAddress: trip.pickupAddress,
      fareEstimate: trip.fareEstimate,
      rideType: trip.rideType ?? 'ECONOMY',
      tripType: (trip as any).tripType ?? 'RIDE',
    });

    const isDelivery = (trip as any).tripType === 'DELIVERY';
    const driverUserIds = targets.map((d) => d.userId);
    this.notifs.sendPushToMany(driverUserIds, {
      title: isDelivery ? '📦 Nova Entrega' : '🚖 Novo Pedido de Viagem',
      body: isDelivery
        ? `Entregar encomenda · ${trip.fareEstimate} Kz`
        : `${trip.passenger.name || 'Passageira'} pediu uma viagem · ${trip.fareEstimate} Kz`,
      data: { tripId: trip.id, type: 'TRIP_REQUEST' },
    });

    // If no driver accepts in 45 seconds, retry with broader radius
    setTimeout(async () => {
      try {
        // `status` isn't part of Trip's unique index, so this must be findFirst,
        // not findUnique — findUnique with a non-unique where crashes with a
        // PrismaClientValidationError, and since this runs detached in a
        // setTimeout with nothing awaiting it, that becomes an unhandled
        // rejection that took down the whole backend process (Node 15+ default).
        const stillPending = await this.prisma.trip.findFirst({
          where: { id: trip.id, status: 'REQUESTED' },
        });
        if (!stillPending) return;
        const remaining = allDrivers.filter((d) => !targets.find((t) => t.userId === d.userId));
        remaining.forEach((driver) => {
          this.server.to(`user:${driver.userId}`).emit('server:new-trip-request', payload);
        });
      } catch (err) {
        console.error('Trip request retry-broadcast failed:', err);
      }
    }, 45000);
  }

  // ─── driver accepted trip → notify passenger ──────────────────────────────
  @SubscribeMessage('driver:trip-accepted')
  async handleTripAccepted(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tripId: string },
  ) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: data.tripId },
      include: {
        driver: {
          include: {
            user: { select: { name: true, phone: true, profilePhoto: true } },
          },
        },
      },
    });

    if (!trip) return;
    // Only the assigned driver may announce the acceptance.
    if (!trip.driver || trip.driver.userId !== client.data.userId) return;

    this.server.to(`user:${trip.passengerId}`).emit('server:driver-found', {
      driver: trip.driver,
      tripId: trip.id,
    });

    // Remove from public request feed — trip is now taken
    this.server.to('public:requests').emit('public:trip-removed', { id: trip.id });

    // Push to passenger in case they backgrounded the app
    this.notifs.sendPush(trip.passengerId, {
      title: '🚗 Motorista Encontrada!',
      body: `${trip.driver?.user?.name || 'A tua motorista'} está a caminho`,
      data: { tripId: trip.id, type: 'TRIP_ACCEPTED' },
    });
    this.notifs.saveInApp(trip.passengerId, 'Motorista Encontrada!',
      `${trip.driver?.user?.name || 'A tua motorista'} aceitou a tua viagem`, 'TRIP_ACCEPTED');
  }

  // ─── driver completed trip → use odometer for final fare ─────────────────
  @SubscribeMessage('driver:trip-completed')
  async handleTripCompleted(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tripId: string },
  ) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: data.tripId },
      include: { driver: { select: { userId: true } } },
    });
    if (!trip) return;
    // Only the assigned driver may complete — this path persists finalFare.
    if (!trip.driver || trip.driver.userId !== client.data.userId) return;

    // Use actual distance driven (from live odometer) for final fare
    const odo = this.tripOdometer.get(data.tripId);
    let finalFare = trip.finalFare ?? trip.fareEstimate;
    if (odo && odo.totalKm > 0) {
      const mult = this.RIDE_MULTIPLIER[odo.rideType] ?? 1.0;
      finalFare = Math.round((this.BASE_FARE + odo.totalKm * this.PER_KM) * mult * odo.surgeMultiplier * 100) / 100;
      // Persist to DB
      await this.prisma.trip.update({
        where: { id: data.tripId },
        data: { finalFare, distanceKm: Math.round(odo.totalKm * 10) / 10 },
      });
    }
    this.tripOdometer.delete(data.tripId);

    this.server.to(`user:${trip.passengerId}`).emit('server:trip-update', {
      status: 'COMPLETED',
      finalFare,
      tripId: trip.id,
    });

    this.notifs.sendPush(trip.passengerId, {
      title: '✅ Viagem Concluída',
      body: `Total: ${finalFare} Kz. Avalia a tua motorista!`,
      data: { tripId: trip.id, type: 'TRIP_COMPLETED' },
    });
    this.notifs.saveInApp(trip.passengerId, 'Viagem Concluída', `Total: ${finalFare} Kz`, 'TRIP_COMPLETED');
  }

  // ─── passenger cancelled trip → notify driver ─────────────────────────────
  @SubscribeMessage('passenger:cancel-trip')
  async handleCancelTrip(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tripId: string },
  ) {
    const trip = await this.prisma.trip.findUnique({ where: { id: data.tripId } });
    if (!trip || !trip.driverId) return;
    // Only the passenger who owns this trip may trigger its cancellation relay
    if (trip.passengerId !== client.data.userId) return;

    const driver = await this.prisma.driver.findUnique({ where: { id: trip.driverId } });
    if (driver) {
      this.server.to(`user:${driver.userId}`).emit('server:trip-cancelled', {
        tripId: data.tripId,
      });
      this.notifs.sendPush(driver.userId, {
        title: '❌ Viagem Cancelada',
        body: 'A passageira cancelou a viagem',
        data: { tripId: data.tripId, type: 'TRIP_CANCELLED' },
      });
    }

    // Remove from public request feed
    this.server.to('public:requests').emit('public:trip-removed', { id: data.tripId });
  }

  // ─── in-app chat between passenger and driver ─────────────────────────────
  @SubscribeMessage('chat:message')
  async handleChatMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { tripId: string; text: string },
  ) {
    const senderId = client.data.userId;
    const text = String(data?.text ?? '').slice(0, 1000).trim();
    if (!text) return;
    const trip = await this.prisma.trip.findUnique({
      where: { id: data.tripId },
      include: { driver: true },
    });
    if (!trip) return;

    // Sender must be a participant of this trip — otherwise a stranger could
    // inject messages that appear to come from the real driver/passenger
    const isPassenger = senderId === trip.passengerId;
    const isDriver = !!trip.driver && senderId === trip.driver.userId;
    if (!isPassenger && !isDriver) return;

    const targetUserId = isPassenger ? trip.driver?.userId : trip.passengerId;
    if (!targetUserId) return;

    const payload = {
      text,
      senderId,
      timestamp: new Date().toISOString(),
    };

    this.server.to(`user:${targetUserId}`).emit('server:chat-message', { ...payload, isMine: false });
    client.emit('server:chat-message', { ...payload, isMine: true });
  }

  emitToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  // ─── helpers ──────────────────────────────────────────────────────────────
  // NaN/out-of-range coords would poison the odometer, fares, and DB rows.
  private validCoords(lat: unknown, lng: unknown): boolean {
    return (
      typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
      typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
    );
  }

  private haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // 30 km/h average city speed
  private calcEta(distanceKm: number): number {
    return Math.max(1, Math.ceil((distanceKm / 30) * 60));
  }
}
