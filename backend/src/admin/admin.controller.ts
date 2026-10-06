import { Controller, Get, Put, Param, Body, Query, DefaultValuePipe, ParseIntPipe, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN' as any)
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService) {}

  @Get('stats')
  getStats() {
    return this.admin.getDashboardStats();
  }

  @Get('drivers/pending')
  getPendingDrivers() {
    return this.admin.getPendingDrivers();
  }

  @Put('drivers/:id/approve')
  approveDriver(@Param('id') id: string) {
    return this.admin.approveDriver(id);
  }

  @Put('drivers/:id/reject')
  rejectDriver(@Param('id') id: string, @Body('reason') reason?: string) {
    return this.admin.rejectDriver(id, reason);
  }

  @Put('drivers/:id/suspend')
  suspendDriver(@Param('id') id: string) {
    return this.admin.suspendDriver(id);
  }

  @Get('drivers')
  getDrivers() {
    return this.admin.getOnlineDrivers();
  }

  @Get('users')
  getUsers(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('role') role?: string,
  ) {
    return this.admin.getAllUsers(page, limit, role);
  }

  @Get('trips')
  getTrips(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    return this.admin.getAllTrips(page, limit, status);
  }
}
