import { Controller, Req, Res, All } from '@nestjs/common';
import type { Request } from 'express';
import type { ResponseWithLocals } from '../shared/request-context';
import { ProxyMiddleware } from './proxy.middleware';

@Controller()
export class ProxyController {
  constructor(private readonly proxyMiddleware: ProxyMiddleware) {}

  @All('*')
  async handleProxy(
    @Req() request: Request,
    @Res() response: ResponseWithLocals,
  ): Promise<void> {
    await this.proxyMiddleware.handle(request, response);
  }
}
