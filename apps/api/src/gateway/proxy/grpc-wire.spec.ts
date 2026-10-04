import { Readable } from 'node:stream';
import { GrpcFrameValidator, grpcMetadata, grpcTimeoutMs } from './grpc-wire';

function frame(body: Buffer, flag = 0) {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}
async function validate(chunks: Buffer[], limit = 16, encoding?: string) {
  const validator = new GrpcFrameValidator(limit, encoding);
  const output: Buffer[] = [];
  Readable.from(chunks).pipe(validator);
  for await (const chunk of validator) output.push(chunk);
  return Buffer.concat(output);
}
describe('streaming gRPC wire limits', () => {
  it('preserves fragmented prefixes, bodies, zero-length frames and repeated messages', async () => {
    const body = Buffer.concat([
      frame(Buffer.from('hello')),
      frame(Buffer.alloc(0)),
      frame(Buffer.from('there')),
    ]);
    expect(
      await validate([...body].map((byte) => Buffer.from([byte]))),
    ).toEqual(body);
  });
  it('does not forward a partial prefix before its declared length is validated', async () => {
    const validator = new GrpcFrameValidator(16);
    const output: Buffer[] = [];
    validator.on('data', (chunk) => output.push(chunk));
    const failed = new Promise<Error>((resolve) =>
      validator.once('error', resolve),
    );
    validator.write(Buffer.from([0, 0]));
    expect(output).toHaveLength(0);
    validator.end(Buffer.from([0, 0, 17]));
    expect(await failed).toMatchObject({ status: 8 });
    expect(output).toHaveLength(0);
  });
  it('caps individual messages rather than buffering or capping whole streams', async () => {
    const body = Buffer.concat(
      Array.from({ length: 100 }, () => frame(Buffer.alloc(16))),
    );
    expect(await validate([body])).toEqual(body);
  });
  it('rejects a declared oversize message before collecting its payload', async () => {
    const header = frame(Buffer.alloc(17)).subarray(0, 5);
    await expect(validate([header])).rejects.toMatchObject({ status: 8 });
  });
  it.each([
    Buffer.from([0]),
    Buffer.from([0, 0, 0, 0, 5, 1]),
    frame(Buffer.alloc(0), 2),
  ])('rejects invalid or incomplete framing', async (body) => {
    await expect(validate([body])).rejects.toMatchObject({ status: 13 });
  });
  it('preserves declared compression while refusing undeclared compressed frames', async () => {
    const body = frame(Buffer.from('compressed'), 1);
    expect(await validate([body], 16, 'gzip')).toEqual(body);
    await expect(validate([body])).rejects.toMatchObject({ status: 13 });
  });
  it.each([
    ['2H', 7200000],
    ['1M', 60000],
    ['2S', 2000],
    ['3m', 3],
    ['4u', 0.004],
    ['5n', 0.000005],
  ])('parses deadline %s', (value, expected) => {
    expect(grpcTimeoutMs(value as string)).toBeCloseTo(expected as number, 8);
  });
  it.each(['1s', '-1m', '123456789m', 'Infinitym', '1.5m', ''])(
    'rejects malformed deadline %s',
    (value) => {
      expect(() => grpcTimeoutMs(value)).toThrow();
    },
  );
  it('forwards arbitrary metadata without connection or pseudo headers', () => {
    expect(
      grpcMetadata({
        ':path': '/Rpc/Call',
        connection: 'keep-alive',
        'content-length': '0',
        te: 'trailers',
        'custom-bin': 'AQID',
        'x-correlation-id': 'one',
      }),
    ).toEqual({ 'custom-bin': 'AQID', 'x-correlation-id': 'one' });
  });
});
