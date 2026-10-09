import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PromosService } from '../promos/promos.service';
import { RequestTripDto, EstimateFareDto, RideType, TripType, RIDE_TYPE_MULTIPLIER } from './dto/request-trip.dto';

const BASE_FARE = 5;
const PER_KM_RATE = 2.5;
const PLATFORM_COMMISSION = 0.2;

function getSurgeMultiplier(): number {
  const hour = new Date().getHours();
  // Morning rush 7-9, evening rush 17-20, late night 23-2
  if ((hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 20)) return 1.3;
  if (hour >= 23 || hour <= 2) return 1.2;
  return 1.0;
}

// Código de segurança da viagem (4 dígitos, estável): a passageira vê-o
// na app e dita-o à motorista, que o digita ao chegar para iniciar.
// Mesmo algoritmo no site (pinJS) e no backend.
export function pinForTrip(id: string): string {
  let h = 0;
  for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return String(1000 + (h % 9000));
}

@Injectable()
export class TripsService {
  constructor(
    private prisma: PrismaService,
    private notifs: NotificationsService,
    private promos: PromosService,
  ) {}

  estimateFare(dto: EstimateFareDto) {
    const distanceKm = this.haversine(dto.pickupLat, dto.pickupLng, dto.dropoffLat, dto.dropoffLng);
    const baseFare = BASE_FARE + distanceKm * PER_KM_RATE;
    const surge = getSurgeMultiplier();
    const rideMultiplier = RIDE_TYPE_MULTIPLIER[dto.rideType ?? RideType.ECONOMY];

    const options = Object.values(RideType).map((type) => ({
      type,
      fare: Math.round(baseFare * surge * RIDE_TYPE_MULTIPLIER[type] * 100) / 100,
    }));

    return {
      distanceKm: Math.round(distanceKm * 10) / 10,
      estimatedFare: Math.round(baseFare * surge * rideMultiplier * 100) / 100,
      currency: 'SAR',
      surgeMultiplier: surge,
      surgeActive: surge > 1.0,
      options,
    };
  }

  async requestTrip(passengerId: string, dto: RequestTripDto) {
    // Deliveries are always priced as Economy
    const isDelivery = dto.tripType === TripType.DELIVERY;
    const rideType = isDelivery ? RideType.ECONOMY : (dto.rideType ?? RideType.ECONOMY);
    if (isDelivery && !dto.packageDescription) {
      throw new BadRequestException('Package description is required for deliveries');
    }
    const estimate = this.estimateFare({ ...dto, rideType });

    const activeTrip = await this.prisma.trip.findFirst({
      where: { passengerId, status: { in: ['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'] } },
    });
    if (activeTrip) {
      // A request no driver accepted yet shouldn't block a new booking — replace it
      if (activeTrip.status === 'REQUESTED') {
        await this.prisma.trip.update({
          where: { id: activeTrip.id },
          data: { status: 'CANCELLED', cancelledBy: passengerId, cancelReason: 'Replaced by new booking' },
        });
      } else {
        throw new BadRequestException('You already have an active trip. Complete or cancel it first.');
      }
    }

    let promoCodeId: string | undefined;
    let discount = 0;
    if (dto.promoCode) {
      const promo = await this.promos.validate(dto.promoCode);
      discount = Math.round(estimate.estimatedFare * (promo.discountPct / 100) * 100) / 100;
      promoCodeId = promo.id;
      await this.promos.apply(promo.id);
    }

    const finalEstimate = Math.max(0, estimate.estimatedFare - discount);

    // Paragens intermédias (máx 3, saneadas) — visíveis no painel admin.
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

    return this.prisma.trip.create({
      data: {
        passengerId,
        pickupAddress: dto.pickupAddress,
        pickupLat: dto.pickupLat,
        pickupLng: dto.pickupLng,
        dropoffAddress: dto.dropoffAddress,
        dropoffLat: dto.dropoffLat,
        dropoffLng: dto.dropoffLng,
        pickupRef: dto.pickupRef ?? null,
        dropoffRef: dto.dropoffRef ?? null,
        rideType,
        tripType: dto.tripType ?? TripType.RIDE,
        packageDescription: dto.packageDescription ?? null,
        receiverName: dto.receiverName ?? null,
        receiverPhone: dto.receiverPhone ?? null,
        fareEstimate: finalEstimate,
        discount,
        distanceKm: estimate.distanceKm,
        paymentMethod: dto.paymentMethod,
        promoCodeId: promoCodeId ?? null,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        stops: cleanStops,
      },
      include: { passenger: { select: { name: true, phone: true, profilePhoto: true } } },
    });
  }

  async getActiveTrip(userId: string) {
    const trip = await this.prisma.trip.findFirst({
      where: {
        status: { in: ['REQUESTED', 'ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'] },
        OR: [
          { passengerId: userId },
          { driver: { userId } },
        ],
      },
      include: {
        passenger: { select: { name: true, phone: true, profilePhoto: true } },
        driver: { include: { user: { select: { name: true, phone: true, profilePhoto: true } } } },
        payment: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!trip) return null;
    // PIN só para a passageira (a motorista tem de o pedir e digitar).
    return trip.passengerId === userId ? { ...trip, pin: pinForTrip(trip.id) } : trip;
  }

  async getTrip(tripId: string, userId: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: {
        passenger: { select: { name: true, phone: true, profilePhoto: true } },
        driver: { include: { user: { select: { name: true, phone: true, profilePhoto: true } } } },
        payment: true,
        ratings: true,
      },
    });
    if (!trip) throw new NotFoundException('Trip not found');

    // Access control: the trip's passenger, its assigned driver, or — while the
    // trip is still open (REQUESTED) — any driver, so they can view it before
    // accepting from the live map. Anyone else must not see the PII it carries.
    const isPassenger = trip.passengerId === userId;
    const isAssignedDriver = !!trip.driver && trip.driver.userId === userId;
    let allowed = isPassenger || isAssignedDriver;
    if (!allowed && trip.status === 'REQUESTED') {
      const driver = await this.prisma.driver.findUnique({ where: { userId } });
      allowed = !!driver;
    }
    if (!allowed) throw new ForbiddenException('You do not have access to this trip');

    // PIN só para a passageira da viagem (a motorista tem de o pedir e digitar).
    return isPassenger ? { ...trip, pin: pinForTrip(tripId) } : trip;
  }

