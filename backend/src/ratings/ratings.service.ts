import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { IsString, IsInt, IsOptional, Min, Max } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';

export class CreateRatingDto {
  @IsString()
  tripId: string;

  @IsInt()
  @Min(1)
  @Max(5)
  score: number;

  @IsOptional()
  @IsString()
  comment?: string;
}

@Injectable()
export class RatingsService {
  constructor(private prisma: PrismaService) {}

  async createRating(raterId: string, dto: CreateRatingDto) {    if (dto.score < 1 || dto.score > 5) throw new BadRequestException('Score must be 1-5');

    const trip = await this.prisma.trip.findUnique({
      where: { id: dto.tripId },
      include: { driver: true },
    });

    if (!trip || trip.status !== 'COMPLETED') {
      throw new BadRequestException('Can only rate completed trips');
    }

    const isPassenger = trip.passengerId === raterId;
    const isDriver = !!trip.driver && trip.driver.userId === raterId;
    if (!isPassenger && !isDriver) throw new ForbiddenException('Not part of this trip');
    const ratedId = isPassenger ? trip.driver?.userId : trip.passengerId;

    if (!ratedId) throw new NotFoundException('Rated user not found');

    const already = await this.prisma.rating.findFirst({
      where: { tripId: dto.tripId, raterId },
    });
    if (already) throw new BadRequestException('Trip already rated');

    const rating = await this.prisma.rating.create({
      data: { tripId: dto.tripId, raterId, ratedId, score: dto.score, comment: dto.comment },
    });

    if (isPassenger && trip.driver) {
      const driverRatings = await this.prisma.rating.aggregate({
        where: { rated: { driver: { id: trip.driver.id } } },
        _avg: { score: true },
      });
      await this.prisma.driver.update({
        where: { id: trip.driver.id },
        data: { rating: driverRatings._avg.score ?? 5 },
      });
    }

    return rating;
  }

  // Viagens concluídas por avaliar (a passageira avalia antes de pedir outra).
  async pendingFor(userId: string) {
    const trips = await this.prisma.trip.findMany({
      where: { passengerId: userId, status: 'COMPLETED' },
      include: {
        driver: { include: { user: { select: { name: true } } } },
        ratings: { where: { raterId: userId }, select: { id: true } },
      },
      orderBy: { completedAt: 'desc' },
      take: 10,
    });
    return {
      pendings: trips
        .filter((t) => t.ratings.length === 0)
        .map((t) => ({
          tripId: t.id,
          driverName: t.driver?.user?.name || 'Motorista',
          fare: t.finalFare ?? t.fareEstimate,
          ts: t.completedAt ? t.completedAt.getTime() : new Date(t.createdAt).getTime(),
        })),
    };
  }
}
