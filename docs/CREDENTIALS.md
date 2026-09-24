# 🔑 Where to get each credential

The launcher asks for these one at a time and shows this same guidance at the
prompt. Values are saved only in `data/cv-auto/config/runtime.env` (chmod 0600).

| # | Value | Where to find it |
|---|-------|------------------|
| 1 | **WhatsApp permanent access token** | [Meta Business Suite](https://business.facebook.com) → WhatsApp Manager → API Setup → **Permanent token** (or create one from a System User). Never the short-lived 24-hour token. |
| 2 | **WhatsApp Phone Number ID** | WhatsApp Manager → **Phone numbers** → your number → Settings → Phone number ID. This is a long numeric **ID**, not a phone number. |
| 3 | **WhatsApp Business Account ID** | WhatsApp Manager → **Account overview** → Business Account ID. |
| 4 | **Webhook verify token** | You invent it — any random string (e.g. `openssl rand -hex 24`). You type the same value into Meta when registering the webhook callback. |
| 5 | **WhatsApp App Secret** | Meta Business Suite → **App settings** → Basic → App secret → Show → Copy. Used to verify webhook signatures. |
| 6 | **OpenRouter API key** | [openrouter.ai](https://openrouter.ai) → Account → **API Keys** → Create new key → `sk-or-…`. |
| 7 | **Google Sheet ID** | Open your sheet in a browser: `docs.google.com/spreadsheets/d/**SHEET_ID**/edit` — the long string between `/d/` and `/edit`. |
| 8 | **Sheets service account email** | [Google Cloud Console](https://console.cloud.google.com) → IAM & Admin → **Service Accounts**. Create one, then share the sheet with this email (Editor). |
| 9 | **Service account private key** | The JSON file downloaded when creating the service account. The launcher accepts the file path directly — preferred over pasting. |
| 10 | **OneDrive application client ID** | [Microsoft Entra admin center](https://entra.microsoft.com) → **App registrations** → New registration → copy **Application (client) ID**. Use a personal Microsoft account for personal OneDrive. |
| 11 | **Notices WhatsApp number** | Your own WhatsApp number in international format — digits with an optional `+` (e.g. `94771234567`). Every system notice (the SSH connection string, failures, reviews) goes here. |

## After you enter them

Webhook registration (in Meta) must point at your public HTTPS endpoint:

```
GET  https://<your-domain>/webhook    (verify token = value #4)
POST https://<your-domain>/webhook    (subscribe to messages)
```

The appliance only accepts signed webhooks, so the App Secret (#5) must match
the one configured in Meta.

## Quick checklist before the appliance goes live

- [ ] Sheet shared with the service account email (#8) as **Editor**
- [ ] OneDrive app registration created (#10) and device login completed
- [ ] OpenRouter key has credit and the model `google/gemini-3.8-flash` is available
- [ ] A reverse proxy (Caddy/Nginx) terminates HTTPS in front of `127.0.0.1:3000`
- [ ] `node scripts/verify-integrations.mjs check --allow-live` passes
