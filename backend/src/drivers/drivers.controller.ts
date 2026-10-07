import { Controller, Post, Get, Put, Delete, Body, Query, ParseFloatPipe, DefaultValuePipe, ParseIntPipe, UseGuards } from '@nestjs/common';
import { DriversService } from './drivers.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RegisterDriverDto } from './dto/register-driver.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { PositionDto } from './dto/position.dto';
import { UpdateVehicleDto } from './dto/vehicle.dto';

@UseGuards(JwtAuthGuard)
@Controller('drivers')
export class DriversController {
  constructor(private drivers: DriversService) {}

  @Post('register')
  register(@CurrentUser('id') userId: string, @Body() dto: RegisterDriverDto) {
    return this.drivers.register(userId, dto);
  }

  @Get('status')
  getStatus(@CurrentUser('id') userId: string) {
    return this.drivers.getStatus(userId);
  }

  @Put('toggle-online')
  toggleOnline(@CurrentUser('id') userId: string, @Body('isOnline') isOnline: boolean) {
    return this.drivers.toggleOnline(userId, isOnline);
  }

  @Put('location')
  updateLocation(@CurrentUser('id') userId: string, @Body() dto: UpdateLocationDto) {
    return this.drivers.updateLocation(userId, dto);
  }

  @Put('vehicle')
  updateVehicle(@CurrentUser('id') userId: string, @Body() dto: UpdateVehicleDto) {
    return this.drivers.updateVehicle(userId, dto);
  }

  @Delete('vehicle')
  deleteVehicle(@CurrentUser('id') userId: string) {
    return this.drivers.deleteVehicle(userId);
  }

  @Public()
  @Post('position')
  updatePosition(@Body() dto: PositionDto) {
    return this.drivers.updatePosition(dto);
  }

  @Public()
  @Get('nearby')
  getNearby(
    @Query('lat', ParseFloatPipe) lat: number,
    @Query('lng', ParseFloatPipe) lng: number,
    @Query('radius', new DefaultValuePipe(25), ParseFloatPipe) radius: number,
  ) {
    return this.drivers.getNearbyDrivers(lat, lng, radius);
  }

  @Get('earnings')
  getEarnings(
    @CurrentUser('id') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    return this.drivers.getEarnings(userId, page, limit);
  }
}
