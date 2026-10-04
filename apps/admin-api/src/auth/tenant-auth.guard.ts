import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { verify } from 'jsonwebtoken';
import { platformJwtSecret } from './platform-jwt-secret';

@Injectable()
export class TenantAuthGuard implements CanActivate {
  private readonly secret = platformJwtSecret();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const controllerPath = this.reflector.get<string>(
      PATH_METADATA,
      context.getClass(),
    );
    if (controllerPath === 'auth' || controllerPath === 'health') return true;

    const req = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      params: { tenantId?: string; id?: string };
    }>();
    const authorization = req.headers.authorization;
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      throw new UnauthorizedException('A valid session is required');
    }
    let subject: string;
    try {
      const payload = verify(authorization.slice(7), this.secret, {
        algorithms: ['HS256'],
      });
      if (typeof payload === 'string' || typeof payload.sub !== 'string') {
        throw new Error('Missing subject');
      }
      subject = payload.sub;
    } catch {
      throw new UnauthorizedException('Session is invalid or expired');
    }

    const tenantId =
      req.params.tenantId ??
      (controllerPath === 'tenants' ? req.params.id : undefined);
    if (
      !tenantId ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(tenantId) ||
      subject !== tenantId
    ) {
      throw new ForbiddenException('You cannot access this workspace');
    }
    return true;
  }
}
