import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Configuration, PublicClientApplication } from '@azure/msal-node';
import { MsalTokenProvider, startDeviceCodeLogin } from '../auth.js';

const temp = path.resolve('src/integrations/onedrive/__tests__/.auth-temp');
const cfg = { clientId: 'client', folderRoot: 'CV Applications', tokenCachePath: path.join(temp, 'cache.json') };
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

function fake() {
  let configuration: Configuration;
  const cache = { deserialize: vi.fn(), serialize: () => '{"refreshed":true}', getAllAccounts: vi.fn(async () => [{ homeAccountId: 'account' }]) };
  const app = {
    getTokenCache: () => cache,
    acquireTokenSilent: vi.fn(async () => ({ accessToken: 'secret' })),
    acquireTokenByDeviceCode: vi.fn(async (request: any) => {
      request.deviceCodeCallback({ message: 'Visit Microsoft and enter CODE' });
      return { accessToken: 'secret' };
    }),
  };
  const factory = (c: Configuration) => { configuration = c; return app as unknown as PublicClientApplication; };
  return { app, cache, factory, config: () => configuration! };
}

describe('OneDrive MSAL authentication', () => {
  it('uses consumers authority and silent refresh with cached account', async () => {
    const f = fake();
    const provider = new MsalTokenProvider(cfg, f.factory);
    expect(await provider.getAccessToken()).toBe('secret');
    expect(f.app.acquireTokenSilent).toHaveBeenCalledWith(expect.objectContaining({ scopes: ['Files.ReadWrite'], account: { homeAccountId: 'account' } }));
    expect(f.app.acquireTokenByDeviceCode).not.toHaveBeenCalled();
    expect(f.config().auth.authority).toBe('https://login.microsoftonline.com/consumers');
  });
  it('loads and saves JSON through the MSAL cache plugin', async () => {
    const f = fake();
    new MsalTokenProvider(cfg, f.factory);
    await mkdir(temp, { recursive: true });
    await writeFile(cfg.tokenCachePath, '{"old":true}');
    const context = { cacheHasChanged: true, tokenCache: f.cache } as any;
    await f.config().cache!.cachePlugin!.beforeCacheAccess(context);
    expect(f.cache.deserialize).toHaveBeenCalledWith('{"old":true}');
    await f.config().cache!.cachePlugin!.afterCacheAccess(context);
    expect(JSON.parse(await readFile(cfg.tokenCachePath, 'utf8'))).toEqual({ refreshed: true });
  });
  it('fails actionably instead of opening interactive login in the worker', async () => {
    const f = fake();
    f.cache.getAllAccounts.mockResolvedValue([]);
    await expect(new MsalTokenProvider(cfg, f.factory).getAccessToken()).rejects.toThrow(/cv-auto config/);
    expect(f.app.acquireTokenByDeviceCode).not.toHaveBeenCalled();
  });
  it('redacts silent authentication failures', async () => {
    const f = fake();
    f.app.acquireTokenSilent.mockRejectedValue(new Error('SECRET_TOKEN'));
    await expect(new MsalTokenProvider(cfg, f.factory).getAccessToken()).rejects.toThrow(/cv-auto config/);
    await expect(new MsalTokenProvider(cfg, f.factory).getAccessToken()).rejects.not.toThrow('SECRET_TOKEN');
  });
  it('returns device instructions before authentication completes', async () => {
    const f = fake();
    let finish!: (value: any) => void;
    f.app.acquireTokenByDeviceCode.mockImplementation(async (request: any) => {
      request.deviceCodeCallback({ message: 'Enter CODE' });
      return new Promise(resolve => { finish = resolve; });
    });
    const login = await startDeviceCodeLogin(cfg, f.factory);
    expect(login.message).toBe('Enter CODE');
    finish({ accessToken: ['not', 'exposed'].join('-') });
    expect(await login.result).toBeUndefined();
  });
  it('rejects setup errors even before the device callback', async () => {
    const f = fake();
    f.app.acquireTokenByDeviceCode.mockRejectedValue(new Error('SECRET_TOKEN'));
    await expect(startDeviceCodeLogin(cfg, f.factory)).rejects.toThrow(/public client/);
  });
});
