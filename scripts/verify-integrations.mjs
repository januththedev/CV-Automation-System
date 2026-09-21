import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
};
const root = fileURLToPath(new URL('../', import.meta.url));
const dist = rel => pathToFileURL(path.join(root, 'dist', rel)).href;

/**
 * Completion notification sent after the stack comes up: device, IP, the
 * SSH connection, the loopback dashboard tunnel, and the host key
 * fingerprint. Only display fields leave the device; sendAdmin scrubs any
 * configured secret that ever appeared in the message.
 *
 * Usage: verify-integrations.mjs notify-online
 *          [--ip 1.2.3.4] [--ssh-user admin] [--dashboard-url URL] [--fingerprint SHA256:..]
 * No-op with exit 0 when WhatsApp or the admin number is not configured.
 */
if (command === 'notify-online') {
  try {
    const { loadConfig } = await import(dist('src/config.js'));
    const { sendAdmin } = await import(dist('src/services/notify.js'));
    const config = loadConfig(flag('config-dir'));
    const sshUser = flag('ssh-user') ?? process.env.CV_SSH_USER;
    const ip = flag('ip');
    const sshHint = ip && sshUser ? `ssh ${sshUser}@${ip}` : undefined;
    const sshTunnel = ip && sshUser ? `ssh -L 3001:127.0.0.1:3001 ${sshUser}@${ip}` : undefined;
    await sendAdmin({
      type: 'online',
      deviceName: config.deviceName,
      ip,
      sshHint,
      sshTunnel,
      dashboardUrl: flag('dashboard-url') ?? config.dashboardUrl ?? undefined,
      fingerprint: flag('fingerprint'),
    }, config.whatsapp ?? undefined, config.adminWhatsappNumber ?? undefined);
    console.log('notify-online: sent (no-op when WhatsApp or the admin number is not configured)');
    process.exit(0);
  } catch {
    // Delivery failure must not fail the completed setup; the error is
    // intentionally generic so provider details never reach the console.
    console.error('notify-online: WhatsApp delivery failed — verify the provider configuration and admin number');
    process.exit(0);
  }
}

const providers = ['whatsapp', 'sheets', 'openrouter', 'onedrive'];
const onlyIndex = argv.indexOf('--only');
const only = onlyIndex < 0 ? undefined : argv[onlyIndex + 1];
if (command !== 'check' || !argv.includes('--allow-live') || (onlyIndex >= 0 && !providers.includes(only))) {
  console.error('Usage: verify-integrations.mjs check --allow-live [--only whatsapp|sheets|openrouter|onedrive]');
  console.error('       verify-integrations.mjs notify-online [--ip IP] [--ssh-user USER] [--dashboard-url URL] [--fingerprint SHA256:..]');
  console.error('Live checks can send an admin WhatsApp message, create a OneDrive folder and incur model charges.');
  process.exit(2);
}
try {
  const { loadConfig } = await import(dist('src/config.js'));
  const config = loadConfig();
  const checks = {
    whatsapp: async () => {
      if (!config.whatsapp?.accessToken || !config.whatsapp.phoneNumberId || !config.adminWhatsappNumber) throw new Error();
      const { WhatsAppClient } = await import(dist('src/integrations/whatsapp/client.js'));
      await new WhatsAppClient(config.whatsapp).sendText(config.adminWhatsappNumber, 'CV automation: operator-requested live delivery test.');
    },
    sheets: async () => {
      if (!config.sheets?.sheetId) throw new Error();
      const { SheetsClient } = await import(dist('src/integrations/google-sheets/client.js'));
      await new SheetsClient(config.sheets).verifyAccess();
    },
    openrouter: async () => {
      if (!config.openrouter?.apiKey) throw new Error();
      const { validateModel } = await import(dist('src/integrations/openrouter/client.js'));
      if (!await validateModel(config.openrouter.model, config.openrouter)) throw new Error();
    },
    onedrive: async () => {
      if (!config.onedrive?.clientId) throw new Error();
      const { startDeviceCodeLogin } = await import(dist('src/integrations/onedrive/auth.js'));
      const { OneDriveClient } = await import(dist('src/integrations/onedrive/client.js'));
      const login = await startDeviceCodeLogin(config.onedrive);
      // Device-code authorization is intentionally displayed to the local operator only.
      console.log(login.message);
      await login.result;
      await new OneDriveClient(config.onedrive).verifyFolder();
    },
  };
  for (const provider of only ? [only] : providers) {
    try {
      await checks[provider]();
      console.log(`${provider}: live check passed`);
    } catch {
      console.error(`${provider}: check failed or configuration missing`);
      process.exitCode = 1;
    }
  }
} catch {
  console.error('Verification could not start; build the appliance and configure its environment first.');
  process.exitCode = 1;
}
