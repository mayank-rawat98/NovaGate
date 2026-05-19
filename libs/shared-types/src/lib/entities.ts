export interface TenantEntity {
  id: string;
  name: string;
  email: string;
  planId: string;
  gatewayConfigVersion: number;
  lastSeen?: string;
  createdAt: string;
  caCertPem?: string;
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
  retry?: {
    attempts: number;
    on: number[];
    methods: string[];
  };
  plugins?: Array<{ name: string; config: Record<string, unknown> }>;
  acl?: {
    allow?: string[];
    deny?: string[];
  };
  createdAt: string;
  deletedAt?: string;
}

export interface ServiceEntity {
  id: string;
  tenantId: string;
  name: string;
  targets: Array<{ url: string; weight: number }>;
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
  groups?: string[];
  createdAt: string;
  revokedAt?: string;
}

export interface PendingConfigUpdateEntity {
  id: string;
  tenantId: string;
  config: any;
  updatedAt: string;
}
