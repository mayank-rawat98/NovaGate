import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  PortalDevelopersService,
  type PortalPrincipal,
} from './portal-developers.service';
import type { PortalDeveloperProfile } from '@api-gateway/shared-types';

export type DeveloperRequest = {
  headers: { authorization?: string };
  params: { tenantId?: string };
  developer?: PortalPrincipal & { profile: PortalDeveloperProfile };
};

/** Developer endpoints accept only portal sessions for the addressed workspace. */
@Injectable()
export class PortalDeveloperGuard implements CanActivate {
  constructor(private readonly developers: PortalDevelopersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'no-store');
    const req = context.switchToHttp().getRequest<DeveloperRequest>();
    const authorization = req.headers.authorization;
    if (!authorization || !/^Bearer \S+$/i.test(authorization))
      throw new UnauthorizedException('Sign in to the portal first');
    req.developer = await this.developers.authenticate(
      req.params.tenantId ?? '',
      authorization.slice(7),
    );
    return true;
  }
}
