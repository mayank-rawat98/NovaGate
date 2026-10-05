import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import {
  Tenant,
  ApiKey,
  PendingConfigUpdate,
} from '../database/entities/public.entities';
import { MigrationService } from '../database/migration.service';
import { TenantProvisioningService } from '../tenants/tenant-provisioning.service';
import { ConfigPushService } from './config-push.service';

const integration =
  process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL
    ? describe
    : describe.skip;

integration(
  'Admin configuration delivery with real PostgreSQL and Redis',
  () => {
    let root: DataSource;
    let ds: DataSource;
    let push: ConfigPushService;
    let subscriber: Redis;
    let tenantId: string;
    const database = `novagate_admin_test_${randomUUID().replace(/-/g, '')}`;
    const previousRedis = process.env.REDIS_URL;
    const received: Array<{ tenantId: string; version: number }> = [];

    beforeAll(async () => {
      root = new DataSource({
        type: 'postgres',
        url: process.env.TEST_DATABASE_URL,
      });
      await root.initialize();
      await root.query(`CREATE DATABASE ${database}`);
      const url = new URL(process.env.TEST_DATABASE_URL as string);
      url.pathname = `/${database}`;
      ds = new DataSource({
        type: 'postgres',
        url: url.toString(),
        entities: [Tenant, ApiKey, PendingConfigUpdate],
        synchronize: false,
      });
      await ds.initialize();
      await ds.query(
        readFileSync(
          resolve(__dirname, '../../../../docker/postgres-init.sql'),
          'utf8',
        ),
      );
      await new MigrationService(ds).onModuleInit();
      const tenant = await ds.getRepository(Tenant).save({
        name: 'Test tenant',
        email: 'test@example.test',
        planId: 'free',
        gatewayConfigVersion: 0,
        emailVerified: true,
        passwordHash: 'preserve-auth-column',
      });
      tenantId = tenant.id;
      await new TenantProvisioningService(ds).provisionTenant(tenantId);
      const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
      await ds.query(
        `INSERT INTO ${schema}.services (name, targets, "loadBalancing") VALUES ('persisted-service', '[{"url":"http://example.test","weight":1}]'::jsonb, 'least-connections')`,
      );
      process.env.REDIS_URL = process.env.TEST_REDIS_URL;
      push = new ConfigPushService(ds);
      push.onModuleInit();
      subscriber = new Redis(process.env.TEST_REDIS_URL as string);
      subscriber.on('message', (_, payload) =>
        received.push(JSON.parse(payload)),
      );
      await subscriber.subscribe('config.update');
    }, 30000);

    afterAll(async () => {
      push?.onModuleDestroy();
      subscriber?.disconnect();
      if (ds?.isInitialized) await ds.destroy();
      if (root?.isInitialized) {
        await root.query(`DROP DATABASE IF EXISTS ${database}`);
        await root.destroy();
      }
      if (previousRedis === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedis;
    }, 30000);

    it('creates consumer groups on new tenant schemas', async () => {
      const schema = `tenant_${tenantId.replace(/-/g, '_')}`;
      const rows = await ds.query(
        `INSERT INTO ${schema}.consumers (name, "keyHash") VALUES ('client', 'hash') RETURNING groups`,
      );
      expect(rows[0].groups).toEqual([]);
    });

    it('persists one complete latest snapshot despite concurrent publications', async () => {
      await Promise.all([
        push.triggerUpdate(tenantId),
        push.triggerUpdate(tenantId),
      ]);
      const pending = await ds
        .getRepository(PendingConfigUpdate)
        .findBy({ tenantId });
      expect(pending).toHaveLength(1);
      expect(pending[0].config.version).toBe(2);
      const config = pending[0].config.config as {
        services: Array<{ name: string; loadBalancing: string }>;
      };
      expect(config.services[0].name).toBe('persisted-service');
      expect(config.services[0].loadBalancing).toBe('least-connections');
      for (
        let i = 0;
        i < 100 && received.filter((m) => m.tenantId === tenantId).length < 2;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        received
          .filter((m) => m.tenantId === tenantId)
          .map((m) => m.version)
          .sort(),
      ).toEqual([1, 2]);
    });

    it('does not alter existing authentication data during migration', async () => {
      await new MigrationService(ds).onModuleInit();
      const [tenant] = await ds.query(
        'SELECT "passwordHash" FROM public.tenants WHERE id = $1',
        [tenantId],
      );
      expect(tenant.passwordHash).toBe('preserve-auth-column');
    });

    it('rejects unknown tenants without writing a pending snapshot', async () => {
      await expect(push.triggerUpdate(randomUUID())).rejects.toThrow(
        'Tenant not found',
      );
      expect(await ds.getRepository(PendingConfigUpdate).count()).toBe(1);
    });
  },
);
