export interface TenantEntity {
  id: string;
  name: string;
  email: string;
  planId: string;
  gatewayConfigVersion: number;
  lastSeen?: string;
  createdAt: string;
}

export interface ApiKeyEntity {
  id: string;
  tenantId: string;
  keyHash: string;
  label: string;
  revokedAt?: string;
  createdAt: string;
}

export interface RouteEntity {
  id: string;
  tenantId: string;
  method: string;
  pathPattern: string;
  serviceId: string;
  authRequired: boolean;
  rateLimitOverride?: number;
  enabled: boolean;
  createdAt: string;
  deletedAt?: string;
}

export interface ServiceEntity {
  id: string;
  tenantId: string;
  name: string;
  targetUrl: string;
  healthCheckPath: string;
  timeoutMs: number;
  createdAt: string;
  deletedAt?: string;
}

export interface ConsumerEntity {
  id: string;
  tenantId: string;
  name: string;
  keyHash: string;
  rateLimitTier: string;
  createdAt: string;
  revokedAt?: string;
}

export interface PendingConfigUpdateEntity {
  id: string;
  tenantId: string;
  config: any;
  updatedAt: string;
}
