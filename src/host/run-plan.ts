import { validateTaskContract, type ContractIssue, type TaskContract } from '../core/task-contract.ts';
import { deepFreeze, hasExactFields, isPlainObject, ownValue } from '../core/validate.ts';

export interface RunPlan {
  readonly version: 1;
  readonly executionMode: 'single' | 'plan';
  readonly tasks: readonly TaskContract[];
  readonly finalVerification: readonly string[];
}

export type RunPlanErrorCode = 'INVALID_RUN_PLAN';

export class RunPlanValidationError extends Error {
  readonly code = 'INVALID_RUN_PLAN' as const;
  readonly path: string;
  readonly issues: readonly ContractIssue[];
  constructor(path: string, message: string, issues: readonly ContractIssue[] = []) {
    super(message);
    this.name = 'RunPlanValidationError';
    this.path = path;
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

const PLAN_FIELDS = ['version', 'executionMode', 'tasks', 'finalVerification'] as const;
const MODES = ['single', 'plan'] as const;

function issue(path: string, message: string): ContractIssue {
  return { code: 'INVALID_FIELD', path, message };
}

function strings(value: unknown, path: string, minimum: number): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum) throw new RunPlanValidationError(path, `${path} must contain at least ${minimum} non-empty string(s)`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) < value.length) continue;
    throw new RunPlanValidationError(path, `${path} has an unknown array property`);
  }
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index) || typeof value[index] !== 'string' || value[index].trim().length === 0) throw new RunPlanValidationError(`${path}[${index}]`, `${path}[${index}] must be a non-empty string`);
  return [...value] as string[];
}

function cycle(tasks: readonly TaskContract[]): readonly string[] | undefined {
  const graph = new Map(tasks.map((task) => [task.id, task.depends_on]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): readonly string[] | undefined => {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (visited.has(id)) return undefined;
    visiting.add(id); path.push(id);
    for (const dependency of graph.get(id) ?? []) {
      const found = visit(dependency);
      if (found !== undefined) return found;
    }
    path.pop(); visiting.delete(id); visited.add(id);
    return undefined;
  };
  for (const task of tasks) {
    const found = visit(task.id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Strict, frozen boundary for LLM-produced plans and explicit plan files. */
export function validateRunPlan(input: unknown): RunPlan {
  if (!isPlainObject(input)) throw new RunPlanValidationError('plan', 'run plan must be a plain object');
  if (!hasExactFields(input, PLAN_FIELDS)) throw new RunPlanValidationError('plan', 'run plan has unknown fields', [issue('plan', 'run plan must contain only version, executionMode, tasks, finalVerification')]);
  if (ownValue(input, 'version') !== 1) throw new RunPlanValidationError('plan.version', 'plan.version must be 1');
  const executionMode = ownValue(input, 'executionMode');
  if (!MODES.includes(executionMode as (typeof MODES)[number])) throw new RunPlanValidationError('plan.executionMode', 'executionMode must be single or plan');
  const rawTasks = ownValue(input, 'tasks');
  if (!Array.isArray(rawTasks) || rawTasks.length < 1 || rawTasks.length > 3) throw new RunPlanValidationError('plan.tasks', 'tasks must contain 1 to 3 tasks');
  for (const key of Reflect.ownKeys(rawTasks)) {
    if (key === 'length') continue;
    if (typeof key === 'string' && /^\d+$/.test(key) && Number(key) < rawTasks.length) continue;
    throw new RunPlanValidationError('plan.tasks', 'tasks has an unknown array property');
  }
  const tasks: TaskContract[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < rawTasks.length; index++) {
    const result = validateTaskContract(rawTasks[index]);
    if (!result.ok) throw new RunPlanValidationError(`plan.tasks[${index}]`, result.error.message, result.error.issues);
    if (ids.has(result.contract.id)) throw new RunPlanValidationError(`plan.tasks[${index}].id`, `duplicate task id "${result.contract.id}"`);
    ids.add(result.contract.id); tasks.push(result.contract);
  }
  if (executionMode === 'single' && tasks.length !== 1) throw new RunPlanValidationError('plan.tasks', 'single executionMode requires exactly one task');
  if (executionMode === 'plan' && (tasks.length < 2 || tasks.length > 3)) throw new RunPlanValidationError('plan.tasks', 'plan executionMode requires 2 to 3 tasks');
  for (const [index, task] of tasks.entries()) {
    for (const dependency of task.depends_on) {
      if (!ids.has(dependency)) throw new RunPlanValidationError(`plan.tasks[${index}].depends_on`, `unknown dependency "${dependency}"`);
    }
  }
  const foundCycle = cycle(tasks);
  if (foundCycle !== undefined) throw new RunPlanValidationError('plan.tasks', `task dependencies contain a cycle: ${foundCycle.join(' -> ')}`);
  const finalVerification = strings(ownValue(input, 'finalVerification'), 'plan.finalVerification', 1);
  return deepFreeze({ version: 1, executionMode: executionMode as RunPlan['executionMode'], tasks, finalVerification });
}

export interface PlannerPromptInput {
  readonly userTask: string;
  readonly repoRoot: string;
  readonly baseRevision: string;
  readonly authorizedVerificationCommands: readonly string[];
  readonly feedback?: string;
}

/** Deterministic prompt; the planner decides semantic decomposition, not rules. */
export function buildPlannerPrompt(input: PlannerPromptInput): string {
  const feedback = input.feedback === undefined ? '' : `\nPrevious structural error (fix only this): ${input.feedback}`;
  return [
    'You are the semantic LLM planner for an agent-orchestrator run.',
    'First perform read-only inspection of the repository. Do not edit files, run mutation commands, or delegate work.',
    `User task: ${input.userTask}`,
    `Repository: ${input.repoRoot}`,
    `Base revision: ${input.baseRevision}`,
    `Host verificationAllowlist (choose task verification and finalVerification entries exactly from this JSON list): ${JSON.stringify(input.authorizedVerificationCommands)}`,
    'Choose objective, task decomposition, dependency edges, minimal files_in_scope, acceptance_criteria, and task verification commands.',
    'The coordinator will deterministically validate, schedule, verify, review, and integrate your plan.',
    'Output exact JSON only, with no markdown or commentary, matching: {"version":1,"executionMode":"single"|"plan","tasks":[TaskContract],"finalVerification":[string]}.',
    'Do not add fields. Use executionMode single for one task and plan for 2-3 tasks. verification entries are task-level commands.',
    'TaskContract fields are exactly: id, objective, depends_on, files_in_scope, acceptance_criteria, verification, and optional retry (with max_attempts). Every task must have a unique T-prefixed id, non-empty objective and acceptance_criteria, valid dependency IDs, and 1-3 total tasks. tasks[].verification and finalVerification may contain only exact strings from the host verificationAllowlist.',
    feedback,
  ].join('\n');
}
