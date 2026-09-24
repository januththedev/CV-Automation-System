// One-command native launcher for Kali: installs dependencies, builds,
// asks for the provider credentials interactively (each prompt explains where
// to find the value; typed text is visible while entering and cleared after
// Enter), shows a masked review, saves into the protected runtime.env,
// starts redis + api + worker + admin, verifies the stack came up, prints the
// connection banner, and sends the WhatsApp ONLINE notice.
//
// Usage:  node scripts/run-native.mjs          (install + ask + start)
//         node scripts/run-native.mjs --stop   (stop services and redis)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { configure } from './configure.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_DIR = path.join(ROOT, 'data', 'cv-auto', 'config');
const DATA_DIR = path.join(ROOT, 'data', 'cv-auto', 'data');
const LOG_DIR = path.join(ROOT, 'logs');
const dist = (rel) => pathToFileURL(path.join(ROOT, 'dist', rel)).href;
const REDIS_URL = 'redis://127.0.0.1:6379';

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status})`);
}
function quiet(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'ignore', cwd: ROOT }).status === 0;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One readline instance for the whole session. Lines are queued as they
// arrive (piped input delivers them all at once, so a per-question listener
// would drop everything after the first answer). Secret prompts echo what the
// user types so pasted keys are visible while entering; the terminal erase
// sequence clears that line after Enter, so the value is hidden only once
// submitted.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pendingLines = [];
rl.on('line', (line) => { pendingLines.push(line); });
function ask(question, hidden) {
  return new Promise((resolve) => {
    // Write directly to the output stream: piped input closes the readline
    // interface at EOF while the queued lines remain usable.
    rl.output.write(question);
    const take = () => {
      if (pendingLines.length > 0) {
        const value = pendingLines.shift().trim();
        // With a terminal (interactive typing) readline already echoed the
        // answer; move the cursor up and blank it so the value is masked
        // after submit, then restore a clean prompt line.
        if (hidden && rl.terminal) {
          process.stdout.write('\x1b[1A\x1b[2K');
        }
        process.stdout.write('\n');
        resolve(value);
      } else {
        setTimeout(take, 10);
      }
    };
    take();
  });
}

const FIELDS = [
  { env: 'CV_WHATSAPP_TOKEN', label: 'WhatsApp permanent access token', secret: true,
    where: 'Meta Business Suite → WhatsApp Manager → API Setup → Permanent token (or a System User token)' },
  { env: 'CV_WHATSAPP_PHONE_ID', label: 'WhatsApp Phone Number ID',
    where: 'WhatsApp Manager → Phone numbers → your number → Settings → Phone number ID (a long digit ID — NOT your phone number)' },
  { env: 'CV_WHATSAPP_WABA_ID', label: 'WhatsApp Business Account ID',
    where: 'WhatsApp Manager → Account overview → Business Account ID' },
  { env: 'CV_WHATSAPP_VERIFY_TOKEN', label: 'Webhook verify token (invent any random string)', secret: true,
    where: 'Anything you choose (e.g. 32 random characters) — you type the same value into Meta when setting the webhook' },
  { env: 'CV_WHATSAPP_APP_SECRET', label: 'WhatsApp App Secret', secret: true,
    where: 'Meta Business Suite → App settings → Basic → App secret → Show → Copy' },
  { env: 'CV_OPENROUTER_KEY', label: 'OpenRouter API key', secret: true,
    where: 'openrouter.ai → Account → API Keys → Create new key' },
  { env: 'CV_SHEET_ID', label: 'Google Sheet ID',
    where: 'Open your sheet in a browser; the ID is the long string between /d/ and /edit in the URL' },
  { env: 'CV_SHEETS_SERVICE_ACCOUNT_EMAIL', label: 'Sheets service account email',
    where: 'Google Cloud Console → IAM & Admin → Service Accounts → the service account you created' },
  { env: 'CV_ONEDRIVE_CLIENT_ID', label: 'OneDrive (Microsoft) application client ID',
    where: 'Microsoft Entra admin center → App registrations → New registration → copy "Application (client) ID"' },
  { env: 'CV_ADMIN_NUMBER', label: 'WhatsApp number that receives system notices', pattern: /^\+?\d{7,15}$/,
    where: 'Your own WhatsApp number in international format, digits with optional + (e.g. 94771234567)' },
];

function mask(value, secret) {
  if (!secret) return value;
  const text = String(value);
  return text.length <= 8 ? '•'.repeat(text.length) : `••••${text.slice(-4)}`;
}

async function askField(field, out) {
  if ((out[field.env] ?? '').trim()) {
    console.log(`${field.label}: [taken from your environment]`);
    return;
  }
  console.log(`\n${field.label}`);
  console.log(`  ↳ where: ${field.where}`);
  while (true) {
    out[field.env] = await ask('  value: ', Boolean(field.secret));
    if (out[field.env].trim() && (!field.pattern || field.pattern.test(out[field.env]))) return;
    console.log(field.pattern ? '  (invalid — expected e.g. 94771234567)' : '  (required — cannot be empty)');
  }
}

async function askPrivateKey(out) {
  if ((out.CV_SHEETS_PRIVATE_KEY ?? '').trim()) {
    console.log('Service account private key: [taken from your environment]');
    return;
  }
  console.log('\nService account private key');
  console.log('  ↳ where: the JSON key file you downloaded when creating the service account');
  const keyPath = await ask('  path to the key JSON file (Enter to paste the key instead): ', false);
  if (keyPath) {
    if (!fs.existsSync(keyPath)) throw new Error(`Key file not found: ${keyPath}`);
    out.CV_SHEETS_PRIVATE_KEY = fs.readFileSync(keyPath, 'utf8');
    return;
  }
  while (!(out.CV_SHEETS_PRIVATE_KEY ?? '').trim()) {
    out.CV_SHEETS_PRIVATE_KEY = await ask('  paste the key (single line, newlines as literal \\n): ', true);
    if (!out.CV_SHEETS_PRIVATE_KEY.trim()) console.log('  (required — cannot be empty)');
  }
}

async function collectCredentials() {
  const out = { ...process.env };
  console.log('\n=== PROVIDER CREDENTIALS ===');
  console.log('Each prompt explains where to find the value. What you type is shown');
  console.log('while you enter it, then cleared after you press Enter.');
  console.log('Values already exported in your environment are kept automatically.');
  for (const field of FIELDS) await askField(field, out);
  await askPrivateKey(out);
  return out;
}

async function reviewAndSave(collected) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.log('\n=== REVIEW (secrets masked) ===');
    for (const field of FIELDS) console.log(`  ${field.label}: ${mask(collected[field.env], field.secret)}`);
    console.log(`  Service account private key: ${mask(collected.CV_SHEETS_PRIVATE_KEY, true)}`);
    const answer = await ask('\nSave this configuration? [Y/n]: ', false);
    if (/^n/i.test(answer)) {
      console.log('Let\'s go through the values again...');
      for (const field of FIELDS) delete collected[field.env];
      delete collected.CV_SHEETS_PRIVATE_KEY;
      return reviewAndSave(await collectCredentials());
    }
    configure(CONFIG_DIR, collected);
    return;
  }
  throw new Error('Configuration not confirmed after 3 attempts — nothing was saved');
}

async function installAndBuild() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.log('Installing dependencies (first run — takes a minute)...');
    run('npm', ['ci', '--no-audit', '--no-fund']);
  }
  // Kali's npm blocks native install scripts until approved.
  if (!quiet(process.execPath, ['-e', "require('better-sqlite3')(':memory:')"])) {
    console.log('Enabling the native database build...');
    quiet('npm', ['install-scripts', 'approve', 'better-sqlite3']);
    run('npm', ['rebuild', 'better-sqlite3']);
  }
  console.log('Building the appliance...');
  run('npm', ['run', 'build']);
}

function loadRuntimeEnv() {
  const envFile = path.join(CONFIG_DIR, 'runtime.env');
  const env = { ...process.env };
  if (!fs.existsSync(envFile)) return env;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

function serviceEnv() {
  return {
    ...loadRuntimeEnv(),
    CV_CONFIG_DIR: CONFIG_DIR,
    CV_DATA_DIR: DATA_DIR,
    CV_REDIS_URL: REDIS_URL,
    CV_API_PORT: process.env.CV_API_PORT ?? '3000',
    CV_ADMIN_PORT: process.env.CV_ADMIN_PORT ?? '3001',
  };
}

function ensureRedis() {
  if (quiet('redis-cli', ['ping'])) return;
  // redis-server refuses to daemonize into a directory that does not exist yet.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!quiet('redis-server', ['--daemonize', 'yes', '--dir', DATA_DIR])) {
    throw new Error('Redis failed to start. Install it with: sudo apt install -y redis-server');
  }
  if (!quiet('redis-cli', ['ping'])) throw new Error('Redis started but is not answering pings');
}

function startService(entry, logName) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const fd = fs.openSync(path.join(LOG_DIR, logName), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', entry)], {
    env: serviceEnv(), detached: true, stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
}

function httpOk(url) {
  const result = spawnSync('curl', ['-fsS', '-m', '2', '-o', '/dev/null', url], { stdio: 'ignore' });
  return result.status === 0;
}

async function waitForStack() {
  const apiPort = process.env.CV_API_PORT ?? '3000';
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (httpOk(`http://127.0.0.1:${apiPort}/health`)) return true;
    await sleep(1000);
  }
  return false;
}

