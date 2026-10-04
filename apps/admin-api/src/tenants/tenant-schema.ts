import { BadRequestException } from '@nestjs/common';

export function tenantSchema(tenantId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      tenantId,
    )
  ) {
    throw new BadRequestException('Invalid tenantId');
  }
  return `tenant_${tenantId.toLowerCase().replace(/-/g, '_')}`;
}
