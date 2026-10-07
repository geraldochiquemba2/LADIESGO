import { Module } from '@nestjs/common';
import { TripsService } from './trips.service';
import { WebTripsService } from './web-trips.service';
import { TripsController } from './trips.controller';
import { WebTripsController } from './web-trips.controller';
import { TripsGateway } from './trips.gateway';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PromosModule } from '../promos/promos.module';
import { DriversModule } from '../drivers/drivers.module';

@Module({
  imports: [AuthModule, NotificationsModule, PromosModule, DriversModule],
  controllers: [WebTripsController, TripsController],
  providers: [TripsService, WebTripsService, TripsGateway],
  exports: [TripsService, TripsGateway],
})
export class TripsModule {}
