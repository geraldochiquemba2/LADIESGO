import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Acompanhamento público da viagem (link partilhado) — SEM login.
// Devolve só o necessário para ver o carro no mapa: sem telefones,
// sem nomes completos, sem valores.
@Controller('trips/public')
export class PublicTripsController {
  constructor(private prisma: PrismaService) {}

  @Get(':id')
  async get(@Param('id') id: string) {
    const t = await this.prisma.trip.findUnique({
      where: { id },
      include: { driver: { include: { user: { select: { name: true } } } } },
    });
    if (!t) throw new NotFoundException('Viagem não encontrada.');
    const firstName = String(t.driver?.user?.name || 'Motorista').split(' ')[0];
    const car = [t.driver?.carMake, t.driver?.carModel, t.driver?.carColor].filter(Boolean).join(' ');
    return {
      id: t.id,
      status: t.status,
      pickup: { lat: t.pickupLat, lng: t.pickupLng, name: t.pickupAddress },
      dest: { lat: t.dropoffLat, lng: t.dropoffLng, name: t.dropoffAddress },
      driver: t.driver
        ? { name: firstName, lat: t.driver.currentLat, lng: t.driver.currentLng, car, plate: t.driver.carPlate }
        : null,
      updatedAt: t.updatedAt,
    };
  }
}
