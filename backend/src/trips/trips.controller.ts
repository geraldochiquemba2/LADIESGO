import { Controller, Post, Get, Put, Body, Param, Query, UseGuards } from '@nestjs/common';
import { TripsService } from './trips.service';
import { WebTripsService } from './web-trips.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestTripDto, EstimateFareDto } from './dto/request-trip.dto';

@UseGuards(JwtAuthGuard)
@Controller('trips')
export class TripsController {
  constructor(private trips: TripsService, private webTrips: WebTripsService) {}

  @Post('estimate')
  estimate(@Body() dto: EstimateFareDto) {
    return this.trips.estimateFare(dto);
  }

  @Post('request')
  request(@CurrentUser('id') userId: string, @Body() dto: RequestTripDto) {
    return this.trips.requestTrip(userId, dto);
  }

  @Get('active')
  getActive(@CurrentUser('id') userId: string) {
    return this.trips.getActiveTrip(userId);
  }

  @Get(':id')
  getTrip(@Param('id') tripId: string, @CurrentUser('id') userId: string, @Query('view') view?: string) {
    if (view === 'web') return this.webTrips.getWebTrip(tripId, userId);
    return this.trips.getTrip(tripId, userId);
  }

  @Put(':id/accept')
  accept(@Param('id') tripId: string, @CurrentUser('id') userId: string) {
    return this.trips.acceptTrip(tripId, userId);
  }

  @Put(':id/arrived')
  arrived(@Param('id') tripId: string, @CurrentUser('id') userId: string) {
    return this.trips.markArrived(tripId, userId);
  }

  @Put(':id/start')
  start(
    @Param('id') tripId: string,
    @CurrentUser('id') userId: string,
    @Body('pin') pin?: string,
  ) {
    return this.trips.startTrip(tripId, userId, pin);
  }

  @Put(':id/complete')
  complete(@Param('id') tripId: string, @CurrentUser('id') userId: string) {
    return this.trips.completeTrip(tripId, userId);
  }

  @Put(':id/cancel')
  cancel(
    @Param('id') tripId: string,
    @CurrentUser('id') userId: string,
    @Body('reason') reason?: string,
  ) {
    return this.trips.cancelTrip(tripId, userId, reason);
  }
}
