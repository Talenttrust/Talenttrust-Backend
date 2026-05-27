import { URL } from 'url';

/**
 * SSRF Protection Utility
 * 
 * Provides validation to prevent Server-Side Request Forgery (SSRF) 
 * by blocking access to private IP ranges, localhost, and metadata endpoints.
 */

const PRIVATE_IP_PREFIXES = [
  '127.',      // Loopback
  '10.',       // Private-use
  '172.16.',   // Private-use
  '172.17.',   // Private-use
  '172.18.',   // Private-use
  '172.19.',   // Private-use
  '172.20.',   // Private-use
  '172.21.',   // Private-use
  '172.22.',   // Private-use
  '172.23.',   // Private-use
  '172.24.',   // Private-use
  '172.25.',   // Private-use
  '172.26.',   // Private-use
  '172.27.',   // Private-use
  '172.28.',   // Private-use
  '172.29.',   // Private-use
  '172.30.',   // Private-use
  '172.31.',   // Private-use
  '192.168.',  // Private-use
  '169.254.',  // Link-local / Metadata
];

const PRIVATE_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
];

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

  // Check against private IP prefixes
  return PRIVATE_IP_PREFIXES.some(prefix => normalizedHost.startsWith(prefix));
}

/**
 * Validates a URL string for SSRF safety.
 * 
 * @param urlString - The URL to validate
 * @returns true if the URL is safe, false if it points to a private/internal resource
 */
export function isSafeUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const host = url.hostname;

    if (!host) {
      return false;
    }

    return !isPrivateHost(host);
  } catch (error) {
    // If URL parsing fails, it's not a safe URL
    return false;
  }
}
