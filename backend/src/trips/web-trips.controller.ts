import { Controller, Post, Get, Body, Param, Query, UseGuards } from '@nestjs/common';
import { WebTripsService } from './web-trips.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WebRequestTripDto, TripStatusDto, ChatPostDto, CallSignalDto } from './dto/web-trip.dto';

// Rotas usadas pela página web (/home) — formatos legados, dados no Neon.
// A app móvel usa as rotas nativas do TripsController.
@UseGuards(JwtAuthGuard)
@Controller('trips')
export class WebTripsController {
  constructor(private web: WebTripsService) {}

  @Post('request-web')
  requestWeb(@CurrentUser('id') userId: string, @Body() dto: WebRequestTripDto) {
    return this.web.requestWebTrip(userId, dto);
  }

  @Get('incoming')
  incoming(@CurrentUser('id') userId: string, @Query('driverId') driverId?: string) {
    return this.web.incoming(userId, driverId);
  }

  @Get('history')
  history(
    @CurrentUser('id') userId: string,
    @Query('passengerId') passengerId?: string,
    @Query('driverId') driverId?: string,
  ) {
    return this.web.history(userId, passengerId, driverId);
  }

  @Get(':id/chat')
  chatGet(
    @Param('id') tripId: string,
    @CurrentUser('id') userId: string,
    @Query('since') since?: string,
  ) {
    return this.web.chatGet(tripId, userId, since);
  }

  @Post(':id/chat')
  chatPost(
    @Param('id') tripId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ChatPostDto,
  ) {
    return this.web.chatPost(tripId, userId, dto.from, dto.text);
  }

  @Post(':id/status')
  status(
    @Param('id') tripId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: TripStatusDto,
  ) {
    return this.web.tripStatus(tripId, userId, dto);
  }

  @Get(':id/call/signal')
  callGet(
    @Param('id') tripId: string,
    @CurrentUser('id') userId: string,
    @Query('since') since?: string,
  ) {
    return this.web.callGet(tripId, userId, since);
  }

  @Post(':id/call/signal')
  callPost(
    @Param('id') tripId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CallSignalDto,
  ) {
    return this.web.callPost(tripId, userId, dto.type, dto.payload);
  }
}
