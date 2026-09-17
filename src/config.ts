import fs from 'node:fs';
import path from 'node:path';
import {
  AppConfig,
  ExtractableField,
  OneDriveConfig,
  OpenRouterConfig,
  SheetsConfig,
  WhatsAppConfig,
} from './contracts.js';

const DEFAULT_MODEL = 'google/gemini-3.8-flash';

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function readConfigJson(configDir: string): Record<string, unknown> {
  const p = path.join(configDir, 'config.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Loads configuration from config.json in the config dir with env-var overrides.
 * Env override naming: CV_WHATSAPP_TOKEN, CV_WHATSAPP_PHONE_ID, CV_WHATSAPP_WABA_ID,
 * CV_WHATSAPP_VERIFY_TOKEN, CV_WHATSAPP_APP_SECRET, CV_OPENROUTER_KEY, CV_OPENROUTER_MODEL,
 * CV_SHEET_ID, CV_ONEDRIVE_CLIENT_ID, CV_ONEDRIVE_FOLDER, CV_ADMIN_NUMBER, CV_REDIS_URL,
 * CV_API_PORT, CV_DEVICE_NAME.
 * Never logs secret values.
 */
export function loadConfig(explicitDir?: string): AppConfig {
  const configDir = explicitDir ?? env('CV_CONFIG_DIR') ?? './data/cv-auto';
  fs.mkdirSync(configDir, { recursive: true });
  const dataDir = path.join(configDir, '..', 'cv-auto-data');
  const cfg = readConfigJson(configDir);

  const get = <T>(key: string, fallback: T): T => {
    const v = cfg[key];
    return v === undefined || v === null ? fallback : (v as T);
  };

  const waRaw = get<Record<string, unknown> | null>('whatsapp', null);
  const odRaw = get<Record<string, unknown> | null>('onedrive', null);
  const shRaw = get<Record<string, unknown> | null>('sheets', null);
  const orRaw = get<Record<string, unknown> | null>('openrouter', null);

  const whatsapp: WhatsAppConfig | null = waRaw
    ? {
        accessToken:
          env('CV_WHATSAPP_TOKEN') ?? String(waRaw.accessToken ?? ''),
        phoneNumberId:
          env('CV_WHATSAPP_PHONE_ID') ?? String(waRaw.phoneNumberId ?? ''),
        wabaId: env('CV_WHATSAPP_WABA_ID') ?? String(waRaw.wabaId ?? ''),
        verifyToken:
          env('CV_WHATSAPP_VERIFY_TOKEN') ?? String(waRaw.verifyToken ?? ''),
        appSecret:
          env('CV_WHATSAPP_APP_SECRET') ??
          (waRaw.appSecret ? String(waRaw.appSecret) : undefined),
        apiVersion:
          env('CV_WHATSAPP_API_VERSION') ??
          (waRaw.apiVersion ? String(waRaw.apiVersion) : 'v21.0'),
      }
    : env('CV_WHATSAPP_TOKEN')
      ? {
          accessToken: env('CV_WHATSAPP_TOKEN')!,
          phoneNumberId: env('CV_WHATSAPP_PHONE_ID') ?? '',
          wabaId: env('CV_WHATSAPP_WABA_ID') ?? '',
          verifyToken: env('CV_WHATSAPP_VERIFY_TOKEN') ?? '',
          appSecret: env('CV_WHATSAPP_APP_SECRET'),
          apiVersion: env('CV_WHATSAPP_API_VERSION') ?? 'v21.0',
        }
      : null;

  const onedrive: OneDriveConfig | null = odRaw
    ? {
        clientId:
          env('CV_ONEDRIVE_CLIENT_ID') ?? String(odRaw.clientId ?? ''),
        tenantId: env('CV_ONEDRIVE_TENANT') ?? String(odRaw.tenantId ?? 'consumers'),
        folderRoot:
          env('CV_ONEDRIVE_FOLDER') ?? String(odRaw.folderRoot ?? 'CV Applications'),
        tokenCachePath: path.join(configDir, 'onedrive-token-cache.json'),
      }
    : env('CV_ONEDRIVE_CLIENT_ID')
      ? {
          clientId: env('CV_ONEDRIVE_CLIENT_ID')!,
          tenantId: env('CV_ONEDRIVE_TENANT') ?? 'consumers',
          folderRoot: env('CV_ONEDRIVE_FOLDER') ?? 'CV Applications',
          tokenCachePath: path.join(configDir, 'onedrive-token-cache.json'),
        }
      : null;

  const sheets: SheetsConfig | null = shRaw
    ? {
        serviceAccountEmail: String(shRaw.serviceAccountEmail ?? ''),
        privateKey: String(shRaw.privateKey ?? '').replace(/\\n/g, '\n'),
        sheetId: env('CV_SHEET_ID') ?? String(shRaw.sheetId ?? ''),
        sheetName: shRaw.sheetName ? String(shRaw.sheetName) : 'Applications',
      }
    : env('CV_SHEET_ID') && env('CV_SHEETS_SERVICE_ACCOUNT_EMAIL') && env('CV_SHEETS_PRIVATE_KEY')
      ? {
          serviceAccountEmail: env('CV_SHEETS_SERVICE_ACCOUNT_EMAIL')!,
          privateKey: env('CV_SHEETS_PRIVATE_KEY')!.replace(/\\n/g, '\n'),
          sheetId: env('CV_SHEET_ID')!,
          sheetName: 'Applications',
        }
      : null;

  const openrouter: OpenRouterConfig | null =
    oraw_or_null(orRaw, env('CV_OPENROUTER_KEY'), env('CV_OPENROUTER_MODEL'));

  const mandatoryFields = get<ExtractableField[]>(
    'mandatoryFields',
    ['name', 'cv_phone_number'],
  );

  return {
    deviceName: env('CV_DEVICE_NAME') ?? get('deviceName', 'CV-AUTO-01'),
    dataDir: env('CV_DATA_DIR') ?? path.join(configDir, '..', 'cv-auto-data'),
    configDir,
    logDir: env('CV_LOG_DIR') ?? path.join(configDir, '..', 'cv-auto-logs'),
    sessionTimeoutMinutes: Number(
      env('CV_SESSION_TIMEOUT_MINUTES') ?? get('sessionTimeoutMinutes', 30),
    ),
    redisUrl: env('CV_REDIS_URL') ?? get('redisUrl', 'redis://127.0.0.1:6379'),
    apiPort: Number(env('CV_API_PORT') ?? get('apiPort', 3000)),
    adminWhatsappNumber:
      env('CV_ADMIN_NUMBER') ??
      (cfg.adminWhatsappNumber ? String(cfg.adminWhatsappNumber) : null),
    dashboardUrl:
      env('CV_DASHBOARD_URL') ??
      (cfg.dashboardUrl ? String(cfg.dashboardUrl) : null),
    mandatoryFields,
    whatsapp,
    onedrive,
    sheets,
    openrouter,
  };
}

function oraw_or_null(
  raw: Record<string, unknown> | null,
  envKey: string | undefined,
  envModel: string | undefined,
): OpenRouterConfig | null {
  if (envKey) {
    return {
      apiKey: envKey,
      model: envModel ?? (raw ? String(raw.model ?? DEFAULT_MODEL) : DEFAULT_MODEL),
      baseUrl: raw?.baseUrl ? String(raw.baseUrl) : 'https://openrouter.ai/api/v1',
    };
  }
  if (raw && raw.apiKey) {
    return {
      apiKey: String(raw.apiKey),
      model: String(raw.model ?? DEFAULT_MODEL),
      baseUrl: raw.baseUrl ? String(raw.baseUrl) : 'https://openrouter.ai/api/v1',
    };
  }
  return null;
}

/** Persists non-secret top-level fields plus integration blocks. Caller must chmod 0600 the file. */
export function saveConfig(configDir: string, config: Record<string, unknown>): void {
  fs.mkdirSync(configDir, { recursive: true });
  const p = path.join(configDir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(config, null, 2), { mode: 0o600 });
}
