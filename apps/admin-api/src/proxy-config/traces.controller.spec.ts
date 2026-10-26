import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { sign } from 'jsonwebtoken';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { TracesController } from './traces.controller';
import { TracesService } from './traces.service';
const TENANT = 'aabbccdd-1111-2222-3333-444455556666';
const OTHER = 'aabbccdd-1111-2222-3333-444455556667';
const TRACE = '0123456789abcdef0123456789abcdef';
const SECRET = 'trace-fixture-platform-secret-at-least-32-chars';
describe('Trace HTTP workspace authorization', () => {
  let app: INestApplication;
  let url: string;
  const previous = process.env.PLATFORM_JWT_SECRET;
  const list = jest.fn().mockResolvedValue({ traces: [], nextCursor: null });
  const detail = jest
    .fn()
    .mockResolvedValue({ traceId: TRACE, spans: [], truncated: false });
  beforeAll(async () => {
    process.env.PLATFORM_JWT_SECRET = SECRET;
    const module = await Test.createTestingModule({
      controllers: [TracesController],
      providers: [
        { provide: APP_GUARD, useClass: TenantAuthGuard },
        { provide: TracesService, useValue: { list, detail } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  beforeEach(() => {
    list.mockClear();
    detail.mockClear();
  });
  afterAll(async () => {
    await app?.close();
    if (previous === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previous;
  });
  it.each(['', `/${TRACE}`])(
    'rejects unauthenticated and cross-workspace access on %s',
    async (suffix) => {
      expect(
        (await fetch(`${url}/tenants/${TENANT}/traces${suffix}`)).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${url}/tenants/${OTHER}/traces${suffix}`, {
            headers: {
              authorization: `Bearer ${sign({ sub: TENANT }, SECRET)}`,
            },
          })
        ).status,
      ).toBe(403);
      expect(list).not.toHaveBeenCalled();
      expect(detail).not.toHaveBeenCalled();
    },
  );
  it('passes authenticated workspace identity and filters to list and detail', async () => {
    const headers = {
      authorization: `Bearer ${sign({ sub: TENANT }, SECRET)}`,
    };
    expect(
      (
        await fetch(`${url}/tenants/${TENANT}/traces?errorsOnly=true`, {
          headers,
        })
      ).status,
    ).toBe(200);
    expect(list).toHaveBeenCalledWith(TENANT, { errorsOnly: 'true' });
    expect(
      (await fetch(`${url}/tenants/${TENANT}/traces/${TRACE}`, { headers }))
        .status,
    ).toBe(200);
    expect(detail).toHaveBeenCalledWith(TENANT, TRACE);
  });
});
