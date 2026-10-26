# Tenant analytics and configuration APIs

All tenant endpoints use the global TenantAuthGuard; bearer subjects must match the route workspace. Shared contracts live in shared-types. Database queries use validated server-owned tenant schemas.

Issue #63 adds `metrics-stream.service.ts`: one Redis pattern subscriber fans out only to authorized, admitted tenant connections. Bound global/per-tenant connections, pending initial reads, frame/write buffers, SQL setup deadlines and session lifetime. Publish heartbeat comments; close slow consumers and interrupted subscriptions so clients reconnect and reload a fresh snapshot. Clean up timers, listeners and subscribers on disconnect/shutdown. Never accept bearer tokens in URL parameters or expose raw Redis/SQL errors to the browser. Metrics history must be bounded and uses UTC timestamps and fractional RPS.
