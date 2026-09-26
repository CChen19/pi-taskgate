import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkArtifact, findAddedAsserts, isTestSource } from '../src/adapters/artifact-check.ts';
import { PierHistoryLedger, pierPipePath, pierPipeProblem, pierSessionDirName, pierSessionDirNameLegacy } from '../src/host/pier-ledger.ts';
import { WorktreeManager } from '../src/adapters/worktree-manager.ts';
import { GitCleanRoom } from '../src/host/clean-room.ts';
import { checkReadOnlyRole } from '../src/host/pier-roles.ts';
import { parseReviewerOutcome, renderWorkerBrief } from '../src/orchestration/briefs.ts';
import { parseOrchestrationConfig } from '../src/orchestration/config.ts';
import { replayTaskBoard, TaskBoardError, type TaskEvent } from '../src/orchestration/task-board.ts';
import type { TaskService } from '../src/orchestration/task-service.ts';
import { TaskServiceError } from '../src/orchestration/task-service.ts';
import { createAgentOrchestratorExtension, gitWriteBlockReason, readSessionFileEvents, TASK_EVENT_CUSTOM_TYPE, type PiToolDefinition } from '../src/pi-extension/index.ts';

const REV = 'a'.repeat(40);

describe('checkArtifact', () => {
  it('accepts a clean committed in-scope artifact', () => {
    const check = checkArtifact({ changedPaths: ['src/a.ts', 'src/b/c.ts'], artifactRevision: REV, clean: true, commitsAhead: 2 }, ['src/']);
    assert.equal(check.ok, true);
    assert.deepEqual(check.failures, []);
  });

  it('fails closed on dirty, uncommitted, out-of-scope, prefix-confused, and unscoped artifacts', () => {
    assert.deepEqual(checkArtifact({ changedPaths: ['src/a.ts'], artifactRevision: REV, clean: false, commitsAhead: 1 }, ['src/']).failures, ['DIRTY_WORKTREE']);
    assert.deepEqual(checkArtifact({ changedPaths: [], artifactRevision: REV, clean: true, commitsAhead: 0 }, ['src/']).failures, ['NO_COMMITS']);
    assert.deepEqual(checkArtifact({ changedPaths: ['src/a.ts'], artifactRevision: REV }, ['src/']).failures, ['DIRTY_WORKTREE', 'NO_COMMITS'], 'missing inspection facts are failures');
    const prefix = checkArtifact({ changedPaths: ['src/ab.ts'], artifactRevision: REV, clean: true, commitsAhead: 1 }, ['src/a']);
    assert.deepEqual(prefix.violations, ['src/ab.ts']);
    assert.deepEqual(checkArtifact({ changedPaths: ['x'], artifactRevision: REV, clean: true, commitsAhead: 1 }, []).failures, ['INVALID_SCOPE']);
  });
});

