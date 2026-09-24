import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OneDriveClient } from '../client.js';

// The resolving guard is covered in url-guard.test.ts; only the resolving check
// is mocked pass-through here so these transport tests stay hermetic.
const guard = vi.hoisted(() => ({ assertPublicHttpUrl: vi.fn(async (url: string) => new URL(url)) }));
vi.mock('../../../network/url-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../network/url-guard.js')>();
  return { ...actual, assertPublicHttpUrl: guard.assertPublicHttpUrl };
});

const dir = path.resolve('src/integrations/onedrive/__tests__/.client-temp');
const cfg = { clientId: 'client', folderRoot: 'CV Applications', tokenCachePath: path.join(dir, 'cache.json') };
const json = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const sleep = vi.fn(async (_ms: number) => {});
  const client = new OneDriveClient(cfg, { fetch, sleep, tokenProvider: { getAccessToken: async () => 'secret' }, timeoutMs: 10 });
  return { fetch, sleep, client };
}
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  guard.assertPublicHttpUrl.mockClear();
  guard.assertPublicHttpUrl.mockImplementation(async (url: string) => new URL(url));
});
async function file(size: number) { await mkdir(dir, { recursive: true }); const name = path.join(dir, 'cv.pdf'); await writeFile(name, Buffer.alloc(size, 7)); return name; }

describe('OneDriveClient', () => {
  it('walks encoded segments and tolerates conflicts only for existing folders', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json({}, 409)).mockResolvedValueOnce(json({ id: 'root', folder: {} })).mockResolvedValueOnce(json({ id: 'child', folder: {} }, 201));
    await client.ensureFolder('CV Applications/2026 #');
    expect(fetch.mock.calls[0][0]).toBe('https://graph.microsoft.com/v1.0/me/drive/root/children');
    expect(fetch.mock.calls[2][0]).toBe('https://graph.microsoft.com/v1.0/me/drive/root:/CV%20Applications:/children');
    expect(JSON.parse(fetch.mock.calls[2][1]!.body as string)).toEqual({ name: '2026 #', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
  });
  it('does not mistake a conflicting file for a folder', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json({}, 409)).mockResolvedValueOnce(json({ id: 'file' }));
    await expect(client.ensureFolder('occupied')).rejects.toThrow(/not a folder/);
  });
  it('retries simple PUT at exactly the same path and bytes, including 4MB boundary', async () => {
    const { client, fetch, sleep } = setup();
    fetch.mockResolvedValueOnce(json({}, 429, { 'Retry-After': '2' })).mockResolvedValueOnce(json({ id: 'file-id' }, 201));
    expect(await client.uploadFile(await file(4 * 1024 * 1024), 'CV Applications/CV #1.pdf')).toEqual({ fileId: 'file-id' });
    expect(fetch.mock.calls[0][0]).toBe('https://graph.microsoft.com/v1.0/me/drive/root:/CV%20Applications/CV%20%231.pdf:/content');
    expect(fetch.mock.calls[1][0]).toBe(fetch.mock.calls[0][0]);
    expect(fetch.mock.calls[1][1]!.body).toBe(fetch.mock.calls[0][1]!.body);
    expect(sleep).toHaveBeenCalledWith(2000);
  });
  it('uploads large files sequentially with aligned chunks and no Graph bearer on session URLs', async () => {
    const { client, fetch } = setup();
    const size = 4 * 1024 * 1024 + 1;
    fetch.mockResolvedValueOnce(json({ uploadUrl: 'https://upload.example/session?secret=token' }));
    fetch.mockResolvedValueOnce(json({ nextExpectedRanges: ['3276800-'] }, 202));
    fetch.mockResolvedValueOnce(json({ id: 'large' }, 201));
    expect(await client.uploadFile(await file(size), 'folder/cv.pdf')).toEqual({ fileId: 'large' });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ item: { '@microsoft.graph.conflictBehavior': 'replace' } });
    expect(new Headers(fetch.mock.calls[1][1]!.headers).get('Authorization')).toBeNull();
    expect(new Headers(fetch.mock.calls[1][1]!.headers).get('Content-Range')).toBe(`bytes 0-3276799/${size}`);
    expect(new Headers(fetch.mock.calls[2][1]!.headers).get('Content-Range')).toBe(`bytes 3276800-${size - 1}/${size}`);
  });
  it('creates anonymous view links and rejects missing URLs', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json({ link: { webUrl: 'https://1drv.ms/view' } })).mockResolvedValueOnce(json({}));
    expect(await client.createShareLink('a/b')).toBe('https://1drv.ms/view');
    expect(fetch.mock.calls[0][0]).toBe('https://graph.microsoft.com/v1.0/me/drive/items/a%2Fb/createLink');
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ type: 'view', scope: 'anonymous' });
    await expect(client.createShareLink('id')).rejects.toThrow(/link/);
  });
  it('verifies write permission via a temporary folder then deletes it', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(json({ id: 'root', folder: {} })).mockResolvedValueOnce(json({ id: 'probe', folder: {} }, 201)).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.verifyFolder();
    expect(fetch.mock.calls[2][1]!.method).toBe('DELETE');
    expect(fetch.mock.calls[2][0]).toBe('https://graph.microsoft.com/v1.0/me/drive/items/probe');
  });
  it('gives actionable permission guidance without raw service error data', async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValue(json({ error: { message: 'SECRET_TOKEN' } }, 403));
    await expect(client.verifyFolder()).rejects.toThrow(/cv-auto config/);
    await expect(client.verifyFolder()).rejects.not.toThrow('SECRET_TOKEN');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('retries 503 and timeout then succeeds', async () => {
    const { client, fetch, sleep } = setup();
    fetch.mockResolvedValueOnce(json({}, 503)).mockRejectedValueOnce(Object.assign(new Error('private'), { name: 'TimeoutError' })).mockResolvedValueOnce(json({ link: { webUrl: 'https://1drv.ms/view' } }));
    expect(await client.createShareLink('id')).toBe('https://1drv.ms/view');
    expect(sleep.mock.calls.map(c => c[0])).toEqual([500, 1000]);
  });
  it('refuses a provider upload-session URL whose host the guard blocks, before any CV bytes are sent', async () => {
    const { client, fetch } = setup();
    const size = 4 * 1024 * 1024 + 1;
    fetch.mockResolvedValueOnce(json({ uploadUrl: 'https://internal.example/session' }));
    guard.assertPublicHttpUrl.mockImplementation(async (url: string) => {
      if (new URL(url).hostname === 'internal.example') throw new Error('Request URL host is not a public address');
      return new URL(url);
    });
    await expect(client.uploadFile(await file(size), 'folder/cv.pdf')).rejects.toThrow('invalid upload session URL');
    // Only the createUploadSession call went out; no chunk was transmitted.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain('/createUploadSession');
  });
  it('rejects path traversal before network calls', async () => {
    const { client, fetch } = setup();
    await expect(client.ensureFolder('folder/../escape')).rejects.toThrow(/path/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
