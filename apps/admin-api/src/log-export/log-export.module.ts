import { Module } from '@nestjs/common';
import { ObjectStorageService } from './object-storage.service';
import { LogExportService } from './log-export.service';
import { LogExportController } from './log-export.controller';
import { LogExportSchedulerService } from './log-export-scheduler.service';

@Module({
  providers: [
    ObjectStorageService,
    LogExportService,
    LogExportSchedulerService,
  ],
  controllers: [LogExportController],
})
export class LogExportModule {}
