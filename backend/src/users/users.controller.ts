import { Controller, Get, Put, Post, Delete, Body, UseGuards, Query, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';

@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get('profile')
  getProfile(@CurrentUser('id') userId: string) {
    return this.users.getProfile(userId);
  }

  @Put('profile')
  updateProfile(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(userId, dto);
  }

  @Post('photo')
  uploadPhoto(@CurrentUser('id') userId: string, @Body('photoUrl') photoUrl: string) {
    return this.users.uploadPhoto(userId, photoUrl);
  }

  @Get('trips/history')
  getTripHistory(
    @CurrentUser('id') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.users.getTripHistory(userId, page, limit);
  }

  // Apple 5.1.1(v) — eliminação de conta dentro da app.
  @Delete('me')
  deleteMe(@CurrentUser('id') userId: string) {
    return this.users.deleteMe(userId);
  }

  // Apple 1.2 (UGC) — denunciar + bloquear utilizador do chat da viagem.
  @Post('report')
  reportUser(
    @CurrentUser('id') userId: string,
    @Body() body: { reportedUserId: string; reason?: string; tripId?: string },
  ) {
    return this.users.reportUser(userId, body.reportedUserId, body.reason ?? '', body.tripId);
  }
}
