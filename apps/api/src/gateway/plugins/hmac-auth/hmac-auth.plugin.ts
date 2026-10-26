import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import {
  MAX_HMAC_SECRETS,
  MAX_HMAC_SECRET_BYTES,
  MAX_HMAC_CLOCK_SKEW_SECONDS,
} from '@api-gateway/shared-types';
import type {
  GatewayPlugin,
  PluginContext,
  PluginShortCircuit,
  HmacPluginConfig,
} from '@api-gateway/shared-types';
import {
  DEFAULT_HMAC,
  GatewayConfig,
  HmacSettings,
} from '../../../config/configuration';

import {
  BodyCaptureError,
  RequestBodyService,
} from '../../shared/request-body.service';
type RawRequest = IncomingMessage & { rawBody?: Buffer };
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

@Injectable()
export class HmacAuthPlugin implements GatewayPlugin {
  readonly name = 'hmac-auth';
  readonly protocols = ['http'] as const;
  private readonly settings: HmacSettings;

  constructor(
    configService: ConfigService<GatewayConfig, true>,
    private readonly bodies: RequestBodyService = new RequestBodyService(
      configService,
    ),
  ) {
    this.settings = {
      ...DEFAULT_HMAC,
      ...configService.get('hmac', { infer: true }),
    };
  }

