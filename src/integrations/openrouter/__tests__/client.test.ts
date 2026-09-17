import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatJSON, InvalidJSONError, listModels, validateModel } from '../client.js';
import type { OpenRouterConfig } from '../../../contracts.js';

const dummyKey = ['not', 'a', 'credential'].join('-');
const cfg: OpenRouterConfig = { apiKey: dummyKey, model: 'google/gemini-3.8-flash' };
const completion = (content: string, extra = {}) => new Response(JSON.stringify({
  choices: [{ finish_reason: 'stop', message: { content, ...extra } }],
}));
afterEach(() => vi.unstubAllGlobals());

describe('OpenRouter transport (no network)', () => {
  it('sends exact model, JSON format and no tools', async () => {
    const fetch = vi.fn().mockResolvedValue(completion('{"ok":true}'));
    vi.stubGlobal('fetch', fetch);
    expect(await chatJSON('system', 'data', cfg)).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe(cfg.model);
    expect(body.response_format.type).toBe('json_object');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('models');
    expect(body.provider.allow_fallbacks).toBe(false);
  });

  it('retries transient responses, not authentication failures', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(completion('{}'));
    vi.stubGlobal('fetch', fetch);
    expect(await chatJSON('s', 'u', cfg, { retryDelayMs: 0 })).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockReset().mockResolvedValue(new Response('test-secret', { status: 401 }));
    await expect(chatJSON('s', 'u', cfg)).rejects.toThrow('HTTP 401');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed, truncated and tool-call output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completion('```json\n{}\n```')));
    await expect(chatJSON('s', 'u', cfg)).rejects.toBeInstanceOf(InvalidJSONError);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completion('{}', { tool_calls: [{}] })));
    await expect(chatJSON('s', 'u', cfg)).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '{}' } }],
    }))));
    await expect(chatJSON('s', 'u', cfg)).rejects.toThrow();
  });

  it('bounds request, response and elapsed time', async () => {
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    await expect(chatJSON('s', 'x'.repeat(200_001), cfg)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(chatJSON('s', 'u', cfg, { timeoutMs: 10 })).rejects.toThrow(/timeout/i);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completion('x'.repeat(70_000))));
    await expect(chatJSON('s', 'u', cfg)).rejects.toThrow(/large/i);
  });

  it('requires catalog membership and successful structured probe', async () => {
    const fetch = vi.fn().mockImplementation((_url, init) => Promise.resolve(
      init.method === 'GET'
        ? new Response(JSON.stringify({ data: [{ id: cfg.model, name: 'Gemini' }] }))
        : completion('{"ok":true}'),
    ));
    vi.stubGlobal('fetch', fetch);
    expect(await listModels(cfg)).toEqual([{ id: cfg.model, name: 'Gemini' }]);
    expect(await validateModel('missing/model', cfg)).toBe(false);
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
    expect(await validateModel(cfg.model, cfg)).toBe(true);
    const post = fetch.mock.calls.find(([, init]) => init.method === 'POST');
    expect(JSON.parse(post![1].body).response_format.type).toBe('json_schema');
    fetch.mockImplementation((_url, init) => Promise.resolve(init.method === 'GET'
      ? new Response(JSON.stringify({ data: [{ id: cfg.model }] })) : completion('{"ok":"true"}')));
    expect(await validateModel(cfg.model, cfg)).toBe(false);
  });
});