describe('added assert() guard', () => {
  const diff = (path: string, ...lines: string[]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${lines.length} @@\n${lines.join('\n')}\n`;

  it('flags assert( on added lines of test sources only', () => {
    assert.deepEqual(findAddedAsserts(diff('tests/test_a.cpp', '+    assert(x == 1);')).map((hit) => hit.path), ['tests/test_a.cpp']);
    assert.equal(findAddedAsserts(diff('test_root.cc', '+assert (ok);')).length, 1);
    assert.equal(findAddedAsserts(diff('src/foo_test.cpp', '+  if (!ok) assert(false);')).length, 1);
    assert.equal(findAddedAsserts(diff('handler/x.cpp', '+    assert(x);')).length, 0, 'production code is out of scope');
    assert.equal(findAddedAsserts(diff('tests/README.md', '+assert(x)')).length, 0, 'non-source files are ignored');
  });

  it('ignores removed lines, context, comments, strings, and static_assert', () => {
    assert.equal(findAddedAsserts(diff('tests/t.cpp', '-    assert(x);', ' assert(y);')).length, 0);
    assert.equal(findAddedAsserts(diff('tests/t.cpp', '+    // assert() compiles out under NDEBUG')).length, 0);
    assert.equal(findAddedAsserts(diff('tests/t.cpp', '+ * assert(x) in a block comment')).length, 0);
    assert.equal(findAddedAsserts(diff('tests/t.cpp', '+    puts("assert(x)");')).length, 0);
    assert.equal(findAddedAsserts(diff('tests/t.cpp', '+static_assert(sizeof(int) == 4, "x");')).length, 0);
    assert.equal(findAddedAsserts(diff('tests/t.cpp', '+my_assert(x);')).length, 0);
    assert.equal(findAddedAsserts(`--- a/tests/t.cpp\n+++ /dev/null\n@@ -1 +0,0 @@\n-assert(x);\n`).length, 0);
  });

  it('classifies test sources', () => {
    assert.equal(isTestSource('tests/test_router.cpp'), true);
    assert.equal(isTestSource('test/a.h'), true);
    assert.equal(isTestSource('handler/expire_at.h'), false);
    assert.equal(isTestSource('CMakeLists.txt'), false);
  });
});

describe('reviewer verdict parsing', () => {
  const line = (id: string, body: unknown) => `REVIEW_VERDICT ${id} ${JSON.stringify(body)}`;

  it('uses the last verdict line and binds the review id', () => {
    const text = `${line('r1', { outcome: 'rejected', reasons: ['x'], artifactRevision: REV })}\nsecond thoughts\n${line('r1', { outcome: 'passed', reasons: ['ok'], artifactRevision: REV })}`;
    const parsed = parseReviewerOutcome(text, 'r1');
    assert.equal(parsed.ok && parsed.verdict.outcome, 'passed');
    assert.equal(parseReviewerOutcome(text, 'r2').ok, false);
  });

  it('rejects prose, malformed JSON, extra fields, and empty reasons', () => {
    assert.equal(parseReviewerOutcome('approved', 'r1').ok, false);
    assert.equal(parseReviewerOutcome('REVIEW_VERDICT r1 {oops}', 'r1').ok, false);
    assert.equal(parseReviewerOutcome(line('r1', { outcome: 'passed', reasons: ['ok'], artifactRevision: REV, approvedBy: 'me' }), 'r1').ok, false);
    assert.equal(parseReviewerOutcome(line('r1', { outcome: 'passed', reasons: [], artifactRevision: REV }), 'r1').ok, false);
    assert.equal(parseReviewerOutcome(line('r1', { outcome: 'maybe', reasons: ['?'], artifactRevision: REV }), 'r1').ok, false);
  });

  it('renders worker briefs with scope, host-run verification, and no-push rules', () => {
    const brief = renderWorkerBrief({ contract: { id: 'T1', objective: 'obj', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['a'], verification: ['make test'], retry: { max_attempts: 1 } }, attemptId: 'T1:attempt-1', workspacePath: '/w/t1', branch: 'orchestrator/t1', baseRevision: REV, feedback: ['fix x'] });
    assert.match(brief, /- src\//);
    assert.match(brief, /- make test/);
    assert.match(brief, /Never push/);
    assert.match(brief, /fix x/);
  });
});

describe('orchestration config', () => {
  const base = { version: 1, repoRoot: '/repo', workspaceRoot: '/work/trees', verificationAllowlist: ['make test'], reviewerRole: 'reviewer-readonly' };

  it('applies defaults', () => {
    const config = parseOrchestrationConfig(base);
    assert.equal(config.maxChecksPerAttempt, 5);
    assert.equal(config.defaultMaxAttempts, 3);
    assert.equal(config.verificationTimeoutMs, 600_000);
  });

  it('fails closed on unknown fields, credentials, relative paths, nested workspaces, and empty allowlists', () => {
    assert.throws(() => parseOrchestrationConfig({ ...base, extra: 1 }), /unknown fields/);
    assert.throws(() => parseOrchestrationConfig({ ...base, token: 'x' }), /credentials/);
    assert.throws(() => parseOrchestrationConfig({ ...base, repoRoot: 'repo' }), /absolute/);
    assert.throws(() => parseOrchestrationConfig({ ...base, workspaceRoot: '/repo/trees' }), /outside/);
    assert.throws(() => parseOrchestrationConfig({ ...base, workspaceRoot: '/repo' }), /outside/);
    assert.throws(() => parseOrchestrationConfig({ ...base, verificationAllowlist: [] }), /verificationAllowlist/);
    assert.throws(() => parseOrchestrationConfig({ ...base, reviewerRole: '../x' }), /role name/);
    assert.throws(() => parseOrchestrationConfig({ ...base, workspaceRoot: '/home/alice/Projects/.agent-orchestrator-workspaces/tinywebserver-main' }), /too long for Pier subagents/);
  });

  it('names compact worktrees short enough for Pier pipes', () => {
    const manager = new WorktreeManager({ repoRoot: '/repo', workspaceRoot: '/home/alice/Projects/.aow/tws', idSource: () => 'c7c6100c-a39c-4c2b-a2fc-55c88ce8aaaa', naming: 'compact' });
    const created: Record<string, unknown>[] = [];
    const port = {
      create: (request: { workspacePath: string; branch: string; ownershipToken: string; baseRevision: string }) => { created.push(request); return { workspacePath: request.workspacePath, branch: request.branch, ownershipToken: request.ownershipToken, managedMarker: `agent-orchestrator:s8:${request.ownershipToken}`, baseRevision: request.baseRevision }; },
      bindSession: () => ({}), inspectChangedPaths: () => ({}), verifyOwnership: () => ({}), remove: () => undefined,
    };
    const lease = manager.acquire(port, 'Tapi-tests', 'Tapi-tests:attempt-2', REV);
    assert.match(lease.workspacePath, /^\/home\/alice\/Projects\/\.aow\/tws\/tapi-tests-a2-[0-9a-z]+$/);
    assert.match(lease.branch, /^ao\/tapi-tests-a2-/);
    assert.equal(pierPipeProblem(lease.workspacePath), undefined);
    assert.throws(() => new WorktreeManager({ repoRoot: '/repo', workspaceRoot: '/w', idSource: () => 'x', naming: 'short' as 'compact' }), /naming/);
  });
});

describe('Pier ledger reader', () => {
  it('reads the latest row for a pane launched in the exact cwd, across both encodings', () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-ledger-'));
    try {
      const cwd = '/work/trees/t1';
      const dir = join(root, pierSessionDirName(cwd));
      mkdirSync(dir, { recursive: true });
      const row = (status: string, extra: Record<string, unknown> = {}) => JSON.stringify({ taskId: 'x', kind: 'worker-a', paneId: 'w1:p1', cwd, status, createdAt: 5, launchCommand: [], ...extra });
      writeFileSync(join(dir, 'history.jsonl'), [row('running'), 'not json', row('settled', { outcome: 'done' }), JSON.stringify({ taskId: 'y', paneId: 'w1:p1', cwd: '/elsewhere', status: 'running', createdAt: 9 })].join('\n'));
      const ledger = new PierHistoryLedger({ roots: [root] });
      const latest = ledger.latest(cwd, 'w1:p1');
      assert.equal(latest?.status, 'settled');
      assert.equal(latest?.outcome, 'done');
      assert.equal(ledger.latest(cwd, 'w1:p2'), undefined);
      assert.equal(ledger.latest('/other', 'w1:p1'), undefined);

      const legacyCwd = '/legacy/tree';
      mkdirSync(join(root, pierSessionDirNameLegacy(legacyCwd)), { recursive: true });
      writeFileSync(join(root, pierSessionDirNameLegacy(legacyCwd), 'history.jsonl'), JSON.stringify({ taskId: 'z', paneId: 'w1:p3', cwd: legacyCwd, status: 'consumed', createdAt: 1, revivedFrom: 'w1:p0' }));
      assert.equal(ledger.latest(legacyCwd, 'w1:p3')?.revivedFrom, 'w1:p0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('computes Pier pipe socket paths and rejects cwds that overflow the Unix socket limit', () => {
    assert.equal(pierPipePath('/a/b', 'w1V:p7'), '/tmp/pi-herdr---%2Fa%2Fb---w1V-p7.sock');
    const failedRun = '/home/alice/Projects/.agent-orchestrator-workspaces/tinywebserver-main/t1-11q2r92--t1-attempt-1-1vrrxk3--c7c6100c-a39c-4c2b-a2fc-55c88ce8-3ir7iz-12fcubq';
    assert.match(pierPipeProblem(failedRun) ?? '', /pipe socket path/);
    assert.equal(pierPipeProblem('/home/alice/Projects/.aow/tws/t1-a1-1k2j3h4'), undefined);
  });

  it('matches Pier storage-layout encodings', () => {
    assert.equal(pierSessionDirName('/home/u/a-b:c'), '--%2Fhome%2Fu%2Fa-b%3Ac--');
    assert.equal(pierSessionDirNameLegacy('/home/u/a-b:c'), '---home-u-a-b-c--');
  });
});

describe('read-only reviewer role check', () => {
  it('requires explicit deny rules for every mutating tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-roles-'));
    try {
      const write = (name: string, manifest: unknown) => writeFileSync(join(root, `${name}.json`), JSON.stringify({ role: name, version: '1.0.0', manifest }));
      const deny = { edit: 'deny', write: 'deny', bash: 'deny', pwsh: 'deny', subagent: 'deny', terminal: 'deny', '*': 'allow' };
      write('reviewer-ok', { unknownTools: 'deny', tools: ['read', 'grep'], rules: deny });
      write('reviewer-bash', { tools: ['read', 'bash'], rules: deny });
      write('reviewer-open', { tools: ['read'], rules: { ...deny, bash: 'allow' } });
      assert.equal(checkReadOnlyRole([root], 'reviewer-ok').ok, true);
      assert.match(JSON.stringify(checkReadOnlyRole([root], 'reviewer-bash')), /grants mutating tools: bash/);
      assert.match(JSON.stringify(checkReadOnlyRole([root], 'reviewer-open')), /explicitly deny: bash/);
      assert.match(JSON.stringify(checkReadOnlyRole([root], 'missing')), /not found/);
      assert.match(JSON.stringify(checkReadOnlyRole([root], 'master')), /reserved/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GitCleanRoom', () => {
  it('rejects non-object-id revisions before touching git', () => {
    const calls: unknown[] = [];
    const room = new GitCleanRoom({ repoRoot: '/repo', root: '/tmp/unused', commandRunner: { run: (spec: unknown) => { calls.push(spec); throw new Error('no'); }, runAsync: () => { throw new Error('no'); } } });
    assert.throws(() => room.prepare('HEAD'), /full object id/);
    assert.throws(() => room.prepare('abc123'), /full object id/);
    assert.equal(calls.length, 0);
  });
});

describe('session evidence reader', () => {
  it('returns task events on the current branch only', () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-session-'));
    try {
      const event = (id: string, parentId: string | null, taskId: string) => JSON.stringify({ type: 'custom', id, parentId, customType: TASK_EVENT_CUSTOM_TYPE, data: { v: 1, type: 'cancel', at: 1, taskId, reason: 'x' } });
      const file = join(root, 's.jsonl');
      writeFileSync(file, [JSON.stringify({ type: 'session', id: 'root' }), event('a', null, 'Tkeep1'), event('b', 'a', 'Tabandoned'), event('c', 'a', 'Tkeep2'), JSON.stringify({ type: 'message', id: 'd', parentId: 'c' })].join('\n'));
      assert.deepEqual(readSessionFileEvents(file).map((entry) => (entry as { taskId: string }).taskId), ['Tkeep1', 'Tkeep2']);
      assert.throws(() => readSessionFileEvents(join(root, 'notes.txt')), /\.jsonl/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('task board replay', () => {
  it('rejects events that do not follow the state machine', () => {
    const contract = { id: 'T1', objective: 'o', depends_on: [], files_in_scope: ['src/'], acceptance_criteria: ['a'], verification: ['make'], retry: { max_attempts: 1 } };
    const plan: TaskEvent = { v: 1, type: 'plan', at: 1, tasks: [{ contract, reviewRequired: true }] };
    const verdict: TaskEvent = { v: 1, type: 'verdict', at: 2, taskId: 'T1', attemptId: 'T1:attempt-1', verdict: 'passed', source: 'review', reasons: ['x'] };
    assert.throws(() => replayTaskBoard([plan, verdict]), TaskBoardError);
    assert.throws(() => replayTaskBoard([plan, plan]), /already exists/);
    assert.equal(replayTaskBoard([plan]).task('T1')?.state, 'READY');
  });
});

describe('pi extension', () => {
  function fakePi() {
    const tools = new Map<string, PiToolDefinition>();
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const entries: { customType: string; data: unknown }[] = [];
    return {
      tools,
      handlers,
      entries,
      api: {
        registerTool: (definition: PiToolDefinition) => { tools.set(definition.name, definition); },
        appendEntry: (customType: string, data?: unknown) => { entries.push({ customType, data }); },
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(event, handler); },
      },
    };
  }

  it('registers the task tools and fails closed when the service cannot be built', async () => {
    const pi = fakePi();
    createAgentOrchestratorExtension({ createService: () => { throw new Error('orchestration config not found'); } })(pi.api);
    assert.deepEqual([...pi.tools.keys()].sort(), ['task_abandon', 'task_bind', 'task_integrate', 'task_plan', 'task_review_brief', 'task_review_record', 'task_start', 'task_status', 'task_verify']);
    pi.handlers.get('session_start')!({}, { sessionManager: { getBranch: () => [] } });
    await assert.rejects(pi.tools.get('task_status')!.execute('c1', {}, undefined, undefined, {}), /unavailable: orchestration config not found/);
  });

  it('restores from this branch\'s custom entries and maps service errors to tool errors', async () => {
    const pi = fakePi();
    const restored: TaskEvent[][] = [];
    const fake = {
      restore(events: TaskEvent[]) { restored.push(events); return { tasks: 0, leaseErrors: [] }; },
      status: () => [],
      readySet: () => [],
      deliverable: () => ({ reason: 'no tasks planned', notIncluded: [] }),
      start() { throw new TaskServiceError('NOT_READY', 'T1 is PENDING'); },
    } as unknown as TaskService;
    createAgentOrchestratorExtension({ createService: () => fake })(pi.api);
    const event = { v: 1, type: 'cancel', at: 1, taskId: 'T1', reason: 'x' };
    pi.handlers.get('session_start')!({}, { sessionManager: { getBranch: () => [{ type: 'custom', customType: TASK_EVENT_CUSTOM_TYPE, data: event }, { type: 'custom', customType: 'pi-herdr.todo-edit', data: {} }, { type: 'message' }] } });
    assert.deepEqual(restored, [[event]]);
    const status = await pi.tools.get('task_status')!.execute('c1', {}, undefined, undefined, {});
    assert.match(status.content[0]!.text, /No tasks planned/);
    assert.match(status.content[0]!.text, /DELIVERABLE: none \(no tasks planned\)/);
    await assert.rejects(pi.tools.get('task_start')!.execute('c2', { task_id: 'T1' }, undefined, undefined, {}), /NOT_READY: T1 is PENDING/);
  });

  describe('git write guard on the main agent\'s bash', () => {
    function withBoard(taskCount: number, roots?: readonly string[]) {
      const pi = fakePi();
      const fake = {
        restore: () => ({ tasks: taskCount, leaseErrors: [] }),
        status: () => Array.from({ length: taskCount }, (_, index) => ({ id: `T${index + 1}` })),
      } as unknown as TaskService;
      createAgentOrchestratorExtension({ createService: () => fake, ...(roots === undefined ? {} : { gitGuardRoots: () => roots }) })(pi.api);
      pi.handlers.get('session_start')!({}, { sessionManager: { getBranch: () => [] } });
      return (command: unknown, toolName = 'bash', cwd = '/repo') => pi.handlers.get('tool_call')!({ toolName, input: { command } }, { cwd }) as { block: true; reason: string } | undefined;
    }

    it('lets the main agent commit its own small work while the board is empty', () => {
      assert.equal(withBoard(0, ['/repo', '/ws'])('git commit -am fix'), undefined);
    });

    it('blocks git writes in the repository and task worktrees once a task is planned', () => {
      const call = withBoard(2, ['/repo', '/ws']);
      const blocked = call('git cherry-pick abc && git commit -m integrate');
      assert.equal(blocked?.block, true);
      assert.match(blocked!.reason, /^GIT_WRITE_BLOCKED: the task board has 2 task\(s\)/);
      assert.match(blocked!.reason, /`git cherry-pick abc` in \/repo; `git commit -m integrate` in \/repo/);
      assert.match(blocked!.reason, /DELIVERABLE revision from task_status/);
      assert.equal(call('git -C /ws/T1-a1 commit -am x')?.block, true);
      assert.equal(call('cd "$W" && git merge x')?.block, true, 'unresolvable directories fail closed');
    });

    it('allows reads, other tools, and writes outside the protected roots', () => {
      const call = withBoard(1, ['/repo', '/ws']);
      assert.equal(call('git log --oneline && git diff HEAD~1'), undefined);
      assert.equal(call('cd /tmp/scratch && git init && git commit -m x'), undefined);
      assert.equal(call('git commit -m x', 'read'), undefined);
      assert.equal(call(undefined), undefined);
    });

    it('protects every directory when no roots are known', () => {
      assert.equal(withBoard(1)('cd /tmp/scratch && git commit -m x')?.block, true);
    });

    it('compares canonical paths, so a symlinked cwd cannot slip past a root', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ao-guard-'));
      try {
        mkdirSync(join(dir, 'repo'));
        symlinkSync(join(dir, 'repo'), join(dir, 'link'));
        assert.match(gitWriteBlockReason('git commit -m x', join(dir, 'link'), 1, [join(dir, 'repo')]) ?? '', /GIT_WRITE_BLOCKED/);
        assert.match(gitWriteBlockReason('git -C ../link push', join(dir, 'repo'), 1, [join(dir, 'repo')]) ?? '', /GIT_WRITE_BLOCKED/);
        assert.equal(gitWriteBlockReason('git commit -m x', dir, 1, [join(dir, 'repo')]), undefined);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
