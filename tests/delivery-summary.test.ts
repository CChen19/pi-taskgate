/**
 * Offline regressions for the read-only delivery summary: every board is
 * driven through persisted events and replayed exactly like a restored
 * session. No git, no hosts, no network, no real models — the ports that
 * would touch the world are stubs and the summary itself only reads the board.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkspaceLease } from '../src/adapters/worktree-manager.ts';
import type { TaskContract } from '../src/core/task-contract.ts';
import type { IntegrationInput, TaskEvent } from '../src/orchestration/task-board.ts';
import { deliverySummary } from '../src/orchestration/delivery-summary.ts';
import { TaskService, type TaskServicePorts } from '../src/orchestration/task-service.ts';
import { createAgentOrchestratorExtension, type PiExtensionApi, type PiToolDefinition } from '../src/pi-extension/index.ts';

const BASE = '0'.repeat(40);
/** Distinct full object ids with distinct 12-char prefixes: hex(1) = 100...0. */
const hex = (n: number): string => n.toString(16).padEnd(40, '0');
const asContract = (raw: Record<string, unknown>): TaskContract => raw as unknown as TaskContract;

function contract(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, objective: `do ${id}`, depends_on: [], files_in_scope: ['src/'], acceptance_criteria: [`${id} works`], verification: ['make test'], retry: { max_attempts: 2 }, ...overrides };
}

function lease(taskId: string): WorkspaceLease {
  return { taskId, attemptId: `${taskId}:attempt-1`, baseRevision: BASE, workspacePath: `/ws/${taskId.toLowerCase()}`, branch: `ao/${taskId.toLowerCase()}`, ownershipToken: `${taskId}:token`, managedMarker: `agent-orchestrator:s8:${taskId}:token` };
}

function evidence(taskId: string, revision: string) {
  return { taskId, attemptId: `${taskId}:attempt-1`, artifactRevision: revision, commands: [{ command: 'make test', cwd: '/clean', timeoutMs: 1000 }], outcomes: [{ exitCode: 0, durationMs: 12, timedOut: false }], startedAt: 1, endedAt: 2 };
}

function candidate(taskId: string, revision: string) {
  return { revision, changedPaths: ['src/a.txt'], evidence: evidence(taskId, revision), verdict: { verdict: 'passed' as const, artifactRevision: revision, reasons: [] } };
}

/** Events that take a READY `taskId` to VERIFYING with a settled candidate at `revision`. */
function toCandidateEvents(taskId: string, revision: string, at: number): TaskEvent[] {
  const attemptId = `${taskId}:attempt-1`;
  return [
    { v: 1, type: 'start', at, taskId, attemptId, lease: lease(taskId) },
    { v: 1, type: 'bind', at: at + 1, taskId, attemptId, agentId: `w:${taskId}` },
    { v: 1, type: 'settle', at: at + 2, taskId, attemptId, candidate: candidate(taskId, revision) },
  ];
}

/** Events that take a VERIFYING task to PASSED through a fresh review bound to `revision`. */
function reviewedEvents(taskId: string, revision: string, at: number): TaskEvent[] {
  const attemptId = `${taskId}:attempt-1`;
  return [
    { v: 1, type: 'review_requested', at, taskId, attemptId, reviewId: `rev-${taskId}`, revision },
    { v: 1, type: 'verdict', at: at + 1, taskId, attemptId, verdict: 'passed', source: 'review', reasons: [], reviewerAgentId: `r:${taskId}`, review: { outcome: 'passed', reasons: [], artifactRevision: revision } },
  ];
}

interface PlannedTask {
  readonly contract: Record<string, unknown>;
  readonly reviewRequired: boolean;
  readonly integration?: { readonly baseRevision: string; readonly inputs: readonly IntegrationInput[] };
}

function planEvent(tasks: readonly PlannedTask[]): TaskEvent {
  return { v: 1, type: 'plan', at: 1, tasks: tasks as unknown as readonly { contract: TaskContract; reviewRequired: boolean; integration?: { readonly baseRevision: string; readonly inputs: readonly IntegrationInput[] } }[] };
}

