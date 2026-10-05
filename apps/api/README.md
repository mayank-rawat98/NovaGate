# NovaGate data plane

The NestJS gateway routes tenant traffic from control-plane configuration and a Redis warm-start cache. It does not connect to PostgreSQL or expose local administrative CRUD. Tenant administration belongs to the admin API and dashboard.

HTTP requests pass through `LoggingMiddleware`, `JwtMiddleware`, the quota guard, and route/plugin processing before upstream dispatch. Observation holds active accounting until response finish/close and records final statuses exactly once, including early failures and interrupted streams. Native gRPC and WebSocket listeners have their own bounded transport lifecycles.

Build from the workspace root with `npm exec -- nx build @api-gateway/api`. Run checks with `npm exec -- nx run-many -t test lint typecheck -p @api-gateway/api`. Configuration comes from the validated factory/schema and [gateway environment template](../../docker/gateway.env.example); legacy `PROXY_SERVICES` examples are not the tenant configuration contract.

See the [root README](../../README.md) for OrbStack setup, operator bounds, private RustFS verification and deployment instructions. Read [gateway instructions](../../.github/instructions/gateway.instructions.md), [API conventions](CLAUDE.md), [gateway rules](../../AI_RULES_GATEWAY.md), and [Redis key design](../../REDIS_KEY_DESIGN.md) before implementation. Final phase acceptance and comparative load testing follow [implementation.md](../../implementation.md).
