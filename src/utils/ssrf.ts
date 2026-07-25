import { URL } from 'url';
import { parseBoolEnv, optionalEnv } from '../config/env';

/**
 * SSRF Protection Utility
 *
 * Provides validation to prevent Server-Side Request Forgery (SSRF)
 * by blocking access to private IP ranges, localhost, and metadata endpoints.
 *
 * @security
 * - Default: FAIL CLOSED (unparseable/unknown → unsafe)
 * - In production: private hosts are ALWAYS blocked (ignores SSRF_ALLOW_PRIVATE_HOSTS)
 * - In non-production: set SSRF_ALLOW_PRIVATE_HOSTS=true to allow private hosts
 */

const PRIVATE_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
];

/**
 * Parses a host into a standard IPv4 address, handling:
 * - Decimal/octal/hex encoded IPv4
 * - IPv4-mapped IPv6 (::ffff:127.0.0.1)
 * @returns The parsed IPv4 as four numbers [a, b, c, d], or null if not parsable
 */
/**
 * Strips IPv6 literal decoration so a bare address remains:
 * - a leading `[` and/or trailing `]` (even when unmatched, e.g. `[fd00::`)
 * - a scope/zone identifier (`%eth0`)
 */
function stripIpv6Wrapper(host: string): string {
  let h = host.toLowerCase().trim();
  if (h.startsWith('[')) {
    h = h.slice(1);
  }
  if (h.endsWith(']')) {
    h = h.slice(0, -1);
  }
  const zoneIdx = h.indexOf('%');
  if (zoneIdx !== -1) {
    h = h.slice(0, zoneIdx);
  }
  return h;
}

/**
 * Decodes the compressed-hex form of an IPv4-mapped IPv6 suffix, e.g. the
 * `7f00:1` in `::ffff:7f00:1` (which is 127.0.0.1). Returns null when the input
 * is not exactly two hex groups.
 */
function parseHexMappedIpv4(mapped: string): [number, number, number, number] | null {
  const groups = mapped.split(':').filter((g) => g.length > 0);
  if (groups.length !== 2) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const hi = parseInt(groups[0], 16);
  const lo = parseInt(groups[1], 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function parseIpv4Like(host: string): [number, number, number, number] | null {
  let normalized = stripIpv6Wrapper(host);

  // Strip IPv4-mapped IPv6 prefix
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    // Dotted-quad form (::ffff:127.0.0.1) falls through to the dotted parser
    // below; compressed hex form (::ffff:7f00:1) is decoded here.
    if (!mapped.includes('.')) {
      const octets = parseHexMappedIpv4(mapped);
      if (octets) return octets;
    }
    normalized = mapped;
  } else if (normalized.startsWith('0000:0000:0000:0000:0000:ffff:')) {
    normalized = normalized.slice('0000:0000:0000:0000:0000:ffff:'.length);
  }

  // Try integer representation (e.g., 2130706433 → 127.0.0.1)
  const asInt = Number(normalized);
  if (Number.isFinite(asInt) && Number.isInteger(asInt) && asInt >= 0 && asInt <= 0xffffffff) {
    return [
      (asInt >> 24) & 0xff,
      (asInt >> 16) & 0xff,
      (asInt >> 8) & 0xff,
      asInt & 0xff,
    ];
  }

  // Try dotted notation, handling octal/hex
  const parts = normalized.split('.');
  if (parts.length === 4) {
    const octets = parts.map(part => {
      // Parse with radix detection: 0x → hex, 0 → octal, else decimal
      if (part.startsWith('0x') || part.startsWith('0X')) {
        return parseInt(part, 16);
      }
      if (part.startsWith('0') && part.length > 1) {
        return parseInt(part, 8);
      }
      return parseInt(part, 10);
    });
    if (octets.every(n => Number.isFinite(n) && n >= 0 && n <= 255)) {
      return octets as [number, number, number, number];
    }
  }

  return null;
}

/**
 * Checks if an IPv6 host is private
 */
function isPrivateIpv6(host: string): boolean {
  const noBrackets = stripIpv6Wrapper(host);

  // IPv6 loopback (::1)
  if (noBrackets === '::1' || noBrackets === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return true;
  }

  // IPv6 ULA (fc00::/7)
  if (noBrackets.startsWith('fc') || noBrackets.startsWith('fd')) {
    return true;
  }

  // IPv6 link-local (fe80::/10)
  if (noBrackets.startsWith('fe8') || noBrackets.startsWith('fe9') ||
      noBrackets.startsWith('fea') || noBrackets.startsWith('feb')) {
    return true;
  }

  return false;
}

/**
 * Checks if an IPv4 octet tuple is private
 */
function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;

  // 127.0.0.0/8
  if (a === 127) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local / metadata)
  if (a === 169 && b === 254) return true;

  return false;
}

/**
 * Checks if a hostname or IP address is considered "private" or "internal".
 *
 * @param host - The hostname or IP to check
 * @returns true if the host is private, false otherwise
 */
export function isPrivateHost(host: string): boolean {
  const normalizedHost = host.toLowerCase().trim();

  if (PRIVATE_HOSTNAMES.includes(normalizedHost)) {
    return true;
  }

  // Check IPv6
  if (isPrivateIpv6(normalizedHost)) {
    return true;
  }

  // Check IPv4-like
  const ipv4 = parseIpv4Like(normalizedHost);
  if (ipv4 && isPrivateIpv4(ipv4)) {
    return true;
  }

  return false;
}

/**
 * Validates a URL string for SSRF safety.
 *
 * @security
 * - In production: always blocks private hosts, regardless of SSRF_ALLOW_PRIVATE_HOSTS
 * - In non-production: blocks private hosts unless SSRF_ALLOW_PRIVATE_HOSTS=true
 * - Fail closed: invalid URLs/unparseable hosts are considered unsafe
 *
 * @param urlString - The URL to validate
 * @returns true if the URL is safe, false if it points to a private/internal resource
 */
export function isSafeUrl(urlString: string): boolean {
  const nodeEnv = optionalEnv('NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const allowPrivateHosts = parseBoolEnv('SSRF_ALLOW_PRIVATE_HOSTS', false);

  // In production: never allow private hosts, no exceptions
  if (isProduction) {
    try {
      const url = new URL(urlString);
      const host = url.hostname;

      if (!host) {
        return false;
      }

      return !isPrivateHost(host);
    } catch (_error) {
      return false;
    }
  }

  // Non-production: check if explicit bypass flag is set
  if (allowPrivateHosts) {
    return true;
  }

  // Default: block private hosts (fail closed)
  try {
    const url = new URL(urlString);
    const host = url.hostname;

    if (!host) {
      return false;
    }

    return !isPrivateHost(host);
  } catch (_error) {
    return false;
  }
}
