import type { CatalogConfig } from '../src/core/contracts.ts';
import { defaultCatalogConfig } from '../src/core/defaults.ts';

/** Fixture model profiles. Opaque IDs only — no credentials, no real accounts. */
export const PROFILE_FAST = 'profile-fast';
export const PROFILE_SLASH = 'profile-slash-free';

/**
 * Model ID with slashes and a colon, kept intact end to end.
 * Fixture string; not a claim about any real provider account.
 */
export const SLASH_MODEL_ID = 'nex-agi/nex-n2.5-pro:free';

export function fixtureConfig(): CatalogConfig {
  return defaultCatalogConfig(
    [
      { id: PROFILE_FAST, provider: 'fixture-provider', model: 'fixture-fast-small' },
      { id: PROFILE_SLASH, provider: 'fixture-provider', model: SLASH_MODEL_ID },
    ],
    [
      { roleId: 'explorer', defaultProfile: PROFILE_FAST, allowedProfiles: [PROFILE_FAST, PROFILE_SLASH] },
      { roleId: 'implementer', defaultProfile: PROFILE_SLASH, allowedProfiles: [PROFILE_FAST, PROFILE_SLASH] },
      { roleId: 'reviewer', defaultProfile: PROFILE_FAST, allowedProfiles: [PROFILE_FAST] },
    ],
  );
}
