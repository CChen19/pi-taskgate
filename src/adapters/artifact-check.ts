/**
 * Pure acceptance gate over a host-observed worktree inspection.
 *
 * The inspection must come from the host (git), never from a worker claim.
 * A candidate artifact is eligible for verification only when it is committed,
 * clean, ahead of its base, and every changed path is inside `files_in_scope`.
 */
import { deepFreeze } from '../core/validate.ts';
import { validateChangedPaths } from '../core/scope.ts';
import type { WorkspaceInspection } from './worktree-manager.ts';

export type ArtifactCheckFailure = 'DIRTY_WORKTREE' | 'NO_COMMITS' | 'SCOPE_VIOLATION' | 'INVALID_SCOPE';

export interface ArtifactCheck {
  readonly ok: boolean;
  readonly artifactRevision: string;
  readonly changedPaths: readonly string[];
  readonly failures: readonly ArtifactCheckFailure[];
  readonly reasons: readonly string[];
  readonly violations: readonly string[];
}

export function checkArtifact(inspection: WorkspaceInspection, filesInScope: readonly string[]): ArtifactCheck {
  const failures: ArtifactCheckFailure[] = [];
  const reasons: string[] = [];
  let violations: readonly string[] = [];
  if (inspection.clean !== true) {
    failures.push('DIRTY_WORKTREE');
    reasons.push('worktree has uncommitted changes; commit or discard them');
  }
  if (inspection.commitsAhead === undefined || inspection.commitsAhead < 1) {
    failures.push('NO_COMMITS');
    reasons.push('artifact has no commits ahead of its base revision');
  }
  if (filesInScope.length === 0) {
    failures.push('INVALID_SCOPE');
    reasons.push('task declares no files_in_scope; every change is out of scope');
  } else {
    try {
      const scope = validateChangedPaths(inspection.changedPaths, filesInScope);
      if (!scope.allowed) {
        violations = scope.violations;
        failures.push('SCOPE_VIOLATION');
        reasons.push(`changed paths outside files_in_scope: ${scope.violations.slice(0, 10).join(', ')}${scope.violations.length > 10 ? ', ...' : ''}`);
      }
    } catch (error) {
      failures.push('INVALID_SCOPE');
      reasons.push(`scope validation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  return deepFreeze({
    ok: failures.length === 0,
    artifactRevision: inspection.artifactRevision,
    changedPaths: [...inspection.changedPaths],
    failures,
    reasons,
    violations: [...violations],
  });
}

export interface AddedAssert {
  readonly path: string;
  readonly text: string;
}

const TEST_PATH = /(^|\/)(tests?|testing)\/|(^|\/)test_[^/]*$|_test\.[^/]+$|\.test\.[^/]+$/;
const SOURCE_FILE = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|ipp|inl)$/;
const ASSERT_CALL = /(^|[^A-Za-z0-9_])assert\s*\(/;

/** True for C/C++ test sources, where Release builds (-DNDEBUG) strip assert(). */
export function isTestSource(path: string): boolean {
  return SOURCE_FILE.test(path) && TEST_PATH.test(path);
}

/** Strip // and single-line block comments and string/char literals so prose does not trigger. */
function codeOnly(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/\/\*.*?\*\//g, '')
    .replace(/\/\/.*$/, '');
}

/**
 * Scan a unified diff (`git diff -U0`) for assert( calls on added lines of test
 * sources. Removed and unchanged lines are ignored; static_assert is allowed.
 */
export function findAddedAsserts(unifiedDiff: string): readonly AddedAssert[] {
  const found: AddedAssert[] = [];
  let path: string | undefined;
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      path = target === '/dev/null' ? undefined : target.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git ')) continue;
    if (path === undefined || !isTestSource(path) || !line.startsWith('+')) continue;
    const code = codeOnly(line.slice(1));
    if (ASSERT_CALL.test(code)) found.push({ path, text: line.slice(1).trim().slice(0, 160) });
  }
  return found;
}
