# Configuration

All credentials are read from environment variables or a protected env file
created by `scripts/configure.mjs`. The source tree, examples, and tests
contain no usable credential literals. `data/cv-auto/config/runtime.env` is
written 0600, created exclusively (never overwriting an existing file), and
injected into the containers via compose `env_file` (raw format).

| Variable | Required | Used for |
|---|---|---|
| `CV_WHATSAPP_TOKEN` | yes | WhatsApp Cloud API bearer |
| `CV_WHATSAPP_PHONE_ID` | yes | Sender phone number id |
| `CV_WHATSAPP_WABA_ID` | yes | Business account id |
| `CV_WHATSAPP_VERIFY_TOKEN` | yes | Webhook handshake challenge |
| `CV_WHATSAPP_APP_SECRET` | yes | HMAC-SHA256 webhook verification |
| `CV_WHATSAPP_API_VERSION` | no | API version (default `v21.0`) |
| `CV_OPENROUTER_KEY` | yes | OpenRouter API key |
| `CV_OPENROUTER_MODEL` | no | Model id (default `google/gemini-3.8-flash`) |
| `CV_SHEET_ID` | yes | Google Sheet to upsert into |
| `CV_SHEETS_SERVICE_ACCOUNT_EMAIL` | yes | Service account email |
| `CV_SHEETS_PRIVATE_KEY` | yes | Service account key; literal `\n` sequences, converted on load |
| `CV_ONEDRIVE_CLIENT_ID` | yes | Microsoft Graph app (public client) id |
| `CV_ONEDRIVE_TENANT` | no | Default `consumers` (personal OneDrive) |
| `CV_ONEDRIVE_FOLDER` | no | Root folder (default `CV Applications`) |
| `CV_ADMIN_NUMBER` | yes | Admin WhatsApp number for notifications |
| `CV_ADMIN_TOKEN` | auto | Private admin bearer; generated (32 random bytes, base64url) when absent; must be ≥ 24 chars with ≥ 8 distinct characters |
| `CV_ADMIN_PORT` | no | Private admin port (default 3001) |
| `CV_ADMIN_HOST` | no | Loopback by default; containers set `0.0.0.0` inside their namespace — host publishing stays 127.0.0.1 |
| `CV_API_HOST` | no | API bind host; containers set `0.0.0.0`, host port mapping stays 127.0.0.1 |
| `CV_API_PORT` | no | Webhook API port (default 3000) |
| `CV_DEVICE_NAME` | no | Device name in notifications (default `CV-AUTO-01`) |
| `CV_DASHBOARD_URL` | no | URL advertised in admin notifications |
| `CV_REDIS_URL` | no | Queue backend (default `redis://127.0.0.1:6379`) |
| `CV_CONFIG_DIR` / `CV_DATA_DIR` / `CV_LOG_DIR` | container | Mount layout (`/data/config`, `/data/data`, `/data/logs`) |
| `CV_SESSION_TIMEOUT_MINUTES` | no | Candidate session expiry (default 30) |

## Rules

- The admin token never appears in query strings, dashboards, notifications,
  or logs. The private admin runtime **fails closed** without a valid token.
- The AI never selects model availability, phone numbers, or duplicate
  verdicts: the backend validates the model against the provider and the
  database is the source of truth.
- The original CV bytes are preserved; extraction never mutates them.
- WhatsApp and CV phone numbers stay separate fields even when identical.
