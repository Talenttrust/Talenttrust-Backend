/**
 * @module versioning
 * @description API version registry.
 *
 * Defines which versions are supported, deprecated, and their sunset dates.
 * Clients should check the `Deprecation`, `Sunset`, and `Link` response
 * headers to plan upgrades before a version is removed.
 */

export interface VersionConfig {
  /** Whether this version is still accepting requests. */
  supported: boolean;
  /** Whether this version is deprecated (still works, but scheduled for removal). */
  deprecated: boolean;
  /**
   * RFC 7231 date string after which the version will be removed.
   * Only set when `deprecated` is true.
   */
  sunsetDate?: string;
  /** URL pointing to the migration guide for this version. */
  upgradeGuide?: string;
}

/** Central registry of all API versions. */
export const API_VERSIONS: Record<string, VersionConfig> = {
  v1: {
    supported: true,
    deprecated: true,
    sunsetDate: 'Sat, 01 Nov 2026 00:00:00 GMT',
    upgradeGuide: 'https://docs.talenttrust.io/api/migration/v1-to-v2',
  },
  v2: {
    supported: true,
    deprecated: false,
  },
};

/** The current stable version clients should migrate to. */
export const CURRENT_VERSION = 'v2';

/**
 * Returns the config for a given version, or undefined if unknown.
 */
export function getVersionConfig(version: string): VersionConfig | undefined {
  return API_VERSIONS[version];
}
