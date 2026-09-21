import { describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { assertPublicHttpUrl } from '../url-guard.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'resolves-private.example') return [{ address: '192.168.1.1', family: 4 }];
    if (host === 'resolves-loopback.example') return [{ address: '127.0.0.1', family: 4 }];
    if (host === 'unresolvable.example') return [];
    return [{ address: '93.184.216.34', family: 4 }];
  }),
}));

describe('assertPublicHttpUrl SSRF guard', () => {
  it.each([
    'https://example.com/cv.pdf',
    'http://example.com/file',
    'https://93.184.216.34/x',
    'http://8.8.8.8/health',
  ])('accepts public http(s) URL: %s', async (raw) => {
    await expect(assertPublicHttpUrl(raw)).resolves.toBeInstanceOf(URL);
  });

  it.each([
    'ftp://example.com/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
  ])('rejects non-http(s) URL: %s', async (raw) => {
    await expect(assertPublicHttpUrl(raw)).rejects.toThrow(/http/);
  });

  it('rejects URLs with embedded credentials', async () => {
    await expect(assertPublicHttpUrl('https://user:secret@example.com/x')).rejects.toThrow(/credentials/);
  });

  it.each([
    'https://localhost/x',
    'https://api.localhost/x',
    'https://box.local/x',
    'http://127.0.0.1/x',
    'http://127.8.9.10/x',
    'http://10.0.0.5/x',
    'http://172.16.0.1/x',
    'http://172.31.255.255/x',
    'http://192.168.1.1/x',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/x',
    'http://100.64.0.1/x',
    'http://224.0.0.1/x',
    'http://255.255.255.255/x',
    'https://[::1]/x',
    'https://[::]/x',
    'https://[fc00::1]/x',
    'https://[fd12:3456::1]/x',
    'https://[fe80::1]/x',
    'https://[2001:db8::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[::ffff:10.0.0.1]/x',
  ])('rejects non-public host: %s', async (raw) => {
    await expect(assertPublicHttpUrl(raw)).rejects.toThrow(/public|did not resolve/);
  });

  it('rejects hostnames whose DNS answer is non-public or empty', async () => {
    await expect(assertPublicHttpUrl('https://resolves-private.example/x')).rejects.toThrow(/non-public/);
    await expect(assertPublicHttpUrl('https://resolves-loopback.example/x')).rejects.toThrow(/non-public/);
    await expect(assertPublicHttpUrl('https://unresolvable.example/x')).rejects.toThrow(/did not resolve/);
  });

  it('resolves public hostnames before allowing the request', async () => {
    await expect(assertPublicHttpUrl('https://example.com/x')).resolves.toBeInstanceOf(URL);
    expect(lookup).toHaveBeenCalledWith('example.com', { all: true });
  });
});
