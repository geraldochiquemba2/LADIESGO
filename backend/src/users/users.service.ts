import { Injectable, NotFoundException } from '@nestjs/common';
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