function tailLogs(names) {
  return names.map((name) => `--- logs/${name} ---\n${tailLog(name)}`).join('\n');
}

function tailLog(name) {
  const file = path.join(LOG_DIR, name);
  if (!fs.existsSync(file)) return '(no log file)';
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-20).join('\n');
}

function localIp() {
  const found = Object.values(networkInterfaces()).flat()
    .find((a) => a && !a.internal && a.family === 'IPv4');
  return found?.address ?? '127.0.0.1';
}

function hostFingerprint() {
  for (const keyfile of ['/etc/ssh/ssh_host_ed25519_key.pub', '/etc/ssh/ssh_host_rsa_key.pub']) {
    if (!fs.existsSync(keyfile)) continue;
    const result = spawnSync('ssh-keygen', ['-lf', keyfile], { encoding: 'utf8' });
    const match = result.stdout.match(/\b(SHA256:[A-Za-z0-9+/=]+)\b/);
    if (match) return match[1];
  }
  return '';
}

async function start() {
  await installAndBuild();
  const runtimeFile = path.join(CONFIG_DIR, 'runtime.env');
  if (fs.existsSync(runtimeFile)) {
    const answer = await ask('\nA saved configuration already exists. Enter NEW values? [y/N]: ', false);
    if (/^y/i.test(answer)) {
      const backup = `${runtimeFile}.bak-${Date.now()}`;
      fs.copyFileSync(runtimeFile, backup);
      console.log(`Existing configuration backed up to ${backup}`);
      await reviewAndSave(await collectCredentials());
    } else {
      console.log('Keeping the existing configuration.');
    }
  } else {
    await reviewAndSave(await collectCredentials());
  }
  console.log('Starting redis and the appliance services...');
  ensureRedis();
  startService('worker/index.js', 'worker.log');
  startService('api/index.js', 'api.log');
  // The admin runtime fail-closes until the database file exists, so it starts
  // only after the API is up (the API creates the schema on first open).
  console.log('Waiting for the API to answer...');
  if (!(await waitForStack())) {
    console.error('\nThe API did not come up. Last 20 log lines:\n');
    console.error(tailLogs(['api.log', 'worker.log']));
    console.error('\nCommon causes: port 3000 already in use, or a bad configuration.');
    process.exitCode = 1;
    rl.close();
    return;
  }
  startService('api/admin-server.js', 'admin.log');
  console.log('Waiting for the admin panel to answer...');
  const adminPort = process.env.CV_ADMIN_PORT ?? '3001';
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (httpOk(`http://127.0.0.1:${adminPort}/admin/dashboard`)) break;
    await sleep(1000);
  }
  if (!httpOk(`http://127.0.0.1:${adminPort}/admin/dashboard`)) {
    console.error('\nThe admin panel did not come up. Last 20 log lines:\n');
    console.error(tailLogs(['admin.log', 'api.log']));
    console.error('\nCommon causes: port 3001 already in use, or a missing CV_ADMIN_TOKEN.');
    process.exitCode = 1;
    rl.close();
    return;
  }
  console.log('Stack is up: API and admin panel are responding.\n');

  for (const [key, value] of Object.entries(loadRuntimeEnv())) process.env[key] = value;

  const ip = localIp();
  const sshUser = process.env.USER || 'kali';
  const fingerprint = hostFingerprint();
  console.log(`
================================================================
    CV AUTOMATION IS ONLINE
----------------------------------------------------------------
    Notices:   ${process.env.CV_ADMIN_NUMBER ?? ''}
    SSH:       ssh ${sshUser}@${ip}
    Tunnel:    ssh -L 3001:127.0.0.1:3001 ${sshUser}@${ip}
               then open http://127.0.0.1:3001/admin/dashboard
    Status:    curl http://127.0.0.1:3000/health
    Logs:      ${LOG_DIR}
${fingerprint ? `    Key:       ${fingerprint}\n` : ''}
    Sending the ONLINE notice to your WhatsApp number...
================================================================
`);
  try {
    const { loadConfig } = await import(dist('src/config.js'));
    const { sendAdmin } = await import(dist('src/services/notify.js'));
    const config = loadConfig(CONFIG_DIR);
    await sendAdmin({
      type: 'online',
      deviceName: config.deviceName,
      ip,
      sshHint: `ssh ${sshUser}@${ip}`,
      sshTunnel: `ssh -L 3001:127.0.0.1:3001 ${sshUser}@${ip}`,
      dashboardUrl: 'http://127.0.0.1:3001/admin/dashboard',
      fingerprint: fingerprint || undefined,
    }, config.whatsapp ?? undefined, config.adminWhatsappNumber ?? undefined);
    console.log('WhatsApp notice sent.');
  } catch {
    console.log('WhatsApp notice could not be delivered (check provider credentials). The appliance keeps running.');
  }
  rl.close();
}

function stop() {
  console.log('Stopping services...');
  // Enumerate /proc directly: base Kali has no procps, so pkill/pgrep are
  // unavailable. Match the compiled entry points in each process cmdline.
  let killed = 0;
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ');
        if (/dist\/(api|worker|admin)\//.test(cmdline)) {
          process.kill(Number(entry), 'SIGTERM');
          killed += 1;
        }
      } catch { /* process exited between scan and kill */ }
    }
  } catch {
    quiet('pkill', ['-f', 'dist/(api|worker|admin)']);
  }
  quiet('redis-cli', ['shutdown', 'nosave']);
  console.log(`Stopped (${killed} service process(es)).`);
  rl.close();
}

try {
  if (process.argv.includes('--stop')) {
    stop();
  } else {
    await start();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
