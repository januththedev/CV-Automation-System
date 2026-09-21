// Persist one appliance setting into the SQLite database (writer path).
// Runs inside the api container (docker compose exec api node /app/scripts/db-set-setting.mjs)
// or on the host. Values are plain settings, never credentials.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [key, value] = process.argv.slice(2);
if (!key || value === undefined || !/^[a-z_][a-z0-9_]{0,63}$/.test(key)) {
  console.error('usage: db-set-setting.mjs <key> <value>');
  process.exit(2);
}
// This script lives at <root>/scripts/, so the repo/image root is its parent dir.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = (rel) => pathToFileURL(path.join(root, 'dist', rel)).href;
const { setSetting } = await import(dist('src/database/db.js'));
setSetting(key, value);
console.log(`saved: ${key}`);
