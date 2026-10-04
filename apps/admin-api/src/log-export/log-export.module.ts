import { Module } from '@nestjs/common';
import { ObjectStorageService } from './object-storage.service';
import { LogExportService } from './log-export.service';
import { LogExportController } from './log-export.controller';

@Module({
  providers: [ObjectStorageService, LogExportService],
  controllers: [LogExportController],
})
export class LogExportModule {}
