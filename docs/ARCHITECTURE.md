# Architecture

```
WhatsApp Business Cloud API (signed webhook)
        │  raw bytes, HMAC-SHA256 verified before parse, 1 MiB cap
        ▼
api (loopback-hosted public boundary) ── batch transaction ──▶ SQLite (WAL)
        │                                                      applications,
        │ ACK only after commit                                messages, sessions,
        ▼                                                      pending_work
worker (BullMQ over Redis AOF)
        │  revision-keyed jobs, ID-cursor keyset recovery
        ├─ session service (greeting / waiting for details)
        ├─ AI extraction (OpenRouter, structured schema, model runtime-validated)
        ├─ backend validation (mandatory fields; AI never decides numbers)
        ├─ conservative duplicate detection (valid NIC / file hash only)
        ├─ OneDrive upload (original CV preserved) → share link
        ├─ Google Sheets upsert (single row per application)
        └─ WhatsApp confirmation
        ▲
        └─ admin (read-only SQLite, loopback, bearer token) + dashboard (same-origin)
```

## Invariants

- **AI is not the controller.** The backend validates, decides, and persists;
  the model only extracts candidate-supplied text under a strict schema.
- **Number provenance.** The WhatsApp number and the CV phone number remain
  separate fields even when identical; the AI is never asked to reconcile them.
- **Original CV preserved.** Uploaded bytes are stored and uploaded verbatim;
  nothing rewrites the source document.
- **Duplicate conservatism.** Two rows merge only on valid NIC or file hash —
  never name/phone similarity.
- **Recovery never duplicates.** Outbound delivery failures keep business
  status and record a retryable error so recovery selection finds them after
  queue loss; completed/detail messages with outstanding revisions recover
  outbound work instead of looping.
- **Secrets stay secret.** Pino redaction, fixed-string log operations,
  sanitized admin projections, 0600 config, tokens never in URLs.
- **No lockout.** Setup never edits SSH/firewall config; a failed provider
  check never disables services; the kiosk is optional.

## Components

| Path | Role |
|---|---|
| `api/server.ts` | Public webhook boundary; raw-bytes HMAC, fail-closed, health (SQLite only) |
| `api/admin-server.ts` | Private read-only management API + dashboard assets (loopback, bearer) |
| `worker/` | BullMQ processors, pipeline, recovery, dispatcher lifecycle |
| `src/database/db.ts` | SQLite schema, application/session/message repos, outbox |
| `src/integrations/*` | WhatsApp, OneDrive, Google Sheets, OpenRouter clients |
| `cli/cv-auto.ts` | `status`, `diagnose`, `help` (read-only database access) |
| `scripts/configure.mjs` | Environment-only runtime.env writer (exclusive, 0600) |
| `scripts/verify-integrations.mjs` | Opt-in live provider checks (`--allow-live` required) |
| `systemd/` | Optional boot + kiosk units (compose up/down only) |
| `Dockerfile(.alpine)` | Production images + in-container test gates |

## Verification limits (honest)

- **Verified:** full unit/integration suite (292 tests: 291 passed / 1
  Redis-gated skip on the dev host; **292/292** inside both the Debian 12 and
  Alpine Linux containers with a live Redis); production-image smoke over real
  HTTP (handshake, signed/tampered/unsigned/replay webhook, admin auth,
  dashboard, CLI, worker); systemd units validated; configure contract on Kali;
  Node-24 crash fixed. Suite size is re-measured on every full gate; the
  authoritative count lives in [REQUIREMENTS-CHECKLIST.md](REQUIREMENTS-CHECKLIST.md).
- **Not verified:** live delivery to WhatsApp/Google Sheets/OneDrive/OpenRouter
  with real credentials (no real account was used — synthetic credentials can
  never reach the providers); a real Kali bare-metal deployment; kiosk on a
  physical display; the optional reverse proxy for public HTTPS.
