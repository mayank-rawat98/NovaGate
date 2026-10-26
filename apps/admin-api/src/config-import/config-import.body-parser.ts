import type { INestApplication } from '@nestjs/common';
import { text, type Request, type Response, type NextFunction } from 'express';
import { DECLARATIVE_CONFIG_MAX_BYTES } from '@api-gateway/shared-types';

/** Run before Nest's JSON parser, retaining duplicate keys for validation. */
export function configureConfigImportParser(app: INestApplication) {
  app.use(
    ['/api/tenants/:tenantId/import', '/api/tenants/:tenantId/export'],
    (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );
  app.use(
    '/api/tenants/:tenantId/import',
    text({
      type: ['application/json', 'application/yaml', 'text/yaml', 'text/plain'],
      limit: DECLARATIVE_CONFIG_MAX_BYTES,
    }),
  );
}