  async acceptTrip(tripId: string, userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new ForbiddenException('Not a driver');

    // Uma motorista não aceita 2 viagens em simultâneo (evita trocar de
    // destino / abandonar a passageira aceite).
    const busy = await this.prisma.trip.findFirst({
      where: { driverId: driver.id, status: { in: ['ACCEPTED', 'DRIVER_ARRIVED', 'IN_PROGRESS'] } },
      select: { id: true },
    });
    if (busy) throw new BadRequestException('Já tens uma viagem ativa.');

    // Atomic: only one driver can flip REQUESTED → ACCEPTED, even on simultaneous taps
    // Snapshot da viatura (o painel admin mostra com que carro foi feita a viagem).
    const vehicleLabel = [driver.carMake, driver.carModel, driver.carColor].filter(Boolean).join(' ');
    const updated = await this.prisma.trip.updateMany({
      where: { id: tripId, status: 'REQUESTED' },
      data: {
        driverId: driver.id,
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        vehicleLabel: vehicleLabel || null,
        vehiclePlate: driver.carPlate || null,
      },
    });
    if (updated.count === 0) throw new BadRequestException('Trip not available');

    return this.prisma.trip.findUnique({ where: { id: tripId } });
  }

  async markArrived(tripId: string, userId: string) {
    const trip = await this.updateTripStatus(tripId, userId, 'ACCEPTED', 'DRIVER_ARRIVED', { arrivedAt: new Date() });
    this.notifs.sendPush(trip.passengerId, {
      title: '🚗 A Motorista Chegou!',
      body: 'A tua motorista está à tua espera no ponto de recolha',
      data: { tripId: trip.id, type: 'DRIVER_ARRIVED' },
    });
    this.notifs.saveInApp(trip.passengerId, 'A Motorista Chegou!', 'A tua motorista está no ponto de recolha', 'DRIVER_ARRIVED');
    return trip;
  }

  async startTrip(tripId: string, userId: string, pin?: string) {
    // Segurança LadiesGo: sem o código ditado pela passageira não arranca.
    if (!pin || String(pin).trim() !== pinForTrip(tripId)) {
      throw new BadRequestException('Código de segurança incorreto. Pede o código de 4 dígitos à passageira.');
    }
    const trip = await this.updateTripStatus(tripId, userId, 'DRIVER_ARRIVED', 'IN_PROGRESS', { startedAt: new Date() });
    this.notifs.sendPush(trip.passengerId, {
      title: '🚀 Viagem Iniciada',
      body: 'A tua viagem já começou. Boa viagem!',
      data: { tripId: trip.id, type: 'TRIP_STARTED' },
    });
    this.notifs.saveInApp(trip.passengerId, 'Viagem Iniciada', 'A tua viagem está em curso', 'TRIP_STARTED');
    return trip;
  }

  async completeTrip(tripId: string, userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip || trip.status !== 'IN_PROGRESS') throw new BadRequestException('Trip not in progress');
    if (trip.driverId !== driver?.id) throw new ForbiddenException();

    const finalFare = trip.fareEstimate;
    const driverEarnings = finalFare * (1 - PLATFORM_COMMISSION);

    await this.prisma.driver.update({
      where: { id: driver.id },
      data: { totalTrips: { increment: 1 }, totalEarnings: { increment: driverEarnings } },
    });

    return this.prisma.trip.update({
      where: { id: tripId },
      data: { status: 'COMPLETED', completedAt: new Date(), finalFare },
    });
  }

  async cancelTrip(tripId: string, userId: string, reason?: string) {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      include: { driver: { select: { userId: true } } },
    });
    if (!trip) throw new NotFoundException('Trip not found');

    // Only the passenger who booked it or the driver assigned to it may cancel
    const isPassenger = trip.passengerId === userId;
    const isAssignedDriver = !!trip.driver && trip.driver.userId === userId;
    if (!isPassenger && !isAssignedDriver) {
      throw new ForbiddenException('You do not have access to this trip');
    }

    if (!['REQUESTED', 'ACCEPTED'].includes(trip.status)) {
      throw new BadRequestException('Trip cannot be cancelled at this stage');
    }

    return this.prisma.trip.update({
      where: { id: tripId },
      data: { status: 'CANCELLED', cancelledBy: userId, cancelReason: reason },
    });
  }

  private async updateTripStatus(tripId: string, userId: string, fromStatus: string, toStatus: any, extra: any) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    const trip = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!trip || trip.status !== fromStatus) throw new BadRequestException(`Trip must be in ${fromStatus} status`);
    if (trip.driverId !== driver?.id) throw new ForbiddenException();
    return this.prisma.trip.update({ where: { id: tripId }, data: { status: toStatus, ...extra } });
  }

  private haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
