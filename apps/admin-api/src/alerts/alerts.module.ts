import { AlertsController } from './alerts.controller';
import { Module } from '@nestjs/common';
import { AlertRulesService } from './alert-rules.service';
import { AlertEvaluatorService } from './alert-evaluator.service';
import { AlertTransportService } from './alert-transport.service';
import { AlertDeliveryService } from './alert-delivery.service';

@Module({
  controllers: [AlertsController],
  providers: [
    AlertRulesService,
    AlertEvaluatorService,
    AlertTransportService,
    AlertDeliveryService,
  ],
})
export class AlertsModule {}
