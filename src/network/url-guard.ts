import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for every server-side outbound request in the appliance.
 *
 * Rules: the URL must be absolute http/https without embedded credentials;
 * the host must not be localhost or a loopback, private, reserved, multicast,
 * unspecified, or documentation address; and every address the hostname
 * resolves to must pass the same checks. Rejecting is fail-closed: callers
 * surface a generic transport error and never echo the URL.
 */

type V4 = [number, number, number, number];

function parseV4(host: string): V4 | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return nums as V4;
}

function isLoopback4([a]: V4): boolean {
  return a === 127;
}

function isPrivate4([a, b]: V4): boolean {
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isReserved4([a, b, c]: V4): boolean {
  return (
    a === 0 ||                                          // 0.0.0.0/8 "this network"
    (a === 100 && b >= 64 && b <= 127) ||               // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) ||                         // 169.254.0.0/16 link-local
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||   // 192.0.0.0/24, 192.0.2.0/24
    (a === 198 && (b === 18 || b === 19)) ||            // 198.18.0.0/15 benchmark
    (a === 198 && b === 51 && c === 100) ||             // 198.51.100.0/24 documentation
    (a === 203 && b === 0 && c === 113) ||              // 203.0.113.0/24 documentation
    a >= 224                                            // multicast + reserved
  );
}

function publicIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return false;                       // unspecified / loopback
  if (h.startsWith('fc') || h.startsWith('fd')) return false;        // fc00::/7 unique-local
  if (/^fe[89ab]/.test(h)) return false;                             // fe80::/10 link-local
  if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return false; // fec0::/10 site-local
  if (h.startsWith('ff')) return false;                              // ff00::/8 multicast
  if (h.startsWith('2001:db8')) return false;                        // documentation
  if (h.startsWith('::ffff:')) {                                     // v4-mapped
    const v4 = parseV4(h.slice(7));
    return v4 !== null && !isLoopback4(v4) && !isPrivate4(v4) && !isReserved4(v4);
  }
  return true;
}

function hostIsPublic(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) {
    const parts = parseV4(host);
    return parts !== null && !isLoopback4(parts) && !isPrivate4(parts) && !isReserved4(parts);
  }
  if (kind === 6) return publicIpv6(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  return true;
}

/**
 * Synchronous classification of a literal host (IP, localhost variants).
 * Hostnames return true here; callers that allow hostnames must additionally
 * run the resolving check in assertPublicHttpUrl before any request.
 */
export function isPublicHost(host: string): boolean {
  return hostIsPublic(host.replace(/^\[|\]$/g, '').toLowerCase());
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Request URL must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Request URL protocol must be http or https');
  }
  if (url.username || url.password) throw new Error('Request URL must not contain credentials');
  // URL.hostname keeps the brackets on IPv6 literals; strip them before the
  // address classification and DNS resolution below.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostIsPublic(host)) throw new Error('Request URL host is not a public address');
  const addresses = await lookup(host, { all: true });
  if (!addresses || addresses.length === 0) throw new Error('Request URL host did not resolve');
  for (const entry of addresses) {
    const kind = isIP(entry.address);
    if (kind === 4) {
      const parts = parseV4(entry.address);
      if (parts === null || isLoopback4(parts) || isPrivate4(parts) || isReserved4(parts)) {
        throw new Error('Request URL resolved to a non-public address');
      }
    } else if (kind === 6) {
      if (!publicIpv6(entry.address)) throw new Error('Request URL resolved to a non-public address');
    } else {
      throw new Error('Request URL host did not resolve to an IP address');
    }
  }
  return url;
}
