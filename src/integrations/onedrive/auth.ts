import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PublicClientApplication, type Configuration, type ICachePlugin } from '@azure/msal-node';
import type { OneDriveConfig } from '../../contracts.js';

export const GRAPH_SCOPES = ['Files.ReadWrite'];
export type PcaFactory = (config: Configuration) => PublicClientApplication;
export interface TokenProvider { getAccessToken(): Promise<string>; }

function createClient(cfg: OneDriveConfig, factory: PcaFactory = c => new PublicClientApplication(c)): PublicClientApplication {
  const cachePlugin: ICachePlugin = {
    async beforeCacheAccess(context) {
      try { context.tokenCache.deserialize(fs.readFileSync(cfg.tokenCachePath, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read OneDrive token cache. Check file permissions or re-link with cv-auto config.'); }
    },
    async afterCacheAccess(context) {
      if (!context.cacheHasChanged) return;
      fs.mkdirSync(path.dirname(cfg.tokenCachePath), { recursive: true, mode: 0o700 });
      const temporary = `${cfg.tokenCachePath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, context.tokenCache.serialize(), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, cfg.tokenCachePath);
      } finally { fs.rmSync(temporary, { force: true }); }
    },
  };
  return factory({
    auth: { clientId: cfg.clientId, authority: `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId ?? 'consumers')}` },
    cache: { cachePlugin },
    system: { loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
  });
}

/** Silent acquisition lets MSAL use a cached token or refresh it. Workers never prompt. */
export class MsalTokenProvider implements TokenProvider {
  private readonly pca: PublicClientApplication;
  constructor(cfg: OneDriveConfig, factory?: PcaFactory) { this.pca = createClient(cfg, factory); }
  async getAccessToken(): Promise<string> {
    try {
      const accounts = await this.pca.getTokenCache().getAllAccounts();
      if (accounts.length === 1) {
        const result = await this.pca.acquireTokenSilent({ scopes: GRAPH_SCOPES, account: accounts[0] });
        if (result?.accessToken) return result.accessToken;
      }
    } catch { /* Raw MSAL errors may contain sensitive data. */ }
    throw new Error('OneDrive authentication missing, expired, or ambiguous. Run "cv-auto config" to re-link OneDrive with the intended account.');
  }
}

/** Resolves when instructions arrive, not when login finishes. No tokens are returned. */
export async function startDeviceCodeLogin(cfg: OneDriveConfig, factory?: PcaFactory): Promise<{ message: string; result: Promise<void> }> {
  let announce!: (message: string) => void;
  let fail!: (error: Error) => void;
  const instructions = new Promise<string>((resolve, reject) => { announce = resolve; fail = reject; });
  const result = Promise.resolve().then(async () => {
    const pca = createClient(cfg, factory);
    const token = await pca.acquireTokenByDeviceCode({ scopes: GRAPH_SCOPES, deviceCodeCallback: response => announce(response.message) });
    if (!token?.accessToken) throw new Error('No authentication result');
  }).catch(() => {
    const error = new Error('OneDrive login failed. Check client ID, tenant, public client device-code support and Files.ReadWrite consent; retry cv-auto config.');
    fail(error);
    throw error;
  });
  // Mark handled while the wizard awaits the instructions; callers still observe rejection.
  void result.catch(() => {});
  return { message: await instructions, result };
}
