import { Module } from '@nestjs/common';
import { TurnController } from './turn.controller';

@Module({
  controllers: [TurnController],
})
export class TurnModule {}
