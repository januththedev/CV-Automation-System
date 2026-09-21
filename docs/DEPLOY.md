# Deployment

## Host requirements

- Debian-family Linux (Kali, Debian 12, Ubuntu) or any host running Docker
- Node.js 20+ (only for `setup.sh`/configure on the host; the runtime uses the
  containers' Node 20)
- Docker with the compose plugin

`setup.sh` refuses cleanly without these: it exits with a clear message on
missing/old Node or an unreachable Docker daemon, before touching anything.

## Install

```bash
bash setup.sh          # build images; writes protected runtime.env; starts nothing
bash setup.sh --start  # also starts the compose stack
```

Configuration comes exclusively from environment variables — see
[docs/CONFIG.md](CONFIG.md). `setup.sh` invokes `scripts/configure.mjs`, which:

- writes `data/cv-auto/config/runtime.env` with mode 0600;
- creates it with exclusive flags: an existing runtime.env is **never**
  overwritten — edit it explicitly instead of rerunning setup;
- generates a random base64url `CV_ADMIN_TOKEN` if none was provided;
- rejects weak tokens (fewer than 8 distinct characters, shorter than 24);
- fails closed, naming every missing required variable.

The compose stack (`docker-compose.yml`) reads that file into the api, worker,
and admin containers (`required: false` — without it the admin service fails
closed and the API runs with defaults). Everything is published on
127.0.0.1 only.

## Services

- `api` — public webhook + health on 3000; healthcheck wired into compose.
- `worker` — BullMQ worker consuming the durable outbox.
- `admin` — read-only management API + dashboard on 3001 (loopback).
- `redis` — durable queue backend (AOF on).

State lives in `./data/cv-auto` (SQLite, Redis AOF, config). Back it up; it is
the appliance.

## Start on boot (systemd)

```bash
sudo cp systemd/cv-auto.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cv-auto
```

The unit is `docker compose up -d` / `down` only — it never writes config,
never touches SSH, and updates never erase `data/cv-auto`.

Optional kiosk (only on a host with a graphical session and a `kiosk` user):

```bash
sudo cp systemd/cv-auto-kiosk.service /etc/systemd/system/
sudo systemctl enable --now cv-auto-kiosk
```

The kiosk unit is optional: without a display it fails harmlessly and the
appliance keeps running. Both unit files were validated with
`systemd-analyze verify` (exit 0) on Kali rolling with stub binaries.

## CLI

```bash
bash scripts/install-cli.sh            # installs a /usr/local/bin/cv-auto launcher
CV_INSTALL_PREFIX=$PWD/prefix bash scripts/install-cli.sh  # alternate prefix
cv-auto status                         # database ready, application count, pending work
cv-auto diagnose
```

## Live provider verification (optional, operator-initiated)

```bash
node scripts/verify-integrations.mjs check --allow-live [--only whatsapp|sheets|openrouter|onedrive]
```

Runs without `--allow-live` the tool refuses to run: a live check can send an
admin WhatsApp message, create a OneDrive folder, and incur model charges.
OneDrive prints a device-login code to the local console only.

## Updates

```bash
git pull && docker compose build && docker compose up -d
```

Never delete `data/cv-auto`. All candidate records, configuration, and tokens
live there; updating images does not touch them.

## Environment verification matrix (2026-09-21)

| Environment | What ran | Result |
|---|---|---|
| Windows 10 dev host (Node 24) | `npm run typecheck`, `npm test`, `npm run build` | 235 passed / 1 skipped (Redis-gated), green |
| Debian 12 container (`node:20-bookworm-slim`, cv-auto:test) | typecheck + full suite + build, with live redis:7-alpine | **236 passed / 0 skipped** |
| Alpine (musl) container (`node:20-alpine`, cv-auto:alpine-test) | typecheck + full suite + build, with live redis:7-alpine | **236 passed / 0 skipped** |
| Kali rolling container (Node 24.19, npm 11) | typecheck + full suite + build; Redis roundtrip; `systemd-analyze verify`; configure contract (negative/positive/overwrite-refusal) | 235 passed / 1 skipped (Redis-gated); gated test passed separately against live redis:7-alpine; units exit 0; configure contract all correct |
| Production images (cv-auto:api, cv-auto:worker, Debian 12 base) | compose stack with synthetic credentials: health, handshake, signed webhook, replay dedup, tamper 403, unsigned 403, admin bearer/query-token/write-verb, dashboard shell, CLI status, worker startup | All checks passed |
| **Headless Kali rolling (native processes, no Docker inside)** | redis-server + `dist/worker` + `dist/api` + `dist/api/admin-server.js` as real processes with synthetic credentials: health, handshake, signed webhook accepted, tampered 403, admin auth, dashboard 200, CLI status, "CV AUTOMATION ONLINE" notification attempted (generic scrubbed failure — synthetic token cannot reach WhatsApp) | All checks passed; delivery requires real credentials |

On startup (`bash setup.sh --start`), the appliance prints a display banner and
sends the WhatsApp "CV AUTOMATION ONLINE" message containing the SSH
connection, the loopback dashboard tunnel, and the host key fingerprint. Only
the public fingerprint leaves the device — never key material or credentials.

Environment bug found and fixed by this matrix: better-sqlite3 ≤ 11 crashed
with a native `RemoveEnvironmentCleanupHook` assertion on Node 24 (Kali's
stock Node) during database teardown; upgrading to better-sqlite3 12 fixed it
and the full suite went green on Node 24.

The Windows-skipped and Kali-skipped test is the same one: the real-Redis
queue roundtrip, which requires a live Redis and was run and passed inside the
Debian, Alpine, and Kali container runs.

Ubuntu 22.04 note: its stock `nodejs` package is Node 12, which cannot parse
the configure script — that path is covered by `setup.sh`'s version guard
(exit 1 with "Node.js 20 or later is required"), which is itself a test
(`tests/setup-scripts.test.ts`) and runs on every environment above.
