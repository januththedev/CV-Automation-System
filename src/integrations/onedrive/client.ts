import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { OneDriveClientApi, OneDriveConfig } from '../../contracts.js';
import { MsalTokenProvider, type TokenProvider } from './auth.js';
import { defaultSleep, GraphHttpError, requestWithRetry, type FetchLike, type Sleep } from './http.js';
import { assertPublicHttpUrl } from '../../network/url-guard.js';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SIMPLE_LIMIT = 4 * 1024 * 1024;
const CHUNK_SIZE = 10 * 320 * 1024;
export interface OneDriveClientOptions { tokenProvider?: TokenProvider; fetch?: FetchLike; sleep?: Sleep; timeoutMs?: number; }

function segments(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.some(p => p === '.' || p === '..' || /[\\\u0000-\u001f:*?"<>|]/.test(p))) throw new Error('Invalid OneDrive path: use slash-separated folder/file names without traversal or reserved characters.');
  return parts;
}
const encoded = (parts: string[]) => parts.map(encodeURIComponent).join('/');
const itemPath = (parts: string[]) => `/me/drive/root:/${encoded(parts)}`;
function fileId(data: any): string {
  if (typeof data?.id !== 'string' || !data.id) throw new Error('OneDrive upload did not return a file ID. Retry the same remote path.');
  return data.id;
}

/** Remote paths are drive-root-relative (folderRoot is not prepended). */
export class OneDriveClient implements OneDriveClientApi {
  private readonly tokenProvider: TokenProvider;
  private readonly fetch: FetchLike;
  private readonly sleep: Sleep;
  private readonly timeoutMs: number;
  constructor(private readonly cfg: OneDriveConfig, options: OneDriveClientOptions = {}) {
    this.tokenProvider = options.tokenProvider ?? new MsalTokenProvider(cfg);
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }
  private async graph(path: string, init: RequestInit = {}) {
    const token = await this.tokenProvider.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return requestWithRetry(this.fetch, this.sleep, `${GRAPH_BASE}${path}`, { ...init, headers }, this.timeoutMs);
  }
  private json(method: string, body: unknown): RequestInit {
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }
  async ensureFolder(path: string): Promise<void> {
    const parts = segments(path);
    for (let i = 0; i < parts.length; i++) {
      const parent = i === 0 ? '/me/drive/root/children' : `${itemPath(parts.slice(0, i))}:/children`;
      try {
        await this.graph(parent, this.json('POST', { name: parts[i], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }));
      } catch (error) {
        if (!(error instanceof GraphHttpError) || error.status !== 409) throw error;
        const { data } = await this.graph(itemPath(parts.slice(0, i + 1)));
        if (!data?.folder) throw new Error('OneDrive path exists but is not a folder. Choose a different target folder.');
      }
    }
  }
  async uploadFile(localPath: string, remotePath: string): Promise<{ fileId: string }> {
    const parts = segments(remotePath);
    const file = await open(localPath, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('OneDrive upload source must be a regular file.');
      if (stat.size <= SIMPLE_LIMIT) {
        const body = new Uint8Array(await file.readFile());
        const { data } = await this.graph(`${itemPath(parts)}:/content`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body });
        return { fileId: fileId(data) };
      }
      const { data: session } = await this.graph(`${itemPath(parts)}:/createUploadSession`, this.json('POST', { item: { '@microsoft.graph.conflictBehavior': 'replace' } }));
      let uploadUrl: URL;
      try { uploadUrl = new URL(session?.uploadUrl); }
      catch { throw new Error('OneDrive did not return a valid upload session.'); }
      if (uploadUrl.protocol !== 'https:' || uploadUrl.username || uploadUrl.password) throw new Error('OneDrive returned an invalid upload session URL.');
      // The upload URL is provider-supplied: validate its host (public, no
      // credentials) before any CV bytes are sent to it.
      try { await assertPublicHttpUrl(uploadUrl.href); }
      catch { throw new Error('OneDrive returned an invalid upload session URL.'); }
      for (let offset = 0; offset < stat.size;) {
        const length = Math.min(CHUNK_SIZE, stat.size - offset);
        const body = new Uint8Array(length);
        const { bytesRead } = await file.read(body, 0, length, offset);
        if (bytesRead !== length) throw new Error('Upload source changed while being read. Retry with a stable local file.');
        let response;
        try {
          // Upload session URLs are preauthenticated. Never forward Graph bearer tokens.
          response = await requestWithRetry(this.fetch, this.sleep, uploadUrl.href, {
            method: 'PUT', headers: { 'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${offset + length - 1}/${stat.size}` }, body,
          }, this.timeoutMs);
        } catch (error) {
          // An accepted chunk with a lost response may produce 416 on replay.
          if (!(error instanceof GraphHttpError) || error.status !== 416) throw error;
          response = await requestWithRetry(this.fetch, this.sleep, uploadUrl.href, { method: 'GET' }, this.timeoutMs);
        }
        if (response.status === 200 || response.status === 201) {
          if (response.data?.id) return { fileId: fileId(response.data) };
        }
        const range = response.data?.nextExpectedRanges?.[0];
        const next = typeof range === 'string' && /^\d+-/.test(range) ? Number(range.split('-')[0]) : NaN;
        if (!Number.isSafeInteger(next) || next <= offset || next > offset + length || next >= stat.size) throw new Error('OneDrive upload session did not acknowledge the chunk. Retry the same remote path.');
        offset = next;
      }
      throw new Error('OneDrive upload did not complete. Retry the same remote path.');
    } finally { await file.close(); }
  }
  async createShareLink(id: string): Promise<string> {
    if (!id) throw new Error('OneDrive file ID is required to create a share link.');
    const { data } = await this.graph(`/me/drive/items/${encodeURIComponent(id)}/createLink`, this.json('POST', { type: 'view', scope: 'anonymous' }));
    const link = data?.link?.webUrl;
    if (typeof link !== 'string' || !/^https:\/\//i.test(link)) throw new Error('OneDrive did not return a usable view link. Check anonymous sharing policy for the account.');
    return link;
  }
  async verifyFolder(): Promise<void> {
    try {
      const parts = segments(this.cfg.folderRoot);
      await this.ensureFolder(this.cfg.folderRoot);
      // A read check alone cannot verify write access; use a unique empty probe folder.
      const { data } = await this.graph(`${itemPath(parts)}:/children`, this.json('POST', { name: `.cv-auto-check-${randomUUID()}`, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }));
      const id = fileId(data);
      await this.graph(`/me/drive/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      const status = error instanceof GraphHttpError ? ` (HTTP ${error.status})` : '';
      throw new Error(`OneDrive folder verification failed${status}. Run "cv-auto config" to check the target folder, Microsoft login and Files.ReadWrite permission; verify OneDrive storage/quota and network access. If cleanup failed, remove the .cv-auto-check- folder.`);
    }
  }
}
