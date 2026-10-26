import { parseGrpcPath, isGrpcRequest } from './grpc-proxy.service';

describe('parseGrpcPath', () => {
  it('parses standard gRPC path', () => {
    expect(parseGrpcPath('/helloworld.Greeter/SayHello')).toEqual({
      grpcService: 'helloworld.Greeter',
      grpcMethod: 'SayHello',
    });
  });

  it('handles short paths gracefully', () => {
    expect(parseGrpcPath('/Service')).toEqual({
      grpcService: 'Service',
      grpcMethod: 'unknown',
    });
  });

  it('returns unknown for empty path', () => {
    expect(parseGrpcPath('/')).toEqual({
      grpcService: 'unknown',
      grpcMethod: 'unknown',
    });
  });
});

describe('isGrpcRequest', () => {
  it('returns true for application/grpc', () => {
    expect(isGrpcRequest({ 'content-type': 'application/grpc' })).toBe(true);
  });

  it('returns true for application/grpc+proto', () => {
    expect(isGrpcRequest({ 'content-type': 'application/grpc+proto' })).toBe(
      true,
    );
  });

  it('returns false for application/json', () => {
    expect(isGrpcRequest({ 'content-type': 'application/json' })).toBe(false);
  });

  it('returns false when content-type is absent', () => {
    expect(isGrpcRequest({})).toBe(false);
  });

  it('handles content-type with extra parameters', () => {
    expect(
      isGrpcRequest({
        'content-type': 'application/grpc+proto; charset=utf-8',
      }),
    ).toBe(true);
  });
});

it('does not misclassify gRPC-Web as native gRPC', () => {
  expect(isGrpcRequest({ 'content-type': 'application/grpc-web+proto' })).toBe(
    false,
  );
});
