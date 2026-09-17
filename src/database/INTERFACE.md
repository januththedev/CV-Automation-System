# Database interface

All exports are synchronous, from `src/database/db.ts`; import shared types from `src/contracts.ts`.

## Connection / applications

- `getDb(path?: string): Database.Database` — singleton connection; default `SQLITE_PATH` or `${DATA_DIR || './data/cv-auto'}/applications.db`. Explicitly changing an open path throws (call `closeDb()` first). Enables WAL, foreign keys, busy timeout and inline versioned migrations.
- `closeDb(): void`
- `nextApplicationId(): string` — transaction-safe reserved `APP-YYYY-000001` ID (six digits, gaps allowed).
- `DatabaseApplication extends Application` with nullable `media_id`, `cv_filename`, `cv_mime_type`, `extraction_json`, `session_id`, `duplicate_of`; integer `revision` and `processed_revision`.
- `createApplication(input: CreateApplicationInput): DatabaseApplication` — requires `whatsapp_jid` and `whatsapp_number`; accepts partial application fields, including an optional reserved `id`.
- `getApplicationById(id: string): DatabaseApplication | null`
- `updateApplication(id: string, patch: ApplicationPatch, expectedRevision?: number): DatabaseApplication | null` — patch cannot change id/revision/processed_revision/whatsapp_jid/whatsapp_number; optional optimistic revision check, null if missing/stale. Does not implicitly increment revision; inbound receipt owns revision increments.
- `listApplications(filter?: { status?: ApplicationStatus | ApplicationStatus[]; whatsapp_number?: string; review?: boolean; limit?: number; offset?: number }): DatabaseApplication[]` — newest first, default limit 100, max 1000.
- `getApplicationByWhatsAppNumber(number: string)`, `getApplicationByNic(nic: string)`, `getApplicationByCvHash(hash: string)` — most recent match or null; number is a lookup only, never identity proof.
- `findDuplicate(applicationId: string): DatabaseApplication | null` — returns another record for review only when a valid normalized NIC or SHA-256 CV hash matches; never mutates, merges or matches on name/phone alone.
- `listRecoveryApplications(limit?: number): DatabaseApplication[]` — document-bearing applications where processed_revision < revision, for recovery even if Redis loses already-dispatched jobs. Needs-review/failed/completed work must set processed_revision to the revision actually handled.

## Sessions / messages

- `Session`: `{ whatsapp_number: string; application_id: string; updated_at: string; greeting_sent: boolean }`.
- `getSession(whatsappNumber: string): Session | null`
- `upsertSession(input: Session): Session` — explicit full session write; use recordInbound for receipt.
- `markGreetingSent(whatsappNumber: string, applicationId: string): boolean` — conditional on the current session still belonging to that application.
- `StoredMessage extends InboundMessage`: adds `id: number`, `application_id: string`.
- `saveMessage(applicationId: string, msg: InboundMessage): boolean` — false on existing wa_message_id; low-level only, does not create pending work or change sessions.
- `getMessageByWaId(waMessageId: string): StoredMessage | null`
- `listApplicationMessages(applicationId: string): StoredMessage[]` — ordered by event timestamp then id.
- `listSessionMessages(whatsappNumber: string): StoredMessage[]` — current session's application only (not old applications from same number).

## Atomic inbound / durable outbox

- `recordInbound(msg: InboundMessage, timeoutMinutes: number): { application: DatabaseApplication; duplicate: boolean; hasDocument: boolean }`
  - One IMMEDIATE SQLite transaction reserves ID if necessary, writes application/session/message and pending work. A duplicate message ID returns its ORIGINAL application without changing any session, revision or work.
  - Valid timestamps: ISO-8601 strings, epoch seconds (WhatsApp Cloud API wire format) or epoch milliseconds; invalid/future event timestamps fall back to receipt time for session decisions. Backdated messages do not rewind a session or force timeout. A strictly forward gap greater than timeout creates a new application/session; equality stays in the session.
  - A document message sets document metadata (media_id, filename, MIME type). A replacement document clears old file/extraction/delivery checkpoints (`cv_local_path`, `cv_file_hash`, OneDrive ids/urls, `extraction_json`, `duplicate_of`, `confirmation_sent`) but retains `sheet_row_number` for upsert, and sets status `DOCUMENT_RECEIVED`. Text updates retain existing document/delivery checkpoints. Existing application status is otherwise left for the worker to evaluate.
  - `hasDocument` means the returned application has media_id or cv_local_path, not necessarily that this message is a document. No MIME support policy is imposed by the DB.
- `PendingWork`: `{ id: number; application_id: string; wa_message_id: string; revision: number; created_at: string; dispatched_at: string | null }`.
- `listPendingWork(limit?: number): PendingWork[]` — oldest undispatched rows, default 100, max 1000.
- `markWorkDispatched(id: number): boolean` — call ONLY after successful durable enqueue; returns true for first acknowledgement. Never acknowledge before queue publication.
- `getPendingWorkByMessageId(waMessageId: string): PendingWork | null`

One pending row is recorded per new inbound message, including text-only messages, so greeting/session handling is recoverable too. The consumer chooses the queue/action from application state (`hasDocument` => CV pipeline, otherwise greeting/details). For deduplicated queue publication use an idempotent job ID such as `inbound-${work.id}` and include applicationId + revision. Publication is at-least-once, not exactly-once; do not delete durable work on queue failure. Periodically reconcile `listRecoveryApplications()` after queue data loss. Worker completion should persist the revision it actually processed, not an unobserved later revision.
