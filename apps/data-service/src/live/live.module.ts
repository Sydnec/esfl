import { Module } from '@nestjs/common';
import { LiveEventsService } from './live-events.service';
import { LiveController } from './live.controller';

@Module({
  controllers: [LiveController],
  providers: [LiveEventsService],
  exports: [LiveEventsService],
})
export class LiveModule {}
