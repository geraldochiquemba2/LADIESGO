import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LiveDriversService, KNOWN_CATS } from './live-drivers.service';
import { PositionDto } from './dto/position.dto';
import { UpdateVehicleDto } from './dto/vehicle.dto';
import { RegisterDriverDto } from './dto/register-driver.dto';
import { UpdateLocationDto } from './dto/update-location.dto';

@Injectable()
export class DriversService {
  constructor(private prisma: PrismaService, private live: LiveDriversService) {}

  async register(userId: string, dto: RegisterDriverDto) {
    const existing = await this.prisma.driver.findUnique({ where: { userId } });
    if (existing) throw new ConflictException('Driver profile already exists');

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { role: 'DRIVER' },
    });

    // A motorista entra como PENDENTE — o admin aprova no painel após verificar.
    // Exceção: conta criada pelo admin (adminCreated) — entra APROVADA direta,
    // sem "em análise", porque o admin já a registou.
    const created = await this.prisma.driver.create({
      data: { userId, ...dto, status: user.adminCreated ? 'APPROVED' : 'PENDING' },
      include: { user: true },
    });
    const { passwordHash: _omit, ...safeUser } = created.user;
    return { ...created, user: safeUser };
  }

  async getStatus(userId: string) {
    const driver = await this.prisma.driver.findUnique({
      where: { userId },
      include: { user: { select: { name: true, phone: true, profilePhoto: true } } },
    });
    if (!driver) throw new NotFoundException('Driver not found');
    return driver;
  }

  async toggleOnline(userId: string, isOnline: boolean) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException('Driver not found');
    if (driver.status !== 'APPROVED') throw new BadRequestException('Driver not approved yet');

    return this.prisma.driver.update({
      where: { userId },
      data: { isOnline },
    });
  }

  async updateLocation(userId: string, dto: UpdateLocationDto) {
    return this.prisma.driver.update({
      where: { userId },
      data: { currentLat: dto.lat, currentLng: dto.lng },
    });
  }

  // A própria motorista atualiza os dados da viatura (ecrã Viaturas).
  async updateVehicle(userId: string, dto: UpdateVehicleDto) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException('Driver not found');
    const data: any = {};
    for (const k of ['carMake', 'carModel', 'carColor'] as const) {
      const v = (dto as any)[k];
      if (v !== undefined) data[k] = String(v).slice(0, 40);
    }
    if (dto.carYear !== undefined) data.carYear = dto.carYear;
    if (dto.carPlate !== undefined) {
      const plate = dto.carPlate.trim().slice(0, 12);
      if (!plate) throw new BadRequestException('Matrícula inválida.');
      const clash = await this.prisma.driver.findUnique({ where: { carPlate: plate } });
      if (clash && clash.id !== driver.id) {
        throw new ConflictException('Matrícula já usada noutra viatura.');
      }
      data.carPlate = plate;
    }
    if (dto.licenseNumber !== undefined) {
      const lic = dto.licenseNumber.trim().slice(0, 30);
      if (!lic) throw new BadRequestException('Nº da carta inválido.');
      const clash = await this.prisma.driver.findUnique({ where: { licenseNumber: lic } });
      if (clash && clash.id !== driver.id) {
        throw new ConflictException('Carta já usada noutra motorista.');
      }
      data.licenseNumber = lic;
    }
    if (!Object.keys(data).length) throw new BadRequestException('Nada para guardar.');
    return this.prisma.driver.update({ where: { userId }, data });
  }

  // Eliminar os dados da viatura (ecrã Viaturas). Sem viatura, a motorista
  // não pode ficar online até registar outra.
  async deleteVehicle(userId: string) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException('Driver not found');
    await this.prisma.driver.update({
      where: { userId },
      data: { carMake: null, carModel: null, carYear: null, carColor: null, carPlate: null },
    });
    return { ok: true };
  }

  // Posição em tempo real (página web da motorista): guarda em memória
  // com expiração (TTL 45s). Se já houver registo na BD, espelha isOnline
  // e a posição (painel admin fica verdadeiro). Sem erro se não houver.
  async updatePosition(dto: PositionDto) {
    if (dto.offline) {
      this.live.remove(dto.id);
    } else {
      this.live.upsert({
        id: dto.id,
        name: dto.name || 'Motorista',
        lat: dto.lat,
        lng: dto.lng,
        cats: dto.cats ?? [],
        carMake: dto.carMake,
        carPlate: dto.carPlate,
      });
    }
    try {
      const row = await this.prisma.driver.findUnique({ where: { userId: dto.id } });
      if (row) {
        await this.prisma.driver.update({
          where: { userId: dto.id },
          data: dto.offline
            ? { isOnline: false }
            : { isOnline: true, currentLat: dto.lat, currentLng: dto.lng },
        });
      }
    } catch {}
    return { ok: true };
  }

  async getNearbyDrivers(lat: number, lng: number, radiusKm = 25) {
    const live = this.live
      .list()
      .filter((d) => this.haversine(lat, lng, d.lat, d.lng) <= radiusKm)
      .map((d) => ({
        id: d.id,
        userId: d.id,
        lat: d.lat,
        lng: d.lng,
        currentLat: d.lat,
        currentLng: d.lng,
        name: d.name,
        cats: d.cats,
        carMake: d.carMake,
        carPlate: d.carPlate,
        distanceKm: this.haversine(lat, lng, d.lat, d.lng),
        source: 'live',
      }));

    const dbDrivers = await this.prisma.driver.findMany({
      where: { isOnline: true, status: 'APPROVED', currentLat: { not: null }, currentLng: { not: null } },
      include: { user: { select: { name: true, profilePhoto: true } } },
    });

    const seen = new Set(live.map((d) => d.userId));
    const db = dbDrivers
      .filter((d) => this.haversine(lat, lng, d.currentLat!, d.currentLng!) <= radiusKm)
      .filter((d) => !seen.has(d.userId))
      .map((d) => ({
        id: d.id,
        userId: d.userId,
        lat: d.currentLat!,
        lng: d.currentLng!,
        currentLat: d.currentLat!,
        currentLng: d.currentLng!,
        name: d.user?.name ?? 'Motorista',
        cats: [...KNOWN_CATS],
        carMake: d.carMake ?? undefined,
        carPlate: d.carPlate ?? undefined,
        rating: d.rating,
        distanceKm: this.haversine(lat, lng, d.currentLat!, d.currentLng!),
        source: 'db',
      }));

    // Formato {drivers:[...]} — é o que a página web (/home) espera.
    return { drivers: [...live, ...db] };
  }

  async getEarnings(userId: string, page = 1, limit = 10) {
    const driver = await this.prisma.driver.findUnique({ where: { userId } });
    if (!driver) throw new NotFoundException('Driver not found');

    const [trips, total] = await Promise.all([
      this.prisma.trip.findMany({
        where: { driverId: driver.id, status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { passenger: { select: { name: true } }, payment: true },
      }),
      this.prisma.trip.count({ where: { driverId: driver.id, status: 'COMPLETED' } }),
    ]);

    return { trips, total, totalEarnings: driver.totalEarnings, page, limit };
  }

  private haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private toRad(deg: number) {
    return (deg * Math.PI) / 180;
  }
}
