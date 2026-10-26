import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { verify } from 'jsonwebtoken';
import { automationScopeAllows } from '@api-gateway/shared-types';
import { platformJwtSecret } from './platform-jwt-secret';
import {
  AUTOMATION_SCOPE,
  type AutomationScopeRequirement,
} from '../automation-tokens/automation-scope.decorator';
import {
  AUTOMATION_STREAM_RECHECK_MS,
  AutomationTokensService,
  looksLikeAutomationToken,
} from '../automation-tokens/automation-tokens.service';

export type RequestPrincipal =
  | { kind: 'session'; tenantId: string }
  | { kind: 'automation'; tenantId: string; tokenId: string };

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

@Injectable()
export class TenantAuthGuard implements CanActivate {
  private readonly secret = platformJwtSecret();

  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly tokens?: AutomationTokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const controllerPath = this.reflector.get<string>(
      PATH_METADATA,
      context.getClass(),
    );
    if (controllerPath === 'auth' || controllerPath === 'health') return true;

    context.switchToHttp().getResponse().setHeader('Cache-Control', 'no-store');
    const req = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      params: { tenantId?: string; id?: string };
      query: Record<string, unknown>;
      sessionExpiresAt?: number;
      principal?: RequestPrincipal;
    }>();
    const authorization = req.headers.authorization;
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
      throw new UnauthorizedException('A valid session is required');
    }
    const tenantId =
      req.params.tenantId ??
      (controllerPath === 'tenants' ? req.params.id : undefined);
    const credential = authorization.slice(7);

    if (looksLikeAutomationToken(credential)) {
      const requirement = this.reflector.getAllAndOverride<
        AutomationScopeRequirement | undefined
      >(AUTOMATION_SCOPE, [context.getHandler(), context.getClass()]);
      // Check the endpoint before the database so unsupported uses stay cheap.
      if (!requirement)
        throw new ForbiddenException(
          'Automation tokens cannot access this endpoint. Sign in instead.',
        );
      const required =
        typeof requirement === 'function' ? requirement(req) : requirement;
      const principal = await this.tokens?.authenticate(credential);
      if (!principal)
        throw new UnauthorizedException('Token is invalid, expired or revoked');
      if (
        !tenantId ||
        !UUID.test(tenantId) ||
        principal.tenantId !== tenantId.toLowerCase()
      )
        throw new ForbiddenException('You cannot access this workspace');
      if (!automationScopeAllows(principal.scopes, required))
        throw new ForbiddenException(`This token needs the ${required} scope`);
      // Long-lived streams reconnect through this guard, observing revocation.
      req.sessionExpiresAt = Math.min(
        principal.expiresAt,
        Date.now() + AUTOMATION_STREAM_RECHECK_MS,
      );
      req.principal = {
        kind: 'automation',
        tenantId: principal.tenantId,
        tokenId: principal.tokenId,
      };
      return true;
    }

    let subject: string;
    try {
      const payload = verify(credential, this.secret, {
        algorithms: ['HS256'],
      });
      if (typeof payload === 'string' || typeof payload.sub !== 'string') {
        throw new Error('Missing subject');
      }
      subject = payload.sub;
      if (typeof payload.exp === 'number')
        req.sessionExpiresAt = payload.exp * 1000;
    } catch {
      throw new UnauthorizedException('Session is invalid or expired');
    }

    if (!tenantId || !UUID.test(tenantId) || subject !== tenantId) {
      throw new ForbiddenException('You cannot access this workspace');
    }
    req.principal = { kind: 'session', tenantId: subject };
    return true;
  }
}
