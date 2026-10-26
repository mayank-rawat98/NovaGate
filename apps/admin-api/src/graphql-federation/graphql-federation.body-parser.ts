import type { INestApplication } from '@nestjs/common';
import { json, type NextFunction, type Request, type Response } from 'express';
import {
  MAX_SUBGRAPHS,
  MAX_SUBGRAPH_SDL_BYTES,
} from '@api-gateway/shared-types';

/** Subgraph SDL exceeds Nest's 100 KB JSON default: allow every subgraph at
 * its limit, with room for JSON string escaping. Runs before Nest's parser. */
export const FEDERATION_REQUEST_LIMIT_BYTES =
  MAX_SUBGRAPHS * MAX_SUBGRAPH_SDL_BYTES * 2;

export function configureFederationParser(app: INestApplication) {
  const parse = json({ limit: FEDERATION_REQUEST_LIMIT_BYTES });
  // A named wrapper: Nest skips registering its own JSON parser when it
  // finds a middleware layer called jsonParser.
  app.use(
    '/api/tenants/:tenantId/graphql-federation',
    function federationJsonParser(
      req: Request,
      res: Response,
      next: NextFunction,
    ) {
      parse(req, res, next);
    },
  );
}
