import { AlertsController } from './alerts.controller';
import { Module } from '@nestjs/common';
import { AlertRulesService } from './alert-rules.service';
import { AlertEvaluatorService } from './alert-evaluator.service';

@Module({
  controllers: [AlertsController],
  providers: [AlertRulesService, AlertEvaluatorService],
})
export class AlertsModule {}
