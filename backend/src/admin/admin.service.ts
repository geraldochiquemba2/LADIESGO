import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  async getPendingDrivers() {
    return this.prisma.driver.findMany({
      where: { status: 'PENDING' },
      include: { user: { select: { name: true, phone: true, email: true, createdAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async approveDriver(driverId: string) {
    return this.prisma.driver.update({
      where: { id: driverId },
      data: { status: 'APPROVED' },
      include: { user: true },
    });
  }

  async rejectDriver(driverId: string, reason?: string) {
    return this.prisma.driver.update({
      where: { id: driverId },
      data: { status: 'REJECTED' },
    });
  }

  async suspendDriver(driverId: string) {
    return this.prisma.driver.update({
      where: { id: driverId },
      data: { status: 'SUSPENDED', isOnline: false },
    });
  }

  async getAllUsers(page = 1, limit = 20, role?: string, q?: string) {
    limit = Math.max(1, Math.min(limit || 20, 100));
    const and: any[] = [];
    if (role) and.push({ role: role as any });
    if (q) {
      // SQLite não suporta mode:'insensitive' — só no Postgres (números não precisam).
      const insensitive = process.env.DATABASE_URL?.startsWith('file:')
        ? {}
        : { mode: 'insensitive' as const };
      and.push({
        OR: [{ phone: { contains: q, ...insensitive } }, { name: { contains: q, ...insensitive } }],
      });
    }
    const where = and.length ? { AND: and } : {};
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        // Nunca expor passwordHash nem fcmToken ao painel.
        select: {
          id: true, phone: true, name: true, email: true, role: true,
          profilePhoto: true, isActive: true, isVerified: true,
          referralCode: true, referralCount: true, walletBalance: true,
          createdAt: true, updatedAt: true,
          driver: { select: { status: true, rating: true, totalTrips: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return { users, total, page, limit };
  }

  // Motoristas online agora para o mapa do painel.
  async getOnlineDrivers() {
    const list = await this.prisma.driver.findMany({
      where: { isOnline: true, updatedAt: { gte: new Date(Date.now() - 90 * 1000) } },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      include: { user: { select: { name: true, phone: true } } },
    });
    const now = Date.now();
    return {
      drivers: list.map((d) => ({
        id: d.id,
        name: d.user?.name || d.user?.phone || 'Motorista',
        phone: d.user?.phone || '',
        lat: d.currentLat,
        lng: d.currentLng,
        updated: d.updatedAt ? Math.max(0, Math.round((now - d.updatedAt.getTime()) / 1000)) : null,
        carMake: [d.carMake, d.carModel].filter(Boolean).join(' '),
        carPlate: d.carPlate,
        carYear: d.carYear,
        carColor: d.carColor,
        licenseNumber: d.licenseNumber,
        status: d.status,
        rating: d.rating,
      })),
    };
  }

  async getAllTrips(page = 1, limit = 20, status?: string, passengerId?: string) {
    limit = Math.max(1, Math.min(limit || 20, 100));
    const and: any[] = [];
    if (status) and.push({ status: status as any });
    if (passengerId) and.push({ passengerId });
    const where = and.length ? { AND: and } : {};
    const [trips, total] = await Promise.all([
      this.prisma.trip.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          passenger: { select: { name: true, phone: true } },
          driver: { include: { user: { select: { name: true, phone: true } } } },
          payment: true,
        },
      }),
      this.prisma.trip.count({ where }),
    ]);
    return { trips, total, page, limit };
  }

  async getDashboardStats() {
    const [totalUsers, totalDrivers, activeDrivers, totalTrips, completedTrips, pendingApprovals] =
      await Promise.all([
        this.prisma.user.count({ where: { role: 'PASSENGER' } }),
        this.prisma.driver.count(),
        this.prisma.driver.count({ where: { isOnline: true, status: 'APPROVED', updatedAt: { gte: new Date(Date.now() - 90 * 1000) } } }),
        this.prisma.trip.count(),
        this.prisma.trip.count({ where: { status: 'COMPLETED' } }),
        this.prisma.driver.count({ where: { status: 'PENDING' } }),
      ]);

    const revenueResult = await this.prisma.payment.aggregate({
      where: { status: 'PAID' },
      _sum: { amount: true },
    });

    const byStatusRaw = await this.prisma.trip.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    const byStatus: Record<string, number> = {};
    for (const r of byStatusRaw) byStatus[r.status as string] = r._count.status;

    return {
      totalUsers,
      totalDrivers,
      activeDrivers,
      totalTrips,
      completedTrips,
      pendingApprovals,
      totalRevenue: revenueResult._sum.amount ?? 0,
      byStatus,
    };
  }
}
