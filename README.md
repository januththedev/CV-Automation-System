# 📟 CV Automation System

> Turn WhatsApp CV submissions into validated Google Sheet rows — fully on your
> own machine. Candidates message you on WhatsApp, and the appliance extracts,
> validates, stores, and registers every CV while you stay in control.

```
 Candidate sends CV on WhatsApp
        │
        ▼
 WhatsApp Business Cloud API ──▶ signed webhook (HMAC-SHA256, verified before parsing)
        │
        ▼
 Local session service ◀──┐  greets, asks only for what is missing
        │                 └── (original CV bytes always preserved)
        ▼
 AI extraction (OpenRouter) ──▶ backend validation ──▶ conservative duplicate check
        │                        (AI never decides)     (valid NIC / file hash only)
        ▼
 OneDrive upload ──▶ shareable link ──▶ Google Sheets row ──▶ WhatsApp confirmation
```

Everything runs on **your** Linux appliance. SQLite is the source of truth,
Redis/BullMQ make processing durable, and the dashboard stays on your loopback
interface — reachable only through **your SSH connection**. At setup the
system **asks for one WhatsApp number**: the SSH connection string and every
other system notice (failures, reviews, model changes) are sent there, and
that number is **saved in the appliance database** so all notices keep
following it.

---

## ✨ What you get

| | |
|---|---|
| 🔐 **Private by design** | API, dashboard and admin panel bind to 127.0.0.1 only |
| 📄 **Original CV preserved** | uploaded bytes never modified, never re-parsed for storage |
| 🤖 **AI is not the controller** | the model extracts; the backend validates and decides |
| 🔁 **Durable** | nothing is lost on reboot or queue failure — recovery never duplicates |
| 📊 **Read-only dashboard** | applications, statuses, stats — no secrets, no write verbs |
| 💬 **Notices on WhatsApp** | SSH string + "CV AUTOMATION ONLINE" and all telemetry to the number you chose |

---

## 🚀 Step-by-step guide — from clone to a running system

### Step 1 — Prepare the appliance

A headless Kali (or Debian/Ubuntu) machine with:

- **Docker** + the compose plugin
- **Node.js 20+** (host-side, for the setup scripts)
- your **existing SSH access** — setup never touches SSH configuration

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 nodejs npm
sudo systemctl enable --now docker
```

### Step 2 — Clone this repository

```bash
git clone https://github.com/januththedev/CV-Automation-System.git /opt/cv-auto
cd /opt/cv-auto
```

### Step 3 — Provide provider credentials (environment variables only)

Credentials are **never** written into source files. Export them for the setup
session (or use a secrets manager); `setup.sh` writes a protected
`data/cv-auto/config/runtime.env` (0600) from these values:

```bash
export CV_WHATSAPP_TOKEN="<your WhatsApp permanent token>"
export CV_WHATSAPP_PHONE_ID="<phone number id>"
export CV_WHATSAPP_WABA_ID="<business account id>"
export CV_WHATSAPP_VERIFY_TOKEN="<any random string you choose>"
export CV_WHATSAPP_APP_SECRET="<app secret for webhook signatures>"
export CV_OPENROUTER_KEY="<your OpenRouter key>"
export CV_SHEET_ID="<google sheet id>"
export CV_SHEETS_SERVICE_ACCOUNT_EMAIL="<service account email>"
export CV_SHEETS_PRIVATE_KEY="<service account key, literal \n sequences>"
export CV_ONEDRIVE_CLIENT_ID="<microsoft app client id>"
```

You may also export `CV_ADMIN_NUMBER` here. If you don't, **the setup asks you
for it in the next step** — that is the number the system sends every notice
to.

### Step 4 — Build, start, and choose the notice number

```bash
bash setup.sh --start
```

If you did not export `CV_ADMIN_NUMBER`, setup prompts:

```
WhatsApp number that receives system notices (telemetry), e.g. 9477XXXXXXX:
```

Enter any WhatsApp number you own. It is validated, saved in the appliance
**database** (`settings.notification_number`), and from then on **all** system
notices — the "online" message with the SSH connection string, application
failures, reviews, and model changes — are sent to that number. Nothing is
sent anywhere else, and your secrets never appear on screen or in messages.

Setup then builds the images, starts the stack, and prints the **display
banner**:

```
================================================================
    CV AUTOMATION IS ONLINE
