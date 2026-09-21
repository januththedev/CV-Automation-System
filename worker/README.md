# Worker runtime contract

`startWorkerRuntime()` defaults to the real four-queue pipeline in `worker/pipeline/index.ts`. Importing the runtime alone does not connect to SQLite or Redis, register signals, or start processing. Direct execution starts the same default pipeline.

## Processor wiring

The optional `processors` argument accepts a registry or a synchronous/asynchronous `(context) => registry` factory. `WorkerContext` contains the validated configuration, SQLite connection, and four BullMQ queues. Explicit overrides replace the default factory; missing processors throw `Error('not implemented')`. The reserved job name `noop` resolves without work.

## Queue API

`src/queue/queues.ts` exports `getQueues(redisUrl)`, `enqueueJob(name, data, opts?)`, `getQueueEvents(name)`, and `closeQueues()`. Initialize queues before publication. Connections are cached; close them before changing the Redis URL.

Defaults are five total attempts with a custom factor-four exponential backoff, starting at one second and capped at five minutes. Completed jobs retain up to 1000 entries; failures are retained. Workers install `workerBackoffStrategy` for the custom backoff type. TLS, URL credentials, and Redis database paths are supported. Worker/event connections use `maxRetriesPerRequest: null`; producer connections use 1.

Concurrency per process is `cv-processing: 1`, `onedrive: 3`, `google-sheets: 3`, and `whatsapp-confirm: 5`.

**Run only one worker process against this appliance's data and register.** Application and Sheets-writer locks are process-local, not distributed. Multiple processes are not supported for safe side-effect serialization.

## Boot and recovery

The runtime loads configuration unless supplied and pins SQLite to `<config.dataDir>/applications.db`; it does not honor a separate `SQLITE_PATH` override. It initializes Redis queues, creates stopped workers, and checks readiness with a 15-second deadline.

Before starting workers, it calls `reconcileApplications` from `src/services/dispatch.ts`. The periodic dispatcher uses that same function and selection:

- Document-bearing applications with `revision > processed_revision`, regardless of status.
- Applications waiting for details (delivery is suppressed by the revision journal once sent).
- Completed applications without a sent confirmation.
- Current received sessions with an unhandled text-only revision and an unsent greeting.

Recovery pages by an exclusive application-ID cursor in batches of 1000. Earlier applications leaving the selection during publication cannot shift later pages. Changes behind the cursor are revisited on the next pass. Each job uses `reconcile-<applicationId>-<revision>` and enters `cv-processing`. Processors reload authoritative SQLite state and resume from the revision journal and stored provider IDs rather than repeating completed stages. Existing live jobs remain untouched; retained completed/failed jobs are retried. A publication failure rejects startup and runs cleanup; periodic failures are logged without raw provider errors and retried on later passes.

The dispatcher also drains the durable `pending_work` outbox immediately and then every five seconds. It acknowledges each receipt only after queue publication succeeds. Recovery repeats every sixty seconds. Each loop waits for its own previous pass before scheduling another.

Original CV bytes are stored in content-addressed application subfolders. Revision journals live in `.pipeline/<revision>.json`. WhatsApp sender identity always comes from stored API metadata; CV phone fields remain separate. Completion/detail/greeting delivery checkpoints suppress known replayed sends. A provider send accepted immediately before a local checkpoint failure still has an unavoidable duplicate-delivery window; this is not an exactly-once messaging guarantee.

Retryable WhatsApp delivery failures retain the business status (`RECEIVED`, `WAITING_FOR_DETAILS`, or `COMPLETED`) and record `WHATSAPP_RETRY` separately so reconciliation can still reconstruct pending messages after queue loss. Exhausted delivery attempts remain `FAILED` with admin notification. Document-free completion/detail recovery also handles outstanding processed revisions without entering the greeting-only path. These changes do not migrate records already stranded as `RETRY_PENDING` by older builds.

## Shutdown

The runtime returns `{ context, workers, recovered, stop }`. `recovered` counts jobs newly published or retried during startup, not candidates fully processed. `stop()` is idempotent: it removes registered signal handlers, stops dispatcher timers and awaits active dispatcher passes, waits for workers to finish, closes queue/event connections, then closes SQLite. Startup failure uses the same cleanup. SIGINT/SIGTERM call `stop()` unless `registerSignals: false`. There is no forced process exit interrupting active work.

## Verification

Tests cover registry configuration, durable receipts, concurrent recovery pagination, startup/periodic recovery, shutdown, and checkpointed pipeline processing. Provider operations are mocked. The default-pipeline runtime test preloads dependencies under real timers before testing dispatcher timing.

`src/queue/__tests__/queues.test.ts` skips unless `REDIS_URL` is set. Use only a dedicated disposable Redis database with no other consumers. It removes its own job without flushing Redis. Normal runtime configuration uses `CV_REDIS_URL`; `REDIS_URL` is the test opt-in. Passing mocked tests does not verify live provider credentials, Redis recovery, or Linux deployment.