/** Rebuild a service from events exactly like a restored Pi session; only board reads happen afterwards. */
function serviceWith(events: readonly TaskEvent[]): TaskService {
  const ports = { worktrees: { adoptLease: (_port: unknown, adopted: WorkspaceLease) => adopted } } as unknown as TaskServicePorts;
  const svc = new TaskService(ports, { verificationAllowlist: ['make test'], verificationTimeoutMs: 1000, reviewerRole: 'reviewer-readonly', maxChecksPerAttempt: 3, defaultMaxAttempts: 2, sharedPaths: [], rejectTestAsserts: false });
  svc.restore(events);
  return svc;
}

/** A reviewed, passed, single task at `revision`. */
function singleReviewedTask(revision = hex(1)): TaskEvent[] {
  return [planEvent([{ contract: contract('T1'), reviewRequired: true }]), ...toCandidateEvents('T1', revision, 2), ...reviewedEvents('T1', revision, 5)];
}

function inputRecord(taskId: string, revision: string, baseRevision: string, source = 'this session'): IntegrationInput {
  return { taskId, revision, baseRevision, commits: [hex(90)], source, implementerAgentIds: [`w:${taskId}`], reviewerAgentId: `r:${taskId}`, reviewId: `rev-${taskId}` };
}

/** Integrate `inputs` (in order) onto BASE as task Tint-1, ending PASSED at `integratedRevision`. */
function integrationEvents(inputs: readonly { taskId: string; revision: string; baseRevision: string }[], integratedRevision: string): TaskEvent[] {
  const planned: PlannedTask[] = inputs.map((input) => ({ contract: contract(input.taskId), reviewRequired: true }));
  planned.push({
    contract: contract('Tint-1'),
    reviewRequired: true,
    integration: { baseRevision: BASE, inputs: inputs.map((input) => inputRecord(input.taskId, input.revision, input.baseRevision)) },
  });
  return [
    planEvent(planned),
    ...inputs.flatMap((input, index) => [...toCandidateEvents(input.taskId, input.revision, 2 + index * 10), ...reviewedEvents(input.taskId, input.revision, 5 + index * 10)]),
    ...toCandidateEvents('Tint-1', integratedRevision, 60),
    ...reviewedEvents('Tint-1', integratedRevision, 63),
  ];
}

function fakePi() {
  const tools = new Map<string, PiToolDefinition>();
  const api: PiExtensionApi = {
    registerTool: (definition) => { tools.set(definition.name, definition); },
    appendEntry: () => undefined,
    on: () => undefined,
  };
  return { tools, api };
}

