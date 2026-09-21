import type {
  Catalog,
  DispatchPlan,
  PreflightErrorCode,
  PreflightResult,
  RoleDefinition,
  TaskRequest,
} from './contracts.ts';
import {
  asNonEmptyString,
  deepFreeze,
  hasExactFields,
  isPlainObject,
  ownValue,
  truncateForMessage,
} from './validate.ts';

const REQUEST_FIELDS = ['description', 'instructions', 'roleId', 'modelProfileId'] as const;

function failure(
  code: PreflightErrorCode,
  message: string,
  available: readonly string[],
): PreflightResult {
  return { ok: false, error: { code, message, available: Object.freeze([...available]) } };
}

function invalidRequest(message: string): PreflightResult {
  return failure('INVALID_REQUEST', message, []);
}

function requireStringField(
  request: Record<string, unknown>,
  field: string,
  problems: string[],
): string | undefined {
  const value = asNonEmptyString(ownValue(request, field));
  if (value === undefined) {
    problems.push(`request.${field} must be a non-empty string`);
    return undefined;
  }
  return value;
}

/**
 * Validates an unknown task request against a catalog and returns a frozen,
 * side-effect-free DispatchPlan. This is preflight only: it proves nothing
 * about model availability, credentials, or the environment, and it does not
 * authorize or perform any execution.
 *
 * Fails closed: unknown fields (e.g. `allowed_tools`, `command`), missing or
 * empty strings, hallucinated roles, coordinator-as-worker delegation, and
 * unknown vs. not-allowed model profiles are distinct structured errors.
 */
export function planDispatch(catalog: Catalog, request: unknown): PreflightResult {
  if (!isPlainObject(request)) return invalidRequest('request must be a JSON object');
  if (!hasExactFields(request, REQUEST_FIELDS)) {
    const unknown = Object.keys(request).filter(
      (key) => !(REQUEST_FIELDS as readonly string[]).includes(key),
    );
    return invalidRequest(`unknown field(s): ${truncateForMessage(unknown.join(', '))}`);
  }

  const problems: string[] = [];
  const description = requireStringField(request, 'description', problems);
  const instructions = requireStringField(request, 'instructions', problems);
  const roleId = requireStringField(request, 'roleId', problems);

  let modelProfileId: string | undefined;
  const rawOverride = ownValue(request, 'modelProfileId');
  if (rawOverride !== undefined) {
    const value = asNonEmptyString(rawOverride);
    if (value === undefined) {
      problems.push('request.modelProfileId must be a non-empty string');
    } else {
      modelProfileId = value;
    }
  }

  if (problems.length > 0 || description === undefined || instructions === undefined || roleId === undefined) {
    return invalidRequest(problems.join('; ') || 'request is invalid');
  }

  const role: RoleDefinition | undefined = catalog.getRole(roleId);
  if (role === undefined) {
    return failure('UNKNOWN_ROLE', `unknown role "${truncateForMessage(roleId)}"`, catalog.roleIds);
  }
  if (role.kind === 'coordinator') {
    return failure(
      'ROLE_NOT_DELEGATABLE',
      `role "${truncateForMessage(roleId)}" is the coordinator and cannot receive delegated tasks`,
      catalog.workerRoleIds,
    );
  }

  const route = catalog.getRoute(roleId);
  const task: TaskRequest =
    modelProfileId === undefined
      ? { description, instructions, roleId }
      : { description, instructions, roleId, modelProfileId };

  if (modelProfileId === undefined) {
    const model = catalog.getModelProfile(route.defaultProfile);
    if (model === undefined) {
      // Unreachable for a validated catalog; kept as a fail-closed guard.
      return failure('UNKNOWN_MODEL_PROFILE', `default profile "${truncateForMessage(route.defaultProfile)}" is not registered`, catalog.modelProfileIds);
    }
    const plan: DispatchPlan = { task, role, model, routingReason: 'role-default' };
    return { ok: true, plan: deepFreeze(plan) };
  }

  const model = catalog.getModelProfile(modelProfileId);
  if (model === undefined) {
    return failure(
      'UNKNOWN_MODEL_PROFILE',
      `unknown model profile "${truncateForMessage(modelProfileId)}"`,
      catalog.modelProfileIds,
    );
  }
  if (!route.allowedProfiles.includes(modelProfileId)) {
    return failure(
      'MODEL_PROFILE_NOT_ALLOWED',
      `model profile "${truncateForMessage(modelProfileId)}" is not allowed for role "${truncateForMessage(roleId)}"`,
      route.allowedProfiles,
    );
  }
  const plan: DispatchPlan = { task, role, model, routingReason: 'task-override' };
  return { ok: true, plan: deepFreeze(plan) };
}
