import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { JwtMiddleware } from './jwt.middleware';
import type { GatewayConfig } from '../../config/configuration';
import type { RequestWithUser, ResponseWithLocals } from '../shared/request-context';

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

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        JwtMiddleware,
        {
          provide: ConfigService,
          useValue: createConfigService(),
        },
      ],
    }).compile();

    middleware = module.get(JwtMiddleware);
  });

  it('allows missing tokens', () => {
    const req = { headers: {} } as RequestWithUser;
    const res = createResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', expect.any(String));
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

  it('returns TOKEN_INVALID for malformed token', () => {
    const req = {
      headers: {
        authorization: 'Bearer not-a-token',
      },
    } as RequestWithUser;
    const res = createResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'TOKEN_INVALID',
      message: 'Access token is invalid',
      requestId: expect.any(String),
    });
    expect(next).not.toHaveBeenCalled();
  });
});
