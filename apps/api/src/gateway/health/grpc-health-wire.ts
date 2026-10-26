/** grpc.health.v1.Health/Check: only the bounded unary protobuf envelope is needed. */
export function grpcHealthRequest(service: string): Buffer {
  const name = Buffer.from(service, 'utf8');
  if (name.length > 256) throw new Error('Health service name exceeds limit');
  const length =
    name.length < 128
      ? Buffer.from([name.length])
      : Buffer.from([(name.length & 127) | 128, name.length >> 7]);
  const message = name.length
    ? Buffer.concat([Buffer.from([10]), length, name])
    : Buffer.alloc(0);
  const prefix = Buffer.alloc(5);
  prefix.writeUInt32BE(message.length, 1);
  return Buffer.concat([prefix, message]);
}

export function grpcHealthServing(frame: Buffer): boolean {
  if (
    frame.length < 5 ||
    frame[0] !== 0 ||
    frame.readUInt32BE(1) !== frame.length - 5
  )
    return false;
  const message = frame.subarray(5);
  let cursor = 0;
  let status = 0n;
  const varint = (): bigint => {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      if (cursor >= message.length) throw new Error('Truncated protobuf');
      const byte = message[cursor++];
      if (index === 9 && byte > 1) throw new Error('Invalid protobuf varint');
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid protobuf varint');
  };
  try {
    while (cursor < message.length) {
      const tag = varint();
      const field = tag >> 3n;
      const wire = Number(tag & 7n);
      if (field === 0n || field > 536870911n) return false;
      if (wire === 0) {
        const value = varint();
        if (field === 1n) status = value;
      } else {
        if (field === 1n) return false;
        if (wire === 1) cursor += 8;
        else if (wire === 5) cursor += 4;
        else if (wire === 2) {
          const length = varint();
          if (length > BigInt(message.length - cursor)) return false;
          cursor += Number(length);
        } else return false;
        if (cursor > message.length) return false;
      }
    }
    return status === 1n;
  } catch {
    return false;
  }
}
