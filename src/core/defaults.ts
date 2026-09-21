import type { CatalogConfig, ModelProfile, ModelRoute, RoleDefinition } from './contracts.ts';

/**
 * Default role declarations. Tool names are policy data for a future
 * executor, NOT an enforced sandbox. The coordinator declares only
 * orchestration/evidence tools — no shell, edit, write, or terminal control.
 * Model profiles are intentionally NOT defined here: they are deployment
 * fixtures, never hardcoded accounts.
 */

export const COORDINATOR_ROLE_ID = 'coordinator';
export const EXPLORER_ROLE_ID = 'explorer';
export const IMPLEMENTER_ROLE_ID = 'implementer';
export const REVIEWER_ROLE_ID = 'reviewer';

export const DEFAULT_ROLES: readonly RoleDefinition[] = [
  {
    id: COORDINATOR_ROLE_ID,
    kind: 'coordinator',
    description: 'Plans tasks, delegates to worker roles, and inspects returned evidence. Never writes code itself.',
    tools: ['orchestrator.plan', 'orchestrator.delegate', 'orchestrator.inspectEvidence'],
  },
  {
    id: EXPLORER_ROLE_ID,
    kind: 'worker',
    description: 'Read-only codebase exploration: locate symbols, summarize structure, answer questions with file references.',
    tools: ['fs.read', 'code.search'],
  },
  {
    id: IMPLEMENTER_ROLE_ID,
    kind: 'worker',
    description: 'Implements a scoped change inside an assigned workspace and reports the artifact revision it produced.',
    tools: ['fs.read', 'fs.write', 'code.edit'],
  },
  {
    id: REVIEWER_ROLE_ID,
    kind: 'worker',
    description: 'Reviews a specific artifact revision against the task description and returns structured findings.',
    tools: ['fs.read', 'diff.read', 'evidence.report'],
  },
];

/** Pairs the default roles with caller-supplied models and routes. */
export function defaultCatalogConfig(
  models: readonly ModelProfile[],
  routes: readonly ModelRoute[],
): CatalogConfig {
  return { roles: DEFAULT_ROLES, models, routes };
}
