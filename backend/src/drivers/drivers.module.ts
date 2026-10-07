import { Module } from '@nestjs/common';
import { DriversService } from './drivers.service';
import { LiveDriversService } from './live-drivers.service';
import { DriversController } from './drivers.controller';

@Module({
  controllers: [DriversController],
  providers: [DriversService, LiveDriversService],
  exports: [DriversService, LiveDriversService],
})
export class DriversModule {}
