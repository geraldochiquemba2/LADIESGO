import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { RatingsService, CreateRatingDto } from './ratings.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@UseGuards(JwtAuthGuard)
@Controller('ratings')
export class RatingsController {
  constructor(private ratings: RatingsService) {}

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateRatingDto) {
    return this.ratings.createRating(userId, dto);
  }

  @Get('pending')
  pending(@CurrentUser('id') userId: string) {
    return this.ratings.pendingFor(userId);
  }
}
