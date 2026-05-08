import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { ResponseWithLocals } from '../shared/request-context';
import { ProxyService } from './proxy.service';

@Injectable()
export class ProxyMiddleware {
  constructor(private readonly proxyService: ProxyService) {}

  async handle(request: Request, response: ResponseWithLocals): Promise<void> {
    await this.proxyService.forward(request, response);
  }
}
