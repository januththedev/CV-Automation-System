# Webhook API

This public-boundary server exposes only `GET /webhook`, `POST /webhook`, and `GET /health`. There are no management, candidate-data, model-change, or dashboard routes on this listener.

## Receipt boundary

- `GET /webhook` requires `hub.mode=subscribe`, the configured verify token, and a nonempty challenge. It returns the challenge as plain text. Incorrect requests get 403; unconfigured verification gets 503.
- `POST /webhook` accepts JSON content as raw bytes, capped at 1 MiB. The `x-hub-signature-256` header is checked using HMAC-SHA256 and constant-time digest comparison before JSON parsing or persistence. Missing app-secret configuration fails closed.
- A valid batch is recorded in one SQLite transaction, including sessions, application revisions, messages, and the durable `pending_work` outbox. Any database failure rolls back the batch and returns a generic 500. Duplicate message IDs are no-ops. Status-only notifications create no jobs.
- HTTP success means the receipt is committed locally, not that the document pipeline or provider operations have completed. The worker dispatcher publishes the outbox independently; the webhook does not wait for Redis or call the AI.
- Fastify request logging is disabled. Error responses and application error logs omit request URLs, bodies, tokens, and raw exception details. Configure any reverse proxy to avoid logging webhook verification query tokens as well.

`GET /health` executes SQLite `SELECT 1` and returns `{ "sqlite": "ok" }`, or a generic 503. It does **not** certify Redis, workers, provider credentials, or full appliance readiness.

## Runtime

Build with `npm run build`; the process entry point is `node dist/api/index.js`. Configuration is loaded through `src/config.ts`. SQLite is pinned to `<dataDir>/applications.db` (no independent `SQLITE_PATH` override). The default bind address is `127.0.0.1` and the configured API port defaults to 3000. `CV_API_HOST` can explicitly select another interface, for example inside a container; do not expose private management services alongside this public boundary.

`startApiRuntime({ config?, configDir?, registerSignals? })` returns `{ server, stop }`. Shutdown is idempotent, removes its signal handlers, closes the HTTP server, then closes SQLite. Startup failure cleans up the resources it opened. Importing the modules does not start services or load configuration.

For embedded use, `createApiServer(config, connection)` accepts the shared connection opened by `src/database/db.ts:getDb`; the factory never closes that caller-owned connection. Use one runtime owner per process.

## Verification and limits

`tests/api.test.ts` uses local Fastify injection and temporary SQLite files to cover authentication boundaries, body limits, rollback/retry, duplicate receipts, health, import safety, and lifecycle. Lifecycle tests briefly bind an ephemeral loopback port. Provider delivery is not tested live. No Linux deployment, public TLS proxy, live Meta registration, or live Redis readiness is claimed by this test suite.
