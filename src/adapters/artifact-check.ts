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

export interface FileLineChanges {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Added and removed lines per file of a unified diff (`git diff -U0` or
 * `git show -U0`), in diff order. Renames are keyed by the new path.
 */
export function lineChangesByPath(unifiedDiff: string): ReadonlyMap<string, FileLineChanges> {
  const byPath = new Map<string, { added: string[]; removed: string[] }>();
  let oldPath: string | undefined;
  let path: string | undefined;
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('diff --git ')) { oldPath = undefined; path = undefined; continue; }
    if (line.startsWith('--- ')) { const source = line.slice(4).trim(); oldPath = source === '/dev/null' ? undefined : source.replace(/^a\//, ''); continue; }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      path = target === '/dev/null' ? oldPath : target.replace(/^b\//, '');
      if (path !== undefined && !byPath.has(path)) byPath.set(path, { added: [], removed: [] });
      continue;
    }
    if (path === undefined || line.startsWith('@@') || line.startsWith('\\')) continue;
    if (line.startsWith('+')) byPath.get(path)!.added.push(line.slice(1));
    else if (line.startsWith('-')) byPath.get(path)!.removed.push(line.slice(1));
  }
  return byPath;
}

function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of b) {
    const count = counts.get(line) ?? 0;
    if (count === 0) return false;
    counts.set(line, count - 1);
  }
  return true;
}

/**
 * Why a union-merged cherry-pick does not carry exactly its source's changes to
 * a union-merged file, or [] when it does. The pick must remove exactly the
 * source's removed lines, and add no line the source did not add. Git merges a
 * line that both sides added identically (e.g. a separating blank line) into
 * one, so a source-added line may be missing from the pick's own added lines;
 * it is accepted only when the resulting file (`resultLines`) holds that line at
 * least as often as the source added it.
 */
export function unionPickProblems(path: string, source: FileLineChanges | undefined, picked: FileLineChanges | undefined, resultLines: readonly string[] = []): readonly string[] {
  const want = source ?? { added: [], removed: [] };
  const got = picked ?? { added: [], removed: [] };
  const problems: string[] = [];
  const count = (lines: readonly string[]) => { const map = new Map<string, number>(); for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1); return map; };
  const wantAdded = count(want.added);
  const gotAdded = count(got.added);
  const extra = [...gotAdded].filter(([line, n]) => n > (wantAdded.get(line) ?? 0)).map(([line]) => line);
  if (extra.length > 0) problems.push(`${path}: the picked commit adds line(s) its source does not add: ${extra.slice(0, 3).map((line) => JSON.stringify(line)).join(', ')}`);
  const inResult = count(resultLines);
  const missing = [...wantAdded].filter(([line, n]) => n > (gotAdded.get(line) ?? 0) && (inResult.get(line) ?? 0) < n).map(([line]) => line);
  if (missing.length > 0) problems.push(`${path}: line(s) the source adds are not in the merged file: ${missing.slice(0, 3).map((line) => JSON.stringify(line)).join(', ')}`);
  if (!sameMultiset(want.removed, got.removed)) problems.push(`${path}: the picked commit removes ${got.removed.length} line(s) where its source removes ${want.removed.length}, or different lines`);
  return problems;
}
