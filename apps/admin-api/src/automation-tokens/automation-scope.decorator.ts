import { SetMetadata } from '@nestjs/common';
import type { AutomationTokenScope } from '@api-gateway/shared-types';

export const AUTOMATION_SCOPE = 'novagate:automation-scope';

export interface ScopedRequest {
  query: Record<string, unknown>;
}
export type AutomationScopeRequirement =
  | AutomationTokenScope
  | ((request: ScopedRequest) => AutomationTokenScope);

/**
 * Declares the scope an automation token needs for this endpoint. A resolver
 * can pick the scope from the request, such as a write-free preview mode.
 * Endpoints without it accept only interactive tenant sessions (default deny).
 */
export const AutomationScope = (scope: AutomationScopeRequirement) =>
  SetMetadata(AUTOMATION_SCOPE, scope);