  async prepareRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find((p) => p.name === this.name);
    if (!entry) return;
    const cfg = entry.config as unknown as HmacPluginConfig;
    if (!this.validConfig(cfg))
      return this.failure(ctx, 500, 'HMAC_CONFIG_INVALID');
    const signature = this.header(ctx.req, cfg.header);
    if (typeof signature !== 'string')
      return this.failure(
        ctx,
        401,
        signature === undefined
          ? 'HMAC_SIGNATURE_MISSING'
          : 'HMAC_SIGNATURE_INVALID',
      );
    try {
      await this.bodies.read(ctx);
    } catch (error) {
      const failure =
        error instanceof BodyCaptureError
          ? error
          : new BodyCaptureError(400, 'HMAC_BODY_READ_ERROR');
      return this.failure(ctx, failure.status, failure.code);
    }
  }

  async onRequest(ctx: PluginContext): Promise<PluginShortCircuit | void> {
    const entry = ctx.route.plugins?.find((p) => p.name === this.name);
    if (!entry) return;
    const cfg = entry.config as unknown as HmacPluginConfig;
    if (!this.validConfig(cfg))
      return this.failure(ctx, 500, 'HMAC_CONFIG_INVALID');
    const req = ctx.req as RawRequest;
    // Read original wire headers, even when an earlier transform mutates req.headers.
    const signature = this.header(req, cfg.header);
    if (signature === undefined)
      return this.failure(ctx, 401, 'HMAC_SIGNATURE_MISSING');
    if (signature === null)
      return this.failure(ctx, 401, 'HMAC_SIGNATURE_INVALID');
    let timestamp: string | undefined;
    let signatures: string[];
    if (cfg.mode === 'stripe') {
      const fields = signature.split(',');
      const timestamps = fields.filter((v) => v.startsWith('t='));
      signatures = fields
        .filter((v) => v.startsWith('v1='))
        .map((v) => v.slice(3));
      // Accept other version fields for forward compatibility, never as credentials.
      if (
        timestamps.length !== 1 ||
        fields.some((v) => !/^[a-zA-Z0-9]+=[^,]+$/.test(v))
      )
        return this.failure(ctx, 401, 'HMAC_SIGNATURE_INVALID');
      timestamp = timestamps[0].slice(2);
    } else {
      const prefix = `${cfg.algorithm}=`;
      signatures = [
        signature.startsWith(prefix)
          ? signature.slice(prefix.length)
          : signature,
      ];
      if (cfg.timestampHeader) {
        const value = this.header(req, cfg.timestampHeader);
        if (typeof value !== 'string')
          return this.failure(ctx, 401, 'HMAC_TIMESTAMP_INVALID');
        timestamp = value;
      }
    }
    const hexLength = cfg.algorithm === 'sha256' ? 64 : 128;
    if (
      !signatures.length ||
      signatures.length > this.settings.maxSignatures ||
      signatures.some(
        (v) => v.length !== hexLength || !/^[0-9a-fA-F]+$/.test(v),
      )
    )
      return this.failure(ctx, 401, 'HMAC_SIGNATURE_INVALID');
    if (
      timestamp !== undefined &&
      !this.fresh(timestamp, cfg.maxClockSkewSeconds)
    )
      return this.failure(ctx, 401, 'HMAC_TIMESTAMP_INVALID');
    const preparation = await this.prepareRequest(ctx);
    if (preparation) return preparation;
    try {
      const body = await this.bodies.read(ctx);
      if (!Buffer.isBuffer(body))
        throw new BodyCaptureError(400, 'HMAC_BODY_READ_ERROR');
      if (ctx.signal?.aborted)
        throw new BodyCaptureError(400, 'HMAC_BODY_READ_ERROR');
      // Recheck after upload: a slow body must not extend the freshness window.
      if (
        timestamp !== undefined &&
        !this.fresh(timestamp, cfg.maxClockSkewSeconds)
      )
        return this.failure(ctx, 401, 'HMAC_TIMESTAMP_INVALID');
      const actual = signatures.map((v) => Buffer.from(v, 'hex'));
      let valid = false;
      for (const secret of cfg.secrets) {
        const hmac = createHmac(cfg.algorithm, secret);
        if (timestamp !== undefined) hmac.update(`${timestamp}.`);
        const expected = hmac.update(body).digest();
        for (const value of actual) {
          // Compare every rotation key/signature; do not reveal the matching position.
          const matches = timingSafeEqual(expected, value);
          valid = matches || valid;
        }
      }
      if (!valid) return this.failure(ctx, 401, 'HMAC_SIGNATURE_INVALID');
      ctx.authentication = { method: this.name };
    } catch (error) {
      const failure =
        error instanceof BodyCaptureError
          ? error
          : new BodyCaptureError(400, 'HMAC_BODY_READ_ERROR');
      return this.failure(ctx, failure.status, failure.code);
    } finally {
      this.bodies.releaseDetached(ctx);
    }
  }

  private validConfig(cfg: HmacPluginConfig): boolean {
    return (
      !!cfg &&
      (cfg.mode === undefined ||
        cfg.mode === 'generic' ||
        cfg.mode === 'stripe') &&
      typeof cfg.header === 'string' &&
      HEADER_NAME.test(cfg.header) &&
      Buffer.byteLength(cfg.header) <= this.settings.maxHeaderBytes &&
      (cfg.algorithm === 'sha256' || cfg.algorithm === 'sha512') &&
      Array.isArray(cfg.secrets) &&
      cfg.secrets.length > 0 &&
      cfg.secrets.length <= MAX_HMAC_SECRETS &&
      cfg.secrets.every(
        (s) =>
          typeof s === 'string' &&
          s.length > 0 &&
          Buffer.byteLength(s) <= MAX_HMAC_SECRET_BYTES,
      ) &&
      (cfg.maxClockSkewSeconds === undefined ||
        (Number.isSafeInteger(cfg.maxClockSkewSeconds) &&
          cfg.maxClockSkewSeconds >= 1 &&
          cfg.maxClockSkewSeconds <= MAX_HMAC_CLOCK_SKEW_SECONDS &&
          (cfg.mode === 'stripe' || !!cfg.timestampHeader))) &&
      (cfg.timestampHeader === undefined ||
        (typeof cfg.timestampHeader === 'string' &&
          HEADER_NAME.test(cfg.timestampHeader) &&
          cfg.timestampHeader.toLowerCase() !== cfg.header.toLowerCase() &&
          Buffer.byteLength(cfg.timestampHeader) <=
            this.settings.maxHeaderBytes)) &&
      (cfg.mode !== 'stripe' ||
        (cfg.algorithm === 'sha256' && cfg.timestampHeader === undefined))
    );
  }

  private header(
    req: IncomingMessage,
    name: string,
  ): string | null | undefined {
    const key = name.toLowerCase();
    const values: string[] = [];
    if (req.rawHeaders !== undefined) {
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        if (req.rawHeaders[i].toLowerCase() === key)
          values.push(req.rawHeaders[i + 1]);
    } else {
      const value = req.headers[key];
      if (Array.isArray(value)) values.push(...value);
      else if (typeof value === 'string') values.push(value);
    }
    if (values.length === 0) return undefined;
    if (
      values.length !== 1 ||
      Buffer.byteLength(values[0]) > this.settings.maxHeaderBytes
    )
      return null;
    return values[0];
  }

  private fresh(
    timestamp: string,
    tolerance = this.settings.clockSkewSeconds,
  ): boolean {
    return (
      /^(0|[1-9][0-9]*)$/.test(timestamp) &&
      Number.isSafeInteger(Number(timestamp)) &&
      Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) <= tolerance
    );
  }

  private failure(
    ctx: PluginContext,
    status: number,
    code: string,
  ): PluginShortCircuit {
    return {
      status,
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({
        error: code,
        message:
          status === 413
            ? 'Request body exceeds the configured size limit'
            : 'Webhook signature verification could not be completed',
        requestId: ctx.requestId,
      }),
    };
  }
}
