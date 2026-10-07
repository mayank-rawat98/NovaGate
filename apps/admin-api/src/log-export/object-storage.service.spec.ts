import { ConfigService } from '@nestjs/config';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { ObjectStorageService } from './object-storage.service';
import { LogExportService } from './log-export.service';
import type { DataSource } from 'typeorm';

async function stalledStorage(streamBody = false) {
  let requests = 0;
  const sockets = new Set<Socket>();
  let observed!: () => void;
  const requested = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const server = createServer((_request, response) => {
    requests++;
    observed();
    if (streamBody) {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write('{"partial":true}\n');
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const storage = new ObjectStorageService(
    new ConfigService({
      OBJECT_STORAGE_ENABLED: 'true',
      OBJECT_STORAGE_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      OBJECT_STORAGE_ACCESS_KEY: 'local-deadline-fixture',
      OBJECT_STORAGE_SECRET_KEY: 'local-deadline-fixture-secret-only',
      OBJECT_STORAGE_BUCKET: 'novagate-deadline-fixture',
    }),
  );
  return {
    storage,
    requested,
    get requests() {
      return requests;
    },
    async close() {
      storage.onModuleDestroy();
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

describe('Private object storage on real stalled HTTP transport', () => {
  it.each(['startup', 'download', 'remove', 'cleanup', 'upload'] as const)(
    'cancels a stalled %s operation on shutdown without retrying it',
    async (kind) => {
      const fixture = await stalledStorage();
      const pending =
        kind === 'startup'
          ? fixture.storage.onModuleInit()
          : kind === 'download'
            ? fixture.storage.download('private-fixture.ndjson')
            : kind === 'remove'
              ? fixture.storage.remove('private-fixture.ndjson')
              : kind === 'cleanup'
                ? fixture.storage.cleanup('tenants/fixture/')
                : fixture.storage.upload(
                    'private-fixture.ndjson',
                    Readable.from(['fixture']),
                    new AbortController().signal,
                  );
      const rejected = expect(pending).rejects.toThrow();
      try {
        await fixture.requested;
        fixture.storage.onModuleDestroy();
        await rejected;
        expect(fixture.requests).toBe(1);
      } finally {
        await fixture.close();
      }
    },
    5000,
  );

  it('cancels worker cleanup before waiting for storage and preserves retry state', async () => {
    const fixture = await stalledStorage();
    const statements: string[] = [];
    const worker = new LogExportService(
      {
        query: async (sql: string) => {
          statements.push(sql);
          return sql.startsWith('WITH candidates')
            ? [
                {
                  id: '00000000-0000-4000-8000-000000000001',
                  tenant_id: '00000000-0000-4000-8000-000000000002',
                },
              ]
            : [];
        },
      } as unknown as DataSource,
      fixture.storage,
    );
    const cleanup = worker.cleanupExpired();
    try {
      await fixture.requested;
      await worker.onModuleDestroy();
      await cleanup;
      expect(fixture.requests).toBe(1);
      expect(
        statements.some((sql) =>
          sql.includes("cleanup_at=NOW()+INTERVAL '1 minute'"),
        ),
      ).toBe(true);
      expect(statements.some((sql) => sql.startsWith('DELETE'))).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('cancels pending cleanup with its worker signal', async () => {
    const fixture = await stalledStorage();
    const caller = new AbortController();
    const pending = fixture.storage.cleanup('tenants/fixture/', caller.signal);
    const rejected = expect(pending).rejects.toThrow();
    try {
      await fixture.requested;
      caller.abort();
      await rejected;
      expect(fixture.requests).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it('destroys owned response streams on shutdown', async () => {
    const fixture = await stalledStorage(true);
    try {
      const stream = await fixture.storage.download('private-fixture.ndjson');
      expect(stream.destroyed).toBe(false);
      fixture.storage.onModuleDestroy();
      expect(stream.destroyed).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('rejects new work after shutdown before contacting storage', async () => {
    const fixture = await stalledStorage();
    try {
      fixture.storage.onModuleDestroy();
      await expect(
        fixture.storage.remove('private-fixture.ndjson'),
      ).rejects.toThrow('cancelled');
      expect(fixture.requests).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('rejects a stalled startup request within its existing transport budget', async () => {
    const fixture = await stalledStorage();
    const operation = fixture.storage.onModuleInit().then(
      () => 'accepted',
      () => 'rejected',
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await fixture.requested;
      const outcome = await Promise.race([
        operation,
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('still-open'), 18000);
        }),
      ]);
      expect(outcome).toBe('rejected');
    } finally {
      clearTimeout(timer);
      await fixture.close();
      await operation;
    }
  }, 25000);
});
