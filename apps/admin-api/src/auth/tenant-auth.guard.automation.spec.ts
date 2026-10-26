import { Controller, Get, INestApplication, Param, Req } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TenantAuthGuard } from './tenant-auth.guard';
import { AutomationScope } from '../automation-tokens/automation-scope.decorator';
import {
  AUTOMATION_STREAM_RECHECK_MS,
  AutomationTokensService,
} from '../automation-tokens/automation-tokens.service';

const TENANT = 'aabbccdd-1111-2222-3333-444455556666';
const TOKEN = `ngat_${'a'.repeat(43)}`;

@Controller('tenants/:tenantId/probe')
class ProbeController {
  @AutomationScope('routes:read')
  @Get('read')
  read(@Req() req: { sessionExpiresAt?: number; principal?: unknown }) {
    return { expires: req.sessionExpiresAt, principal: req.principal };
  }
  @AutomationScope((request) =>
    request.query.mode === 'write' ? 'routes:write' : 'routes:read',
  )
  @Get('dynamic')
  dynamic() {
    return {};
  }
  @Get('session-only')
  sessionOnly(@Param('tenantId') tenantId: string) {
    return { tenantId };
  }
}

describe('Automation token authorization in the tenant guard', () => {
  let app: INestApplication;
  let url: string;
  const previousSecret = process.env.PLATFORM_JWT_SECRET;
  const authenticate = jest.fn();

  beforeAll(async () => {
    process.env.PLATFORM_JWT_SECRET =
      'automation-guard-secret-with-at-least-32-chars';
    const module = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: AutomationTokensService, useValue: { authenticate } },
        { provide: APP_GUARD, useClass: TenantAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => {
    await app.close();
    if (previousSecret === undefined) delete process.env.PLATFORM_JWT_SECRET;
    else process.env.PLATFORM_JWT_SECRET = previousSecret;
  });
  beforeEach(() => authenticate.mockReset());
  const get = (path: string) =>
    fetch(`${url}/tenants/${TENANT}/probe/${path}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

  it('denies unscoped endpoints before looking up the token', async () => {
    const response = await get('session-only');
    expect(response.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it('rejects unknown tokens with one indistinguishable error', async () => {
    authenticate.mockResolvedValue(undefined);
    const response = await get('read');
    expect(response.status).toBe(401);
    expect(authenticate).toHaveBeenCalledWith(TOKEN);
  });
  it('rejects a token for another workspace', async () => {
    authenticate.mockResolvedValue({
      tokenId: 't',
      tenantId: 'aabbccdd-1111-2222-3333-444455556667',
      scopes: ['routes:read'],
      expiresAt: Date.now() + 86400000,
    });
    expect((await get('read')).status).toBe(403);
  });
  it('resolves request-dependent scopes', async () => {
    authenticate.mockResolvedValue({
      tokenId: 't',
      tenantId: TENANT,
      scopes: ['routes:read'],
      expiresAt: Date.now() + 86400000,
    });
    expect((await get('dynamic')).status).toBe(200);
    expect((await get('dynamic?mode=write')).status).toBe(403);
  });
  it('caps stream lifetime so revocation applies on reconnect', async () => {
    const expiresAt = Date.now() + 86400000;
    authenticate.mockResolvedValue({
      tokenId: 'token-id',
      tenantId: TENANT,
      scopes: ['routes:write'],
      expiresAt,
    });
    const before = Date.now();
    const body = (await (await get('read')).json()) as {
      expires: number;
      principal: unknown;
    };
    expect(body.principal).toEqual({
      kind: 'automation',
      tenantId: TENANT,
      tokenId: 'token-id',
    });
    expect(body.expires).toBeGreaterThanOrEqual(
      before + AUTOMATION_STREAM_RECHECK_MS,
    );
    expect(body.expires).toBeLessThanOrEqual(
      Date.now() + AUTOMATION_STREAM_RECHECK_MS,
    );
    authenticate.mockResolvedValue({
      tokenId: 'token-id',
      tenantId: TENANT,
      scopes: ['routes:read'],
      expiresAt: before + 1000,
    });
    expect(
      ((await (await get('read')).json()) as { expires: number }).expires,
    ).toBe(before + 1000);
  });
});
