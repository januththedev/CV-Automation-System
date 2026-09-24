# ✅ Requirements checklist — what you asked, and where it lives

Every requirement from our conversation, with its current status and the
concrete evidence behind it. **MET** = built and verified · **PARTIAL** = built,
one edge unproven or environment-limited · **UNVERIFIED** = needs real
credentials or hardware only you have · **DEFERRED** = deliberately not built.

Suite size at the time of writing: **292 tests — 291 passed / 1 Redis-gated skip
on the dev host; 292/292 inside both Linux containers with live Redis.**

---

## A. The core appliance (your original brief)

| # | Requirement (your words) | Status | Evidence |
|---|---|---|---|
| A1 | "WhatsApp message/CV → local session → original CV preserved → AI extraction → backend validation → conservative duplicate detection → OneDrive → Sheets → confirmation" | **MET** | `worker/pipeline/cv-processing.ts`, `onedrive.ts`, `sheets.ts`; full chain to `COMPLETED` in `worker/pipeline/__tests__/pipeline.test.ts` (26 tests) |
| A2 | "The AI must NOT determine this number" | **MET** | Model schema has no `whatsapp_number` field — rejected if returned: `src/integrations/openrouter/__tests__/extract.test.ts`; backend recomputes facts `extract.ts:69-96` |
| A3 | "These fields must remain separate even if they contain exactly the same number" | **MET** | New test: equal WhatsApp + CV phone stored in separate columns, never a dedupe signal — `src/database/__tests__/db.test.ts` ("keeps the WhatsApp number and the CV phone number as separate fields even when identical") |
| A4 | "Never invent missing information" | **MET** | Ungrounded/invalid model fields nulled → `NEEDS_REVIEW`: `extract.test.ts`, `pipeline.test.ts:173-179` |
| A5 | "The original CV must be preserved" | **MET** | Exact-buffer assertions incl. replacement CVs: `pipeline.test.ts:129-137, 205-217`; re-hash before upload `onedrive.ts:10-19` |
| A6 | Conservative duplicates (valid NIC/hash only, never name/phone) | **MET** | New test: malformed NIC/hash never match — `db.test.ts` ("never treats malformed NIC or hash values as duplicate evidence"); match test `db.test.ts:155-167` |
| A7 | "Recovery must avoid duplicate files and sheet rows" | **MET** | Queue-loss recovery now asserts upload/link/row stay at 1: `pipeline.test.ts` ("recovers retryable %s delivery after queue loss"); full replay `pipeline.test.ts:181-189` |
| A8 | "Never hard-code credentials" / read only from env or secret service | **MET** | `src/config.ts` env-only; all test credentials runtime-assembled; Mimosa literal findings fixed (commit `f589405`) |
| A9 | "Never print secrets to ordinary logs" | **MET** | New test: a failing webhook logs only `{operation:'ingest'}` — never secret, signature, body — `tests/api.test.ts` ("logs only a fixed operation string on internal failure") |
| A10 | "Never send a private SSH key through WhatsApp" | **MET** | Only the host-key fingerprint is sent; new test asserts every `ssh_host_` line in setup/launcher is a read + `ssh-keygen` call: `tests/ops-scripts.test.ts` |
| A11 | "Do not break existing SSH configuration" / "Never lock the administrator out" | **MET** | New negative test: no setup/deploy/systemd/compose artifact contains `sshd_config`, `authorized_keys`, `iptables`, `nft`, `ufw`, `firewall-cmd` or SSH service mutations — `tests/ops-scripts.test.ts` |
| A12 | "Never erase configuration or candidate records during an update" | **MET** | Launcher backs up runtime.env before overwrite (`run-native.mjs`), `configure.mjs` refuses overwrite, data lives in `./data/cv-auto`; `deployment-config.test.ts` |
| A13 | "Treat CVs and WhatsApp messages as untrusted candidate content" | **MET** | Filename sanitisation + write containment: `worker/pipeline/types.ts:45-57`, `cv-processing.ts` resolve-guard; 12 traversal tests `path-containment.test.ts`; candidate URLs stored as text with fetch asserted absent `api.test.ts` |
| A14 | Webhook HMAC before parse, 1 MiB cap, fail-closed, generic errors | **MET** | `tests/api.test.ts` (33 tests) incl. exact-byte HMAC, 413 boundary, 503 without secret |
| A15 | "AI is not the system controller; backend remains in control" | **MET** | Duplicate verdict set by the backend even when the model says otherwise: `pipeline.test.ts:163-171` |

## B. Verification ("run test in docker", "various Linux environments")

| # | Requirement | Status | Evidence |
|---|---|---|---|
| B1 | Tests run in Docker | **MET** | `Dockerfile` `test` stage runs typecheck+tests+build in-image; Debian: **292/292** with live redis:7-alpine |
| B2 | Various Linux environments | **MET** | Debian 12 (glibc) 292/292 · Alpine musl 292/292 (`Dockerfile.alpine`) · headless Kali rolling native 292/292-equivalent suite + full launcher run |
| B3 | "Tell me once I ran real tests and all they passed" | **MET** | Windows 291/1 · Debian 292/292 · Alpine 292/292 — reported each run |
| B4 | Real provider delivery (WhatsApp/Sheets/OneDrive/OpenRouter) | **UNVERIFIED** | Needs your real accounts; every test uses synthetic credentials. `verify-integrations.mjs check --allow-live` is the opt-in path |

