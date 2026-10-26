import { Transform, TransformCallback } from 'node:stream';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http2';

export class GrpcFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Validate framing without collecting messages. At most five prefix bytes are retained. */
export class GrpcFrameValidator extends Transform {
  private readonly prefix = Buffer.alloc(5);
  private prefixBytes = 0;
  private remaining = 0;
  constructor(
    private readonly maxMessageBytes: number,
    private readonly encoding?: string,
  ) {
    super();
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    try {
      let cursor = 0;
      while (cursor < chunk.length) {
        if (this.remaining) {
          const consumed = Math.min(this.remaining, chunk.length - cursor);
          this.push(chunk.subarray(cursor, cursor + consumed));
          this.remaining -= consumed;
          cursor += consumed;
          continue;
        }
        const copied = Math.min(5 - this.prefixBytes, chunk.length - cursor);
        chunk.copy(this.prefix, this.prefixBytes, cursor, cursor + copied);
        this.prefixBytes += copied;
        cursor += copied;
        if (this.prefixBytes === 5) {
          if (
            this.prefix[0] > 1 ||
            (this.prefix[0] === 1 &&
              (!this.encoding || this.encoding === 'identity'))
          )
            throw new GrpcFailure(13, 'Invalid gRPC compression flag');
          this.remaining = this.prefix.readUInt32BE(1);
          if (this.remaining > this.maxMessageBytes)
            throw new GrpcFailure(8, 'gRPC message exceeds configured limit');
          this.push(Buffer.from(this.prefix));
          this.prefixBytes = 0;
        }
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
  override _flush(callback: TransformCallback) {
    callback(
      this.prefixBytes || this.remaining
        ? new GrpcFailure(13, 'Incomplete gRPC frame')
        : undefined,
    );
  }
}

/** A malformed deadline is rejected rather than silently becoming unlimited. */
export function grpcTimeoutMs(
  value: string | string[] | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{1,8}[HMSmun]$/.test(value))
    throw new GrpcFailure(3, 'Invalid grpc-timeout');
  const units: Record<string, number> = {
    H: 3600000,
    M: 60000,
    S: 1000,
    m: 1,
    u: 0.001,
    n: 0.000001,
  };
  return Number(value.slice(0, -1)) * units[value.at(-1) as string];
}

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
  'content-length',
  'host',
  'te',
]);
export function grpcMetadata(
  headers: IncomingHttpHeaders,
): OutgoingHttpHeaders {
  const output: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name.startsWith(':') && !HOP_HEADERS.has(name) && value !== undefined)
      output[name] = value;
  }
  return output;
}
export function grpcHeaderBytes(headers: IncomingHttpHeaders): number {
  return Object.entries(headers).reduce(
    (sum, [key, value]) =>
      sum +
      key.length +
      (Array.isArray(value)
        ? value.join(',').length
        : String(value ?? '').length) +
      32,
    0,
  );
}
