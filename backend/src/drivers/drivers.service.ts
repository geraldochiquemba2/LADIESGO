import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDriverDto } from './dto/register-driver.dto';
import { UpdateLocationDto } from './dto/update-location.dto';

@Injectable()
export class DriversService {
  constructor(private prisma: PrismaService) {}

  async register(userId: string, dto: RegisterDriverDto) {
    const existing = await this.prisma.driver.findUnique({ where: { userId } });
    if (existing) throw new ConflictException('Driver profile already exists');

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { role: 'DRIVER' },
    });

    // A motorista entra como PENDENTE — o admin aprova no painel após verificar.
    const created = await this.prisma.driver.create({
      data: { userId, ...dto, status: 'PENDING' },
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

  async getNearbyDrivers(lat: number, lng: number, radiusKm = 5) {
    const drivers = await this.prisma.driver.findMany({
      where: { isOnline: true, status: 'APPROVED', currentLat: { not: null }, currentLng: { not: null } },
      include: { user: { select: { name: true, profilePhoto: true } } },
    });

    return drivers
      .filter((d) => {
        const dist = this.haversine(lat, lng, d.currentLat!, d.currentLng!);
        return dist <= radiusKm;
      })
      .map((d) => ({
        ...d,
        distanceKm: this.haversine(lat, lng, d.currentLat!, d.currentLng!),
      }));
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
