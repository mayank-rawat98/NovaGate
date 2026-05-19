import { Module } from '@nestjs/common';
import { GatewayConfigManagerService } from './gateway-config-manager.service';

@Module({
  providers: [GatewayConfigManagerService],
  exports: [GatewayConfigManagerService],
})
export class ConfigManagerModule {}
