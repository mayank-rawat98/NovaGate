import { AlertsController } from './alerts.controller';
import { Module } from '@nestjs/common';
import { AlertRulesService } from './alert-rules.service';
import { AlertEvaluatorService } from './alert-evaluator.service';
import { AlertTransportService } from './alert-transport.service';
import { AlertDeliveryService } from './alert-delivery.service';
import { AnomaliesController } from '../anomalies/anomalies.controller';
import { AnomaliesService } from '../anomalies/anomalies.service';
import { AnomalyDetectorService } from '../anomalies/anomaly-detector.service';

@Module({
  controllers: [AlertsController, AnomaliesController],
  providers: [
    AlertRulesService,
    AlertEvaluatorService,
    AlertTransportService,
    AlertDeliveryService,
    AnomaliesService,
    AnomalyDetectorService,
  ],
})
export class AlertsModule {}