describe('delivery summary', () => {
  it('reports an empty board without a deliverable and answers repeated queries identically (read-only)', () => {
    const svc = serviceWith([]);
    const first = svc.deliverySummary();
    assert.equal(first.deliverable, undefined);
    assert.equal(first.coverage.total, 0);
    assert.equal(first.coverage.complete, false);
    assert.deepEqual(first.notes, []);
    assert.match(first.text, /deliverable: none \(no tasks planned\)/);
    assert.match(first.text, /no planned tasks on the board/);
    assert.deepEqual(svc.deliverySummary(), first, 'repeated queries are pure');
    assert.deepEqual(svc.deliverable(), { reason: 'no tasks planned', notIncluded: [] }, 'the DELIVERABLE selection is unchanged');
  });

  it('reports no deliverable with every planned task omitted and its state shown', () => {
    const svc = serviceWith([planEvent([{ contract: contract('T1'), reviewRequired: true }, { contract: contract('T2'), reviewRequired: false }])]);
    const summary = svc.deliverySummary();
    assert.equal(summary.deliverable, undefined);
    assert.equal(summary.coverage.total, 2);
    assert.deepEqual(summary.coverage.included, []);
    assert.equal(summary.coverage.complete, false);
    assert.deepEqual(summary.coverage.omitted.map((task) => `${task.taskId} ${task.state}`).sort(), ['T1 READY', 'T2 READY']);
    assert.match(summary.text, /deliverable: none/);
    assert.match(summary.text, /coverage: partial — 0\/2 planned task\(s\) included/);
  });

  it('treats missing or mismatched verification evidence as not bound and unknown, never passed', () => {
    const revision = hex(1);
    const good = { taskId: 'T1', attemptId: 'T1:attempt-1', artifactRevision: revision, commands: [{ command: 'make test', cwd: '/clean', timeoutMs: 1000 }], outcomes: [{ exitCode: 0, durationMs: 12, timedOut: false }], startedAt: 1, endedAt: 2 };
    const variants: Record<string, unknown>[] = [
      { ...candidate('T1', revision), evidence: undefined },
      { ...candidate('T1', revision), evidence: { ...good, artifactRevision: hex(9) } },
      { ...candidate('T1', revision), evidence: { ...good, attemptId: 'T1:attempt-9' } },
      { ...candidate('T1', revision), evidence: { ...good, taskId: 'T0' } },
    ];
    for (const [name, record] of variants.entries()) {
      const events: TaskEvent[] = [
        planEvent([{ contract: contract('T1'), reviewRequired: true }]),
        { v: 1, type: 'start', at: 2, taskId: 'T1', attemptId: 'T1:attempt-1', lease: lease('T1') },
        { v: 1, type: 'bind', at: 3, taskId: 'T1', attemptId: 'T1:attempt-1', agentId: 'w:T1' },
        { v: 1, type: 'settle', at: 4, taskId: 'T1', attemptId: 'T1:attempt-1', candidate: record } as unknown as TaskEvent,
        ...reviewedEvents('T1', revision, 5),
      ];
      const summary = serviceWith(events).deliverySummary();
      const verification = summary.deliverable?.verification;
      assert.equal(verification?.bound, false, `variant ${name}: bound`);
      assert.equal(verification?.verdict, 'unknown', `variant ${name}: verdict`);
      assert.equal(verification?.revision, undefined, `variant ${name}: revision`);
      assert.deepEqual(verification?.commands, [], `variant ${name}: commands`);
      assert.doesNotMatch(summary.text, /verification: passed/);
      assert.match(summary.text, /verification: not available \(no evidence bound to the delivered revision\)/);
    }
  });

  it('shows verification and review evidence for a reviewed single task, bound to the delivered revision', () => {
    const revision = hex(1);
    const svc = serviceWith(singleReviewedTask(revision));
    assert.deepEqual(svc.deliverable(), { taskId: 'T1', revision, notIncluded: [] });
    const summary = svc.deliverySummary();
    assert.equal(summary.deliverable?.kind, 'task');
    assert.equal(summary.deliverable?.verification.bound, true);
    assert.equal(summary.deliverable?.verification.verdict, 'passed');
    assert.deepEqual(summary.deliverable?.verification.commands, [{ command: 'make test', exitCode: 0, timedOut: false, durationMs: 12 }]);
    assert.equal(summary.deliverable?.review.required, true);
    assert.equal(summary.deliverable?.review.status, 'passed');
    assert.equal(summary.deliverable?.review.reviewerAgentId, 'r:T1');
    assert.equal(summary.deliverable?.review.reviewId, 'rev-T1');
    assert.equal(summary.deliverable?.review.revision, revision);
    assert.deepEqual(summary.coverage, { complete: true, total: 1, included: ['T1'], omitted: [], omittedCount: 0 });
    assert.match(summary.text, new RegExp(`verification: passed @${revision.slice(0, 12)}`));
    assert.match(summary.text, /review: passed \(reviewer r:T1, review rev-T1, bound to /);
    assert.match(summary.text, /coverage: complete — 1\/1 planned task\(s\) included/);
  });

  it('shows an explicit review_required:false as not required, never as review passed', () => {
    const revision = hex(2);
    const events: TaskEvent[] = [planEvent([{ contract: contract('T1'), reviewRequired: false }]), ...toCandidateEvents('T1', revision, 2), { v: 1, type: 'verdict', at: 5, taskId: 'T1', attemptId: 'T1:attempt-1', verdict: 'passed', source: 'mechanical', reasons: [] }];
    const svc = serviceWith(events);
    assert.deepEqual(svc.deliverable(), { taskId: 'T1', revision, notIncluded: [] });
    const summary = svc.deliverySummary();
    assert.equal(summary.deliverable?.review.required, false);
    assert.equal(summary.deliverable?.review.status, 'not-required');
    assert.equal(summary.deliverable?.review.reviewerAgentId, undefined);
    assert.doesNotMatch(summary.text, /review passed/);
    assert.match(summary.text, /review: not required/);
    assert.equal(summary.coverage.complete, true);
  });

  it('covers a complete integration by task id AND accepted revision, and keeps notIncluded compatible', () => {
    const r1 = hex(1);
    const r2 = hex(2);
    const integrated = hex(50);
    const svc = serviceWith(integrationEvents([{ taskId: 'T1', revision: r1, baseRevision: BASE }, { taskId: 'T2', revision: r2, baseRevision: BASE }], integrated));
    assert.equal(svc.task('Tint-1').state, 'PASSED');
    assert.deepEqual(svc.deliverable(), { taskId: 'Tint-1', revision: integrated, notIncluded: [] });
    const summary = svc.deliverySummary();
    assert.equal(summary.deliverable?.kind, 'integration');
    assert.equal(summary.deliverable?.verification.bound, true, 'the integration candidate is the delivered revision');
    assert.deepEqual(summary.deliverable?.inputs?.map((input) => `${input.taskId}${input.stackedOn === undefined ? '' : ` on ${input.stackedOn}`}`), ['T1', 'T2']);
    assert.equal(summary.deliverable?.inputs?.[0]?.evidenceSource, undefined, 'this-session inputs need no source marker');
    assert.deepEqual(summary.coverage, { complete: true, total: 2, included: ['T1', 'T2'], omitted: [], omittedCount: 0 });
    assert.match(summary.text, new RegExp(`deliverable Tint-1 @${integrated.slice(0, 12)} \\(integration of T1@${r1.slice(0, 12)}, T2@${r2.slice(0, 12)}\\)`));
    assert.deepEqual(deliverySummary(svc.status(), svc.deliverable()), summary, 'the pure function and the service method agree');
  });

  it('handles stacked inputs through recorded base revisions without double counting', () => {
    const wire = hex(1);
    const stacked = hex(2);
    const svc = serviceWith(integrationEvents([{ taskId: 'Twire', revision: wire, baseRevision: BASE }, { taskId: 'T2', revision: stacked, baseRevision: wire }], hex(51)));
    const summary = svc.deliverySummary();
    assert.deepEqual(summary.deliverable?.inputs, [
      { taskId: 'Twire', revision: wire },
      { taskId: 'T2', revision: stacked, stackedOn: 'Twire' },
    ], 'stacking comes from the recorded input base revisions');
    assert.deepEqual([...summary.coverage.included].sort(), ['T2', 'Twire']);
    assert.equal(summary.coverage.complete, true, 'a stacked input does not hide its base task');
    assert.ok(!summary.notes.some((note) => /conservatively/.test(note)), JSON.stringify(summary.notes));
  });

  it('reports passed-but-not-integrated tasks as omitted instead of complete', () => {
    const r3 = hex(3);
    const integrated = hex(50);
    const events: TaskEvent[] = [
      ...integrationEvents([{ taskId: 'T1', revision: hex(1), baseRevision: BASE }, { taskId: 'T2', revision: hex(2), baseRevision: BASE }], integrated),
      planEvent([{ contract: contract('T3'), reviewRequired: true }]),
      ...toCandidateEvents('T3', r3, 70),
      ...reviewedEvents('T3', r3, 73),
    ];
    const svc = serviceWith(events);
    assert.deepEqual(svc.deliverable(), { taskId: 'Tint-1', revision: integrated, notIncluded: ['T3'] }, 'legacy notIncluded behavior is unchanged');
    const summary = svc.deliverySummary();
    assert.equal(summary.coverage.complete, false);
    assert.deepEqual(summary.coverage.included, ['T1', 'T2']);
    assert.deepEqual(summary.coverage.omitted, [{ taskId: 'T3', state: 'PASSED', detail: 'PASSED but not included in the deliverable integration' }]);
    assert.match(summary.text, /coverage: partial — 2\/3 planned task\(s\) included; omitted: T3 PASSED \(PASSED but not included in the deliverable integration\)/);
  });

  it('keeps later-added unfinished tasks visible in coverage after a complete integration', () => {
    const events: TaskEvent[] = [...integrationEvents([{ taskId: 'T1', revision: hex(1), baseRevision: BASE }], hex(50)), planEvent([{ contract: contract('T2'), reviewRequired: true }])];
    const svc = serviceWith(events);
    const summary = svc.deliverySummary();
    assert.equal(summary.coverage.complete, false);
    assert.deepEqual(summary.coverage.included, ['T1']);
    assert.deepEqual(summary.coverage.omitted, [{ taskId: 'T2', state: 'READY' }]);
    assert.match(summary.text, /omitted: T2 READY/);
  });

  it('explains failed and cancelled tasks instead of declaring the full plan complete', () => {
    const events: TaskEvent[] = [
      ...integrationEvents([{ taskId: 'T1', revision: hex(1), baseRevision: BASE }], hex(50)),
      planEvent([{ contract: contract('Tfail'), reviewRequired: true }, { contract: contract('Tgone'), reviewRequired: true }]),
      { v: 1, type: 'start', at: 70, taskId: 'Tfail', attemptId: 'Tfail:attempt-1', lease: lease('Tfail') },
      { v: 1, type: 'bind', at: 71, taskId: 'Tfail', attemptId: 'Tfail:attempt-1', agentId: 'w:Tfail' },
      { v: 1, type: 'attempt_failed', at: 74, taskId: 'Tfail', attemptId: 'Tfail:attempt-1', reason: 'review rejected; budget spent', terminal: true },
      { v: 1, type: 'cancel', at: 80, taskId: 'Tgone', reason: 'superseded by the new library' },
    ];
    const svc = serviceWith(events);
    const summary = svc.deliverySummary();
    assert.equal(summary.coverage.complete, false);
    assert.deepEqual(summary.coverage.omitted.map((task) => task.taskId).sort(), ['Tfail', 'Tgone']);
    const cancelled = summary.coverage.omitted.find((task) => task.taskId === 'Tgone');
    assert.equal(cancelled?.state, 'CANCELLED');
    assert.equal(cancelled?.detail, 'superseded by the new library');
    const failed = summary.coverage.omitted.find((task) => task.taskId === 'Tfail');
    assert.equal(failed?.state, 'FAILED');
    assert.match(failed?.detail ?? '', /budget spent/);
    assert.ok(summary.notes.some((note) => /Tgone was cancelled: superseded by the new library; the deliverable does not cover it/.test(note)), JSON.stringify(summary.notes));
    assert.match(summary.text, /Tgone CANCELLED \(superseded by the new library\)/);
  });

  it('stays conservative on identity/revision mismatches and inputs without a board task', () => {
    const accepted = hex(1);
    const recorded = hex(8);
    const integrated = hex(50);
    const planned: PlannedTask[] = [
      { contract: contract('T1'), reviewRequired: true },
      { contract: contract('Tint-1'), reviewRequired: true, integration: { baseRevision: BASE, inputs: [inputRecord('T1', recorded, BASE, '/sessions/old.jsonl'), inputRecord('Tghost', hex(9), BASE)] } },
    ];
    const events: TaskEvent[] = [planEvent(planned), ...toCandidateEvents('T1', accepted, 2), ...reviewedEvents('T1', accepted, 5), ...toCandidateEvents('Tint-1', integrated, 60), ...reviewedEvents('Tint-1', integrated, 63)];
    const svc = serviceWith(events);
    const summary = svc.deliverySummary();
    assert.equal(summary.coverage.complete, false, 'a revision mismatch never counts as included');
    assert.deepEqual(summary.coverage.included, []);
    const mismatch = summary.coverage.omitted.find((task) => task.taskId === 'T1');
    assert.match(mismatch?.detail ?? '', new RegExp(`accepted revision ${accepted.slice(0, 12)} is not the integrated input ${recorded.slice(0, 12)}`));
    assert.ok(summary.notes.some((note) => note.includes('Tghost') && note.includes('has no such task on the current board')), JSON.stringify(summary.notes));
    assert.equal(summary.deliverable?.inputs?.[0]?.evidenceSource, '/sessions/old.jsonl', 'cross-session evidence is surfaced');
  });

  it('flags review evidence that does not refer to the selected revision as a mismatch, not as passed', () => {
    const integrated = hex(50);
    const stale = hex(77);
    const events: TaskEvent[] = integrationEvents([{ taskId: 'T1', revision: hex(1), baseRevision: BASE }], integrated)
      .filter((event) => !(event.type === 'verdict' && event.taskId === 'Tint-1'));
    events.push({ v: 1, type: 'verdict', at: 64, taskId: 'Tint-1', attemptId: 'Tint-1:attempt-1', verdict: 'passed', source: 'review', reasons: [], reviewerAgentId: 'r:legacy', review: { outcome: 'passed', reasons: [], artifactRevision: stale } });
    const svc = serviceWith(events);
    assert.equal(svc.deliverable().revision, integrated, 'the deliverable is the settled candidate');
    const summary = svc.deliverySummary();
    assert.equal(summary.deliverable?.review.status, 'revision-mismatch');
    assert.equal(summary.deliverable?.review.revision, stale, 'the mismatch names the revision the stale verdict was bound to');
    assert.doesNotMatch(summary.text, /review: passed/);
    assert.match(summary.text, new RegExp(`review: evidence refers to ${stale.slice(0, 12)}, not the delivered revision`));
  });

  it('bounds the omitted list and keeps the +N more count over the full omitted total', () => {
    const planned = Array.from({ length: 10 }, (_, index) => ({ contract: contract(`T${index + 1}`), reviewRequired: true }));
    const summary = serviceWith([planEvent(planned)]).deliverySummary();
    assert.equal(summary.coverage.total, 10);
    assert.equal(summary.coverage.omitted.length, 8, 'the structured omitted list stays bounded');
    assert.equal(summary.coverage.omittedCount, 10);
    assert.match(summary.text, /coverage: partial — 0\/10 planned task\(s\) included/);
    assert.match(summary.text, /T8 READY, \+2 more$/m);
  });

  it('bounds the rendered integration input list', () => {
    const inputs = Array.from({ length: 9 }, (_, index) => ({ taskId: `T${index + 1}`, revision: hex(index + 1), baseRevision: BASE }));
    const summary = serviceWith(integrationEvents(inputs, hex(50))).deliverySummary();
    assert.equal(summary.coverage.complete, true);
    assert.equal(summary.coverage.total, 9);
    assert.equal(summary.deliverable?.inputs?.length, 9, 'the structured inputs stay complete');
    assert.match(summary.text, new RegExp(`\\(integration of T1@${hex(1).slice(0, 12)}, T2@${hex(2).slice(0, 12)}, .*T8@${hex(8).slice(0, 12)}, \\+1 more\\)`));
    assert.doesNotMatch(summary.text, new RegExp(`T9@${hex(9).slice(0, 12)}`));
  });

  it('keeps global coverage when task_status is filtered to one task', async () => {
    const { tools, api } = fakePi();
    const summary = serviceWith(integrationEvents([{ taskId: 'T1', revision: hex(1), baseRevision: BASE }, { taskId: 'T2', revision: hex(2), baseRevision: BASE }], hex(50))).deliverySummary();
    const view = (id: string) => ({ id, state: 'PASSED' as const, unmetDependencies: [], attemptRecords: [], contract: { objective: `do ${id}` } });
    const fake = {
      restore: () => ({ tasks: 3, leaseErrors: [] }),
      task: (id: string) => view(id),
      status: () => [view('T1'), view('T2'), view('Tint-1')],
      readySet: () => [],
      deliverable: () => ({ taskId: 'Tint-1', revision: hex(50), notIncluded: [] }),
      deliverySummary: () => summary,
    } as unknown as TaskService;
    createAgentOrchestratorExtension({ createService: () => fake })(api);
    const result = await tools.get('task_status')!.execute('c1', { task_id: 'T1' }, undefined, undefined, {});
    const details = result.details as { delivery: typeof summary; deliverable: unknown };
    assert.deepEqual(details.delivery.coverage, summary.coverage, 'the filtered view does not shrink global coverage');
    assert.equal(details.delivery.coverage.total, 2);
    assert.match(result.content[0]!.text, /coverage: complete — 2\/2 planned task\(s\) included/);
    assert.match(result.content[0]!.text, /DELIVERABLE: /);
    assert.match(result.content[0]!.text, /^T1 PASSED/, 'the task list itself stays filtered');
  });
});
