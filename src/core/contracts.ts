/**
 * Core contracts for the orchestration catalog and dispatch preflight.
 *
 * These types describe policy data only. Declared tools are NOT an enforced
 * sandbox; runtime enforcement belongs to a future executor layer.
 */

export type RoleKind = 'coordinator' | 'worker';

export interface RoleDefinition {
  readonly id: string;
  readonly description: string;
  readonly kind: RoleKind;
  /** Declared capabilities; an executor must enforce these independently. */
  readonly tools: readonly string[];
}

export interface ModelProfile {
  readonly id: string;
  /** Kept separate from `model`: provider is the routing namespace, not part of the model ID. */
  readonly provider: string;
  /** Opaque model ID; slashes and colons (e.g. `nex-agi/nex-n2.5-pro:free`) are never split. */
  readonly model: string;
}

export interface ModelRoute {
  readonly roleId: string;
  readonly defaultProfile: string;
  readonly allowedProfiles: readonly string[];
}

export interface CatalogConfig {
  readonly roles: readonly RoleDefinition[];
  readonly models: readonly ModelProfile[];
  readonly routes: readonly ModelRoute[];
}

export interface TaskRequest {
  readonly description: string;
  readonly instructions: string;
  readonly roleId: string;
  readonly modelProfileId?: string;
}

/** A side-effect-free proposal, not proof of environment/model readiness or authorization to execute. */
export interface DispatchPlan {
  readonly task: TaskRequest;
  readonly role: RoleDefinition;
  readonly model: ModelProfile;
  readonly routingReason: 'role-default' | 'task-override';
}

/** Query surface over a validated, immutable catalog. */
export interface Catalog {
  readonly roleIds: readonly string[];
  readonly modelProfileIds: readonly string[];
  readonly workerRoleIds: readonly string[];
  getRole(id: string): RoleDefinition | undefined;
  getModelProfile(id: string): ModelProfile | undefined;
  /**
   * Route for a role. Mandatory only for worker roles (enforced at
   * construction); the coordinator may legitimately have none, so this
   * throws CatalogConfigError instead of returning undefined.
   */
  getRoute(roleId: string): ModelRoute;
  /** Deeply frozen snapshot of the validated configuration. */
  snapshot(): CatalogConfig;
}

export type CatalogConfigErrorCode =
  | 'INVALID_CONFIG'
  | 'EMPTY_ID'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_REFERENCE'
  | 'DEFAULT_NOT_ALLOWED';

/** Thrown when a catalog configuration is rejected at construction time. */
export interface CatalogConfigErrorData {
  readonly code: CatalogConfigErrorCode;
  readonly message: string;
  /** Location in the input config, e.g. `routes[1].defaultProfile`. */
  readonly path: string;
}

export type PreflightErrorCode =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_ROLE'
  | 'ROLE_NOT_DELEGATABLE'
  | 'UNKNOWN_MODEL_PROFILE'
  | 'MODEL_PROFILE_NOT_ALLOWED';

export type PreflightResult =
  | { readonly ok: true; readonly plan: DispatchPlan }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: PreflightErrorCode;
        readonly message: string;
        /** Relevant selectable IDs for recovery (e.g. known role IDs); empty for INVALID_REQUEST. */
        readonly available: readonly string[];
      };
    };
