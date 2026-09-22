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

/**
 * Complete immutable SHA-1 git object id used as the run-wide vertical base.
 * Fixture value shaped like `git rev-parse HEAD` output; not a real commit.
 */
export const FULL_BASE_SHA = '0123456789abcdef0123456789abcdef01234567';

export function fixtureConfig(): CatalogConfig {
  const config = defaultCatalogConfig(
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
  return {
    ...config,
    roles: config.roles,
    routes: [...config.routes, { roleId: 'planner', defaultProfile: PROFILE_FAST, allowedProfiles: [PROFILE_FAST] }],
  };
}
