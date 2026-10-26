import { grpcHealthRequest, grpcHealthServing } from './grpc-health-wire';
function response(message: Buffer) {
  const prefix = Buffer.alloc(5);
  prefix.writeUInt32BE(message.length, 1);
  return Buffer.concat([prefix, message]);
}
describe('standard gRPC health protobuf envelope', () => {
  it('encodes whole-server and UTF-8 service requests with bounded varint lengths', () => {
    expect(grpcHealthRequest('')).toEqual(Buffer.alloc(5));
    expect(grpcHealthRequest('Echo')).toEqual(
      Buffer.from([0, 0, 0, 0, 6, 10, 4, 69, 99, 104, 111]),
    );
    const named = grpcHealthRequest('x'.repeat(256));
    expect(named.subarray(5, 8)).toEqual(Buffer.from([10, 128, 2]));
    expect(() => grpcHealthRequest('x'.repeat(257))).toThrow();
  });
  it.each([0, 2, 3, 7])('does not accept serving status %i', (status) =>
    expect(grpcHealthServing(response(Buffer.from([8, status])))).toBe(false),
  );
  it('accepts only SERVING, skips unknown fields and observes the last status field', () => {
    expect(grpcHealthServing(response(Buffer.from([8, 1])))).toBe(true);
    expect(grpcHealthServing(response(Buffer.from([18, 2, 1, 2, 8, 1])))).toBe(
      true,
    );
    expect(grpcHealthServing(response(Buffer.from([8, 1, 8, 2])))).toBe(false);
  });
  it.each([
    Buffer.from([0]),
    Buffer.from([0, 0, 0, 0, 99, 8, 1]),
    Buffer.from([1, 0, 0, 0, 2, 8, 1]),
    response(Buffer.from([8, 128])),
    response(Buffer.from([0, 1])),
    response(Buffer.from([10, 1, 1])),
    response(Buffer.from([18, 100, 1])),
  ])('fails closed on malformed frames or protobuf', (data) =>
    expect(grpcHealthServing(data)).toBe(false),
  );
});
