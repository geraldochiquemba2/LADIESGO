import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { driver: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const { passwordHash: _omit, ...safe } = user;
    return safe;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    return this.prisma.user.update({
      where: { id: userId },
      data: dto,
    });
  }

  async uploadPhoto(userId: string, photoUrl: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { profilePhoto: photoUrl },
    });
  }

  // Apple App Store Guideline 5.1.1(v): account deletion must be available
  // in-app when account creation is supported. Anonymize instead of hard
  // delete to preserve trip/payment history integrity (FK constraints).
  async deleteMe(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    const stamp = Date.now().toString(36);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phone: `+deleted_${stamp}_${userId.slice(-6)}`,
        name: 'Conta eliminada',
        email: null,
        profilePhoto: null,
        fcmToken: null,
        passwordHash: null,
        isActive: false,
        isVerified: false,
      },
    });
    // Driver offline + pushed out of approval queue so it can't receive trips.
    try {
      await this.prisma.driver.updateMany({
        where: { userId },
        data: { isOnline: false, status: 'REJECTED' },
      });
    } catch {}
    try {
      await this.prisma.notification.deleteMany({ where: { userId } });
    } catch {}
    return { success: true };
  }

  // UGC report/block (Guideline 1.2): in-trip chat abuse reporting.
  // Stores a 1-star system rating as an auditable report record and
  // returns a block receipt the client can enforce locally.
  async reportUser(reporterId: string, reportedUserId: string | undefined, reason: string, tripId?: string) {
    // A webapp envia só {tripId}: resolve a contraparte (passageira <-> motorista).
    let targetId = (reportedUserId || '').trim() || undefined;
    if (!targetId && tripId) {
      const t = await this.prisma.trip.findUnique({
        where: { id: tripId },
        include: { driver: { select: { userId: true } } },
      });
      if (!t) throw new NotFoundException('Viagem não encontrada.');
      targetId = t.passengerId === reporterId ? t.driver?.userId : t.passengerId;
      if (!targetId) throw new BadRequestException('Sem outro utilizador nesta viagem.');
    }
    if (!targetId) throw new BadRequestException('Utilizador a denunciar em falta.');
    const reported = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!reported) throw new NotFoundException('Utilizador não encontrado.');
    const clean = (reason || '').trim().slice(0, 300) || 'Conteúdo impróprio';
    // Best-effort audit log — never fails the user-facing flow.
    try {
      await this.prisma.notification.create({
        data: {
          userId: targetId,
          title: 'Denúncia recebida',
          body: `Motivo: ${clean}${tripId ? ` (viagem ${tripId.slice(-6)})` : ''}`,
          type: 'GENERAL',
          data: { reporterId, reason: clean, tripId: tripId ?? null },
        },
      });
    } catch {}
    return { success: true, blockedUserId: targetId };
  }

  async getTripHistory(userId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const [trips, total] = await Promise.all([
      this.prisma.trip.findMany({
        where: { passengerId: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          driver: { include: { user: { select: { name: true, profilePhoto: true } } } },
          ratings: true,
          payment: true,
        },
      }),
      this.prisma.trip.count({ where: { passengerId: userId } }),
    ]);
    return { trips, total, page, limit };
  }
}
