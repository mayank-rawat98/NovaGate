import { Module } from '@nestjs/common';
import { ObjectStorageService } from './object-storage.service';
import { LogExportService } from './log-export.service';
import { LogExportController } from './log-export.controller';
import { LogExportSchedulerService } from './log-export-scheduler.service';
import { ExportDestinationsService } from './export-destinations.service';
import { ExportDestinationsController } from './export-destinations.controller';

@Module({
  providers: [
    ExportDestinationsService,
    ObjectStorageService,
    LogExportService,
    LogExportSchedulerService,
  ],
  controllers: [LogExportController, ExportDestinationsController],
})
export class LogExportModule {}