----------------------------------------------------------------
    Device:    CV-AUTO-01
    Notices:   9477XXXXXXX
    SSH:       ssh kali@192.168.1.25
    Tunnel:    ssh -L 3001:127.0.0.1:3001 kali@192.168.1.25
               then open http://127.0.0.1:3001/admin/dashboard
    Display:   dashboard kiosk on the appliance screen (when enabled)
    Status:    docker compose ps
    Logs:      docker compose logs -f
    Key:       SHA256:...your SSH host key fingerprint...

    An "online" message with these connection details was sent to
    the notification number shown above.
================================================================
```

### Step 5 — The notice arrives on the chosen number 💬

At the same moment, the appliance sends this message to the number you
entered:

```
CV AUTOMATION ONLINE
Device: CV-AUTO-01
IP: 192.168.1.25
SSH: ssh kali@192.168.1.25
Tunnel: ssh -L 3001:127.0.0.1:3001 kali@192.168.1.25
Dashboard: http://127.0.0.1:3001/admin/dashboard
SSH Fingerprint: SHA256:...
Status: ONLINE
```

Only the public fingerprint of your SSH **host key** is sent — never key
material, never credentials, never secrets. Every field is strictly validated
and credential-shaped content is redacted before it can leave the device.

### Step 6 — Open the dashboard through your SSH connection

The dashboard exists only on the appliance's loopback interface, so connect
with SSH and port-forward it:

```bash
ssh -L 3001:127.0.0.1:3001 kali@192.168.1.25
# now open in your browser:
#   http://127.0.0.1:3001/admin/dashboard
```

Enter the admin token (stored in `data/cv-auto/config/runtime.env` as
`CV_ADMIN_TOKEN`) in the page. It stays in memory only — never in the URL,
never in localStorage, never in logs.

### Step 7 — Optional: dashboard on the appliance display

For a screen attached to the appliance, the optional kiosk unit shows the
dashboard in Chromium on the existing graphical session:

```bash
sudo cp systemd/cv-auto-kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cv-auto-kiosk
```

No display? No problem — the unit simply does nothing harmful and the
appliance keeps running headless.

### Step 8 — Start on boot (optional)

```bash
sudo cp systemd/cv-auto.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cv-auto
```

### Step 9 — Daily use

```bash
cv-auto status      # database ready, applications, pending work
cv-auto diagnose    # provider configured/unconfigured indicators
docker compose ps   # services up?
docker compose logs -f worker
```

Want to test the live providers before accepting real CVs? That check can send
a message and create a OneDrive folder, so it is opt-in only:

```bash
node scripts/verify-integrations.mjs check --allow-live
```

---

## 🧪 Verified environments

| Environment | Result |
|---|---|
| Windows 10 dev host | typecheck + tests + build — full suite green (1 Redis-gated skip) |
| Debian 12 container | **full suite 0 skipped** with live Redis |
| Alpine (musl) container | **full suite 0 skipped** with live Redis |
| **Headless Kali rolling (native, no Docker inside)** | redis + api + worker + admin as real processes: health, handshake, signed webhook accepted, tampered 403, admin auth, dashboard, CLI status, notification attempt (delivery needs real credentials) |
| Production images (api, worker) | compose smoke over real HTTP: health, handshake, signed/replay/tampered/unsigned webhook, admin auth, dashboard, CLI, worker, notification-number persistence |

**Honest limits:** live delivery to WhatsApp/Google Sheets/OneDrive/OpenRouter
was never exercised because no real accounts were used — every test above uses
synthetic credentials that cannot reach those providers. Bare-metal Kali
deployment, a physical kiosk display, and a public HTTPS reverse proxy remain
for your deployment.

---

## 🛡 Security invariants

- The AI is **not** the system controller; the backend owns every decision.
- WhatsApp number and CV phone number stay separate fields even when identical.
- The original CV is preserved; nothing rewrites it.
- Duplicates merge only on valid NIC or file hash — never name/phone similarity.
- Recovery never creates duplicate files or sheet rows.
- No credential literal exists in source, examples, or tests.
- Setup never breaks SSH, never locks out the administrator.

## 📚 Further reading

- [docs/DEPLOY.md](docs/DEPLOY.md) — services, systemd, updates, full matrix
- [docs/CONFIG.md](docs/CONFIG.md) — every environment variable and its rules
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — flow, invariants, limits
