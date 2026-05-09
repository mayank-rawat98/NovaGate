# Control Plane — apps/control-plane

WebSocket server. Manages Map<tenantId, WebSocket> of live connections.
Receives logs/health/errors from gateways. Pushes config updates down.

## On new connection
1. Expect auth message within 5s or close(4002)
2. Hash key SHA-256, look up in public.api_keys
3. Not found → close(4001). Found → send auth_ok with full config
4. Check pending_config_updates, deliver if exists, delete row
5. Register in connections map

## Config push rule
After EVERY Admin API DB write:
- online: send config.update over WSS
- offline: upsert into pending_config_updates

## Close codes (in libs/shared-types/src/ws-close-codes.ts)
4001 invalid key  4002 auth timeout  4003 key rotated  4004 suspended

## Guardrails
- NEVER retry on behalf of the gateway — reconnect is gateway's job
- NEVER hardcode close codes — import from shared-types
- NEVER skip pending_config_updates check on reconnect
- ping all connections every 30s, close non-ponging after 60s