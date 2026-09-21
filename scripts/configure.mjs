import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const required = ['CV_WHATSAPP_TOKEN', 'CV_WHATSAPP_PHONE_ID', 'CV_WHATSAPP_WABA_ID',
  'CV_WHATSAPP_VERIFY_TOKEN', 'CV_WHATSAPP_APP_SECRET', 'CV_OPENROUTER_KEY',
  'CV_SHEET_ID', 'CV_SHEETS_SERVICE_ACCOUNT_EMAIL', 'CV_SHEETS_PRIVATE_KEY',
  'CV_ONEDRIVE_CLIENT_ID', 'CV_ADMIN_NUMBER'];
const optional = ['CV_DEVICE_NAME', 'CV_DASHBOARD_URL', 'CV_OPENROUTER_MODEL',
  'CV_ONEDRIVE_FOLDER', 'CV_ONEDRIVE_TENANT', 'CV_WHATSAPP_API_VERSION'];

export function configure(directory, env = process.env) {
  const target = path.join(directory, 'runtime.env');
  if (fs.existsSync(target)) throw new Error('Existing runtime.env preserved; edit it explicitly instead of rerunning setup');
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Required environment variables missing: ${missing.join(', ')}`);
  const values = Object.fromEntries([...required, ...optional].filter(key => env[key] !== undefined)
    .map(key => [key, env[key]]));
  values.CV_OPENROUTER_MODEL ||= 'google/gemini-3.8-flash';
  values.CV_ADMIN_TOKEN = env.CV_ADMIN_TOKEN || randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{24,256}$/.test(values.CV_ADMIN_TOKEN) || new Set(values.CV_ADMIN_TOKEN).size < 8) {
    throw new Error('CV_ADMIN_TOKEN must be a high-entropy base64url token');
  }
  values.CV_SHEETS_PRIVATE_KEY = values.CV_SHEETS_PRIVATE_KEY.replace(/\r?\n/g, '\\n');
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n\0]/.test(value)) throw new Error(`Unsupported newline or NUL in ${key}`);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Exclusive creation never replaces an existing configuration, including a symlink.
  fs.writeFileSync(target, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 });
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--config-dir')) throw new Error('Usage: configure.mjs [--config-dir DIR]');
    const directory = args[1] ?? fileURLToPath(new URL('../data/cv-auto/config/', import.meta.url));
    configure(directory);
    console.log('Protected runtime.env created. Credentials and admin token were not displayed.');
    console.log('Provider verification and service startup have NOT been performed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
