import { loadConfig } from '../../config.js';
import type { OpenRouterConfig } from '../../contracts.js';
import { assertPublicHttpUrl, isPublicHost } from '../../network/url-guard.js';

export const DEFAULT_MODEL = 'google/gemini-3.8-flash';
const MAX_CHAT_BYTES = 65_536;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export class OpenRouterError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'OpenRouterError';
  }
}
export class InvalidJSONError extends OpenRouterError {
  constructor() { super('OpenRouter returned invalid structured JSON'); this.name = 'InvalidJSONError'; }
}
export interface ChatOptions {
  /** Total deadline across retries and reading response body; hard cap 120s. */
  timeoutMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
  maxTokens?: number;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}
export interface OpenRouterModel { id: string; name?: string }

function config(explicit?: OpenRouterConfig): OpenRouterConfig {
  const cfg = explicit ?? loadConfig().openrouter;
  if (!cfg?.apiKey?.trim()) throw new OpenRouterError('OpenRouter is not configured');
  const model = cfg.model || DEFAULT_MODEL;
  if (model.length > 200 || !/^[\w./:-]+$/.test(model)) throw new OpenRouterError('Invalid model identifier');
  const url = new URL(cfg.baseUrl ?? 'https://openrouter.ai/api/v1');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new OpenRouterError('OpenRouter base URL must be HTTPS without credentials or query');
  }
  // Config-supplied URL: reject loopback/private/reserved literal hosts before
  // any request. The resolving check runs at fetch time via assertPublicHttpUrl.
  if (!isPublicHost(url.hostname)) {
    throw new OpenRouterError('OpenRouter base URL host must be a public address');
  }
  return { ...cfg, model, baseUrl: url.toString().replace(/\/$/, '') };
}
function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new OpenRouterError('Invalid request limits');
  return value;
}
async function boundedJSON(response: Response, limit: number): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > limit) throw new OpenRouterError('OpenRouter response too large');
  if (!response.body) throw new InvalidJSONError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { void reader.cancel().catch(() => {}); throw new OpenRouterError('OpenRouter response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InvalidJSONError(); }
}

async function request(cfg: OpenRouterConfig, route: string, body: unknown, limit: number, options: ChatOptions): Promise<unknown> {
  const timeoutMs = integer(options.timeoutMs, 120_000, 1, 120_000);
  const retries = integer(options.maxRetries, 2, 0, 2);
  const delay = integer(options.retryDelayMs, 500, 0, 5_000);
  // The base URL is configurable: verify the resolved host is public before
  // the API key is ever attached. The error never echoes the URL.
  try { await assertPublicHttpUrl(`${cfg.baseUrl}${route}`); }
  catch { throw new OpenRouterError('OpenRouter endpoint host must resolve to a public address'); }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new OpenRouterError('OpenRouter request timeout')); }, timeoutMs);
  });
  const run = async (): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(`${cfg.baseUrl}${route}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
        });
      } catch { throw new OpenRouterError(controller.signal.aborted ? 'OpenRouter request timeout' : 'OpenRouter network request failed'); }
      if (response.ok) return boundedJSON(response, limit);
      // Never return/log provider bodies: they may contain credentials or CV data.
      void response.body?.cancel().catch(() => {});
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay * 2 ** attempt));
        continue;
      }
      throw new OpenRouterError(`OpenRouter HTTP ${response.status}`, response.status);
    }
  };
  try { return await Promise.race([run(), deadline]); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}

/** No tools, URL retrieval, model fallbacks or model-controlled I/O. */
export async function chatJSON(system: string, user: string, explicitConfig?: OpenRouterConfig, options: ChatOptions = {}): Promise<unknown> {
  if (typeof system !== 'string' || typeof user !== 'string' || system.length > 20_000 || user.length > 200_000) {
    throw new OpenRouterError('OpenRouter input too large or invalid');
  }
  const cfg = config(explicitConfig);
  const data = await request(cfg, '/chat/completions', {
    model: cfg.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: options.jsonSchema
      ? { type: 'json_schema', json_schema: { ...options.jsonSchema, strict: true } }
      : { type: 'json_object' },
    provider: { require_parameters: true, allow_fallbacks: false },
    temperature: 0,
    max_tokens: integer(options.maxTokens, 2_000, 32, 4_000),
    stream: false,
  }, MAX_CHAT_BYTES, options) as { choices?: { finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown; function_call?: unknown; refusal?: unknown } }[] };
  const choice = data?.choices?.[0];
  if (choice?.finish_reason !== 'stop' || !choice.message || choice.message.tool_calls || choice.message.function_call || choice.message.refusal) {
    throw new InvalidJSONError();
  }
  const content = choice.message.content;
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_CHAT_BYTES) throw new InvalidJSONError();
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new InvalidJSONError(); }
}

/** Fetch live catalog on each call; never imply an unavailable default exists. */
export async function listModels(explicitConfig?: OpenRouterConfig, options: ChatOptions = {}): Promise<OpenRouterModel[]> {
  const cfg = config(explicitConfig);
  const result = await request(cfg, '/models', undefined, MAX_CATALOG_BYTES, options) as { data?: unknown };
  if (!Array.isArray(result?.data)) throw new OpenRouterError('Invalid OpenRouter model catalog');
  return result.data.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string' || entry.id.length > 200) {
      throw new OpenRouterError('Invalid OpenRouter model catalog');
    }
    return { id: entry.id, ...('name' in entry && typeof entry.name === 'string' ? { name: entry.name.slice(0, 300) } : {}) };
  });
}

/** Caller must persist a selection ONLY when this returns true. No config writes here. */
export async function validateModel(modelId: string, explicitConfig?: OpenRouterConfig, options: ChatOptions = {}): Promise<boolean> {
  try {
    const cfg = config(explicitConfig);
    if (!(await listModels(cfg, options)).some(({ id }) => id === modelId)) return false;
    const result = await chatJSON('Return exactly the structured JSON object requested. Do not use tools.',
      'Return {"ok":true}.', { ...cfg, model: modelId }, {
        ...options, maxTokens: 128,
        jsonSchema: { name: 'availability_probe', schema: {
          type: 'object', properties: { ok: { type: 'boolean', enum: [true] } }, required: ['ok'], additionalProperties: false,
        } },
      });
    return !!result && typeof result === 'object' && Object.keys(result).length === 1 && (result as { ok?: unknown }).ok === true;
  } catch { return false; }
}