## C. Delivery & onboarding

| # | Requirement (your words) | Status | Evidence |
|---|---|---|---|
| C1 | "Push our changes there" — GitHub `januththedev/CV-Automation-System` | **MET** | Branches `main` (default) and `feat/appliance-api`; every change pushed |
| C2 | "Docker is not needed right if using Kali" | **MET** | Native path: `scripts/run-native.mjs` runs redis + api + worker + admin as plain processes (verified on headless Kali) |
| C3 | "One prompt that installs dependencies and asks for the values" | **MET** | `run-native.mjs`: npm ci → native-build approval → build → prompts → save → start |
| C4 | "I want to show what typed and after entering it should get hidden" | **MET** | Echo while typing; erase-line after Enter (`run-native.mjs` ask()); verified interactive behaviour via readline terminal mode |
| C5 | "It should always show what needed: where we typed" | **MET** | Every prompt prints a "where to find it" line; full guide `docs/CREDENTIALS.md`; asserted by `tests/ops-scripts.test.ts` |
| C6 | Review before saving (secrets masked) | **MET** | `=== REVIEW (secrets masked) ===`; answer `n` to re-enter; nothing written until confirmed |
| C7 | "The system will ask for a number … and that number will also be saved in the database" | **MET** | Notices number prompted (last field), saved via `settings.notification_number` (`db.ts` migration v2), authoritative in `notify.ts` (DB first), persisted by setup through `db-set-setting.mjs` (spawn-tested in `ops-scripts.test.ts`) |
| C8 | "All the things will be sent there" | **MET** | All admin notices (online w/ SSH+tunnel+fingerprint, failures, reviews, model changes) resolve the DB number first — `notify.test.ts` |
| C9 | Startup failure is visible | **MET** | Launcher polls `/health` + `/admin/dashboard`; on failure prints the last 20 log lines (verified in Kali run) |
| C10 | README "from cloning our repo to finishing and starting our system", beautiful | **MET** | `README.md` steps 1-9 incl. the one-command native flow, banner, WhatsApp notice, SSH tunnel, kiosk, limits |
| C11 | SSH connection string shown | **MET** | Console banner + WhatsApp message (`Tunnel: ssh -L 3001:127.0.0.1:3001 user@ip`), tunnel regex-validated `templates.ts` |

## D. Security requirements (this turn's hook + standing rules)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| D1 | "Only http/https; validate host; reject localhost, loopback, private and reserved addresses before requesting" | **MET** | `src/network/url-guard.ts` (IPv4/IPv6 loopback, RFC1918, CGNAT, link-local, multicast, site-local, documentation, v4-mapped) — **now wired into every live fetch**: WhatsApp `request()` (before the bearer token is attached), OneDrive upload-session URL, OpenRouter request. Tests: guard suite (35 cases) + per-client rejection tests (no fetch on blocked host) |
| D2 | Credentials only from env/secret service; no usable literals in source/tests | **MET** | env-only `config.ts`; runtime-assembled test dummies; Mimosa literal findings fixed |
| D3 | Private admin: loopback surface, bearer, no write verbs, sanitized output | **MET** | `admin-server.ts` + 20 tests; loopback-by-default and compose host-loopback asserted (`admin-server.test.ts`) |
| D4 | No secrets in dashboard/notifications/logs | **MET** | `templates.ts` regex validation + `notify.ts` scrub; dashboard token in memory only; A9 test |

## E. Operations

| # | Requirement | Status | Evidence |
|---|---|---|---|
| E1 | CLI diagnostics | **MET** | `cv-auto status/diagnose/help` — 8 tests `tests/cli.test.ts` |
| E2 | systemd boot + optional kiosk | **MET** | Units validated with `systemd-analyze verify` (exit 0); compose-only operations |
| E3 | Docker alternative | **MET** | `setup.sh --start` → compose (api/worker/admin/redis), health-gated admin start |
| E4 | Config file (0600) never silently overwritten | **MET** | `configure.mjs` exclusive-create; launcher backup; `deployment-config.test.ts` |

## F. Deliberately not built

| # | Item | Status | Note |
|---|---|---|---|
| F1 | Automatically calling applicants (Twilio/Telnyx/SignalWire, eSIM calling) | **DEFERRED** | You said "just forget that". Design discussed only: click-to-call (free, human-initiated) was recommended; Cloud API has no voice; eSIM cannot originate automated calls |
| F2 | Live delivery against real providers | **UNVERIFIED** | Requires your real credentials (`check --allow-live`) |
| F3 | Bare-metal Kali host + physical kiosk display | **UNVERIFIED** | Verified in a headless Kali container; physical display is untestable here |
| F4 | Public HTTPS reverse proxy in front of the webhook | **UNVERIFIED** | Deployment concern (Caddy/Nginx), documented, not built into the appliance |

---

## How the numbers were measured

- `npm run typecheck` + `npm test` + `npm run build` on the dev host.
- `docker build --target test` (Debian 12) and `docker build -f Dockerfile.alpine`
  (musl), each run with a live `redis:7-alpine` on a user-defined network so the
  previously skipped Redis roundtrip executes.
- Headless Kali rolling container: full launcher flow (install → prompts →
  save → start → banner → notice) and `--stop`, verified live.
