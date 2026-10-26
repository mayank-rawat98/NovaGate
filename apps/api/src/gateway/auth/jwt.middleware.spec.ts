import { randomUUID, createHash } from 'node:crypto';
import type { TenantConfig } from '@api-gateway/shared-types';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { JwtMiddleware } from './jwt.middleware';
import { GatewayConfigManagerService } from '../config-manager/gateway-config-manager.service';
import type { GatewayConfig } from '../../config/configuration';
import type {
  RequestWithUser,
  ResponseWithLocals,
} from '../shared/request-context';

const secret = 'test-secret-with-min-length-32-chars';

const createConfigService = () =>
  ({
    get: jest.fn().mockImplementation((key: keyof GatewayConfig) => {
      if (key === 'jwt') {
        return { secret };
      }
      return undefined;
    }),
  }) as unknown as ConfigService<GatewayConfig, true>;

const createResponse = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    setHeader: jest.fn(),
    locals: {},
  } as unknown as ResponseWithLocals;
  return res;
};

describe('JwtMiddleware', () => {
  let middleware: JwtMiddleware;
  let manager: GatewayConfigManagerService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        JwtMiddleware,
        {
          provide: ConfigService,
          useValue: createConfigService(),
        },
        {
          provide: GatewayConfigManagerService,
          useValue: { getConfig: jest.fn().mockReturnValue(null) },
        },
      ],
    }).compile();

    middleware = module.get(JwtMiddleware);
    manager = module.get(GatewayConfigManagerService);
  });

  it('allows missing tokens', () => {
    const req = { headers: {} } as RequestWithUser;
    const res = createResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Request-ID',
      expect.any(String),
    );
  });
  it('does not leak raw auth-rejection URLs/IPs or redacted correlation IDs into local diagnostics', () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      jest.mocked(manager.getConfig).mockReturnValue({
        logPrivacy: {
          clientIp: 'omit',
          userAgent: 'omit',
          redactedFields: ['path', 'requestId'],
        },
      } as TenantConfig);
      const req = {
        headers: { authorization: 'invalid' },
        method: 'GET',
        originalUrl: '/person/private?token=never-log',
        ip: '192.0.2.125',
      } as unknown as RequestWithUser;
      const res = createResponse();
      middleware.use(req, res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
        }),
      );
      const record = JSON.parse(String(warn.mock.calls[0][0]));
      expect(record).toMatchObject({
        path: '[redacted]',
        requestId: '[redacted]',
        clientIp: '[redacted]',
      });
      expect(JSON.stringify(record)).not.toMatch(
        /never-log|192\.0\.2\.125|\/person/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('sets user for valid token', () => {
    const token = jwt.sign({ sub: 'user-123' }, secret, { expiresIn: '1h' });
    const req = {
      headers: {
        authorization: `Bearer ${token}`,
      },
    } as RequestWithUser;
    const res = createResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(req.user).toEqual({ id: 'user-123' });
    expect(next).toHaveBeenCalled();
  });

  it('captures a canonical registered consumer for a mapped JWT without changing its subject', () => {
    const id = randomUUID();
    const config = {
      consumers: [
        {
          id,
          name: 'consumer',
          keyHash: 'unused',
          rateLimitTier: 'authenticated',
        },
      ],
    } as unknown as TenantConfig;
    const read = jest.spyOn(manager, 'getConfig').mockReturnValue(config);
    const token = jwt.sign({ sub: id.toUpperCase() }, secret, {
      expiresIn: '1h',
    });
    const req = {
      headers: { authorization: `Bearer ${token}` },
    } as RequestWithUser;
    const next = jest.fn();
    middleware.use(req, createResponse(), next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ id: id.toUpperCase(), consumerId: id });
    read.mockReturnValue({ ...config, consumers: [] });
    expect(req.user?.consumerId).toBe(id);
  });
  it('keeps unknown UUID subjects authenticated without consumer attribution', () => {
    const id = randomUUID();
    const req = {
      headers: { authorization: `Bearer ${jwt.sign({ sub: id }, secret)}` },
    } as RequestWithUser;
    const next = jest.fn();
    middleware.use(req, createResponse(), next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ id });
  });
  it('captures registered consumer-key attribution independently of subsequent configuration replacement', () => {
    const id = randomUUID();
    const key = 'consumer-attribution-fixture-only';
    const config = {
      consumers: [
        {
          id,
          name: 'consumer',
          keyHash: createHash('sha256').update(key).digest('hex'),
          rateLimitTier: 'authenticated',
        },
      ],
    } as unknown as TenantConfig;
    const read = jest.spyOn(manager, 'getConfig').mockReturnValue(config);
    const req = {
      headers: { authorization: `Bearer ${key}` },
    } as RequestWithUser;
    const next = jest.fn();
    middleware.use(req, createResponse(), next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual({ id, consumerId: id });
    read.mockReturnValue({ ...config, consumers: [] });
    expect(req.user?.consumerId).toBe(id);
  });
  it('returns TOKEN_EXPIRED for expired token', () => {
    const token = jwt.sign({ sub: 'user-123' }, secret, { expiresIn: '-1s' });
    const req = {
      headers: {
        authorization: `Bearer ${token}`,
      },
    } as RequestWithUser;
    const res = createResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'TOKEN_EXPIRED',
      message: 'Access token has expired',
      requestId: expect.any(String),
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through a non-JWT bearer token for downstream OIDC plugins', () => {
    // The middleware intentionally passes through unrecognised tokens rather than
    // returning 401 — route-level plugins (oidc, hmac-auth, etc.) handle auth.
    const req = {
      headers: {
        authorization: 'Bearer not-a-jwt',
      },
    } as RequestWithUser;
    const res = createResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });
});
