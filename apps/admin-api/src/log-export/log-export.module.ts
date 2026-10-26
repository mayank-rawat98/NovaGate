import { ExportTransportService } from './export-transport.service';
import { ExportDeliveryStoreService } from './export-delivery-store.service';
import { ExportDeliveryWorkerService } from './export-delivery-worker.service';
import { ExportDeliverySchedulerService } from './export-delivery-scheduler.service';
import { Module } from '@nestjs/common';
import { ObjectStorageService } from './object-storage.service';
import { LogExportService } from './log-export.service';
import { LogExportController } from './log-export.controller';
import { LogExportSchedulerService } from './log-export-scheduler.service';
import { ExportDestinationsService } from './export-destinations.service';
import { ExportDestinationsController } from './export-destinations.controller';
import { ExportDeliveryController } from './export-delivery.controller';

@Module({
  providers: [
    ExportTransportService,
    ExportDeliveryStoreService,
    ExportDeliveryWorkerService,
    ExportDeliverySchedulerService,
    ExportDestinationsService,
    ObjectStorageService,
    LogExportService,
    LogExportSchedulerService,
  ],
  controllers: [
    LogExportController,
    ExportDestinationsController,
    ExportDeliveryController,
  ],
})
export class LogExportModule {}
