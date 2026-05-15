import { Controller, Get } from '@nestjs/common';
import { ControlPlaneConnectorService } from '../connector/control-plane-connector.service';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';

const APP_VERSION: string = process.env['npm_package_version'] ?? '0.0.0';

interface HealthResponse {
  status: 'ok';
  controlPlaneConnected: boolean;
  configSource: 'live' | 'cache' | 'none';
  configVersion: number | null;
  configCachedAt: Date | null;
  uptime: number;
}

interface GatewayInfoResponse extends HealthResponse {
  version: string;
  tenantId: string | null;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly connector: ControlPlaneConnectorService,
    private readonly configManager: GatewayConfigManagerService,
  ) {}

  @Get()
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      controlPlaneConnected: this.connector.isConnected(),
      configSource: this.configManager.configSource,
      configVersion: this.configManager.configVersion,
      configCachedAt: this.configManager.configCachedAt,
      uptime: process.uptime(),
    };
  }

  @Get('gateway-info')
  getGatewayInfo(): GatewayInfoResponse {
    return {
      ...this.getHealth(),
      version: APP_VERSION,
      tenantId: this.configManager.getTenantId(),
    };
  }
}
