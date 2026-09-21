// One-command native launcher for Kali: installs dependencies, builds,
// asks for the provider credentials interactively (secrets hidden), saves
// them into the protected runtime.env, starts redis + api + worker + admin,
// then prints the connection banner and sends the WhatsApp ONLINE notice.
//
// Usage:  node scripts/run-native.mjs          (install + ask + start)
//         node scripts/run-native.mjs --stop   (stop services and redis)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
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

// One readline instance for the whole session. Lines are queued as they
// arrive (piped input delivers them all at once, so a per-question listener
// would drop everything after the first answer). Hidden prompts swap the
// output stream so typed secrets are never echoed.
const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pendingLines = [];
rl.on('line', (line) => { pendingLines.push(line); });
function ask(question, hidden) {
  return new Promise((resolve) => {
    rl.output = hidden ? muted : process.stdout;
    // Write directly to the output stream: piped input closes the readline
    // interface at EOF while the queued lines remain usable.
    rl.output.write(question);
    const take = () => {
      if (pendingLines.length > 0) {
        rl.output = process.stdout;
        if (hidden) process.stdout.write('\n');
        resolve(pendingLines.shift().trim());
      } else {
        setTimeout(take, 10);
      }
    };
    take();
  });
}

async function requiredHidden(label, envName, out) {
  while (!(out[envName] ?? '').trim()) {
    out[envName] = await ask(`${label}: `, true);
    if (!out[envName].trim()) console.log('  (required — cannot be empty)');
  }
}

async function requiredVisible(label, envName, out, pattern) {
  while (true) {
    out[envName] = await ask(`${label}: `, false);
    if (out[envName].trim() && (!pattern || pattern.test(out[envName]))) return;
    console.log(pattern ? '  (invalid format — expected e.g. 9477XXXXXXXX)' : '  (required — cannot be empty)');
  }
}

async function collectCredentials() {
  const out = { ...process.env };
  console.log('\n=== PROVIDER CREDENTIALS (secrets are hidden while typing) ===');
  console.log('Press Enter for any value already exported in your environment.');
  await requiredHidden('WhatsApp permanent access token', 'CV_WHATSAPP_TOKEN', out);
  await requiredVisible('WhatsApp Phone Number ID', 'CV_WHATSAPP_PHONE_ID', out);
  await requiredVisible('WhatsApp Business Account ID', 'CV_WHATSAPP_WABA_ID', out);
  await requiredHidden('Webhook verify token (make up a random string)', 'CV_WHATSAPP_VERIFY_TOKEN', out);
  await requiredHidden('WhatsApp App Secret', 'CV_WHATSAPP_APP_SECRET', out);
  await requiredHidden('OpenRouter API key', 'CV_OPENROUTER_KEY', out);
  await requiredVisible('Google Sheet ID', 'CV_SHEET_ID', out);
  await requiredVisible('Sheets service account email', 'CV_SHEETS_SERVICE_ACCOUNT_EMAIL', out);
  const keyPath = await ask('Path to the service-account key JSON file (Enter to paste the key instead): ', false);
  if (keyPath) {
    if (!fs.existsSync(keyPath)) throw new Error(`Key file not found: ${keyPath}`);
    out.CV_SHEETS_PRIVATE_KEY = fs.readFileSync(keyPath, 'utf8');
  } else {
    await requiredHidden('Service account private key (single line, newlines as literal \\n)', 'CV_SHEETS_PRIVATE_KEY', out);
  }
  await requiredVisible('OneDrive (Microsoft) application client ID', 'CV_ONEDRIVE_CLIENT_ID', out);
  await requiredVisible('WhatsApp number that receives system notices (e.g. 9477XXXXXXXX)', 'CV_ADMIN_NUMBER', out, /^\+?\d{7,15}$/);
  return out;
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
    const answer = await ask('A saved configuration already exists. Overwrite it? [y/N]: ', false);
    if (!/^y/i.test(answer)) {
      console.log('Keeping the existing configuration.');
    } else {
      const backup = `${runtimeFile}.bak-${Date.now()}`;
      fs.copyFileSync(runtimeFile, backup);
      console.log(`Existing configuration backed up to ${backup}`);
      configure(CONFIG_DIR, await collectCredentials());
    }
  } else {
    configure(CONFIG_DIR, await collectCredentials());
  }
  console.log('Starting redis and the appliance services...');
  ensureRedis();
  startService('worker/index.js', 'worker.log');
  startService('api/index.js', 'api.log');
  startService('api/admin-server.js', 'admin.log');
  await new Promise((resolve) => setTimeout(resolve, 4000));

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
