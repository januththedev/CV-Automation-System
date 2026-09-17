export type FetchLike = typeof globalThis.fetch;
export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class GraphHttpError extends Error {
  constructor(public readonly status: number) { super(`OneDrive request failed (HTTP ${status}).`); }
}

/** The timeout covers both headers and body consumption. Error bodies/URLs are never exposed. */
export async function requestWithRetry(
  fetch: FetchLike, sleep: Sleep, url: string, init: RequestInit, timeoutMs: number,
): Promise<{ status: number; data: any }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let delay = 500 * 2 ** attempt;
    try {
      const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get('Retry-After');
        if (retry !== null) {
          const seconds = Number(retry);
          const parsed = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
          if (Number.isFinite(parsed)) delay = Math.max(0, parsed);
        }
        await response.body?.cancel();
        if (attempt === 3) throw new GraphHttpError(response.status);
      } else {
        if (!response.ok) { await response.body?.cancel(); throw new GraphHttpError(response.status); }
        const text = await response.text();
        let data: unknown = null;
        if (text) {
          try { data = JSON.parse(text); }
          catch { throw new Error('OneDrive returned an invalid JSON response.'); }
        }
        return { status: response.status, data };
      }
    } catch (error) {
      if (error instanceof GraphHttpError) throw error;
      const retryable = controller.signal.aborted || error instanceof TypeError || ['AbortError', 'TimeoutError'].includes((error as Error)?.name);
      if (!retryable) throw new Error('OneDrive returned an invalid response.');
      if (attempt === 3) throw new Error('OneDrive network request failed or timed out. Check connectivity and retry.');
    } finally { clearTimeout(timer); }
    await sleep(delay);
  }
  throw new Error('OneDrive retry limit reached.');
}
